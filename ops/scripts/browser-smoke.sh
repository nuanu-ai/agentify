#!/usr/bin/env bash
set -euo pipefail

command -v npx >/dev/null 2>&1 || {
  echo "npx is required by the Playwright CLI wrapper" >&2
  exit 1
}

WEB_BASE_URL="${WEB_BASE_URL:-http://localhost:3000}"
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
PWCLI="${PWCLI:-$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh}"
[[ -x "$PWCLI" ]] || { echo "Playwright CLI wrapper not found at $PWCLI" >&2; exit 1; }

session="agentify-release-$$"
run_output="$(mktemp /tmp/agentify-playwright-output.XXXXXX)"
trap 'rm -f "$run_output"; "$PWCLI" --session "$session" close >/dev/null 2>&1 || true' EXIT
"$PWCLI" --session "$session" open "$WEB_BASE_URL/owner" >/dev/null

base_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$WEB_BASE_URL")"
scan_path_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1] || ""))' "${BROWSER_SCAN_PATH:-}")"
local_flow_json="$(node -e 'const fs=require("node:fs"); const path=process.argv[1]; process.stdout.write(path ? JSON.stringify(JSON.parse(fs.readFileSync(path,"utf8"))) : "null")' "${BROWSER_LOCAL_FLOW_FILE:-}")"
expect_local_card_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1] === "true"))' "${BROWSER_EXPECT_LOCAL_CARD:-false}")"
expect_browser_observations_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1] === "true"))' "${BROWSER_EXPECT_BROWSER_OBSERVATIONS:-false}")"
axe_path_json="$(node -e 'process.stdout.write(JSON.stringify(require.resolve("axe-core/axe.min.js")))')"

set +e
"$PWCLI" --session "$session" run-code "async (page) => {
  const base = $base_json;
  const scanPath = $scan_path_json;
  const localFlow = $local_flow_json;
  const expectLocalCard = $expect_local_card_json;
  const expectBrowserObservations = $expect_browser_observations_json;
  const axePath = $axe_path_json;
  const routes = ['/owner','/store','/local','/scan/pending','/scanner','/methodology','/privacy','/terms','/data-request','/verification/error'];
  if (scanPath) routes.push(scanPath);
  const widths = [360,390,768,1024,1440];
  const failures = [];
  const consoleErrors = [];
  let expectedContactGate401s = 0;
  const dismissConsentBanner = async targetPage => {
    const banner = targetPage.locator('aside[aria-label=\"Privacy choices\"]');
    if (await banner.isVisible().catch(() => false)) {
      await banner.getByRole('button', { name: 'Essential only' }).click();
    }
  };
  await page.addInitScript(() => {
    window.__agentifyPerf = { lcp: 0, cls: 0, inp: 0 };
    new PerformanceObserver(list => {
      const entries = list.getEntries();
      const latest = entries[entries.length - 1];
      if (latest) window.__agentifyPerf.lcp = latest.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__agentifyPerf.cls += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__agentifyPerf.inp = Math.max(window.__agentifyPerf.inp, entry.duration || 0);
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (message.text().includes('401 (Unauthorized)')) expectedContactGate401s += 1;
    else consoleErrors.push(message.text());
  });
  for (const width of widths) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 1000 });
    for (const route of routes) {
      const response = await page.goto(base + route, { waitUntil: 'networkidle' });
      if (!response || response.status() >= 400) failures.push(route + '@' + width + ': HTTP ' + (response?.status() ?? 'none'));
      const dimensions = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
      if (dimensions.scroll !== dimensions.viewport) failures.push(route + '@' + width + ': overflow ' + dimensions.scroll);
      const brandMark = page.locator('svg[data-agentify-mark="standard"]').first();
      if (await brandMark.count() !== 1) failures.push(route + '@' + width + ': Agentify read-frame mark missing');
      else {
        const markBox = await brandMark.boundingBox();
        if (!markBox || markBox.width < 24 || markBox.height < 24) failures.push(route + '@' + width + ': logo below the 24px minimum');
      }
      if (width <= 390 && ['/owner','/store','/local'].includes(route)) {
        const button = page.locator('main form button').first();
        if (await button.count() !== 1) failures.push(route + '@' + width + ': primary CTA missing');
        else {
          const box = await button.boundingBox();
          if (!box || box.y + box.height > 844) failures.push(route + '@' + width + ': primary CTA below fold');
        }
      }
      if (width === 390 || width === 1440) {
        await page.addScriptTag({ path: axePath });
        const violations = await page.evaluate(async () => (await window.axe.run(document)).violations.map(item => item.id + ': ' + item.nodes.slice(0, 3).map(node => node.target.join(' ')).join(', ')));
        if (violations.length) failures.push(route + '@' + width + ': axe ' + violations.join(','));
      }
      if (width === 390) {
        await page.waitForTimeout(250);
        const perf = await page.evaluate(() => window.__agentifyPerf);
        if (perf.lcp > 2500) failures.push(route + ': LCP ' + perf.lcp.toFixed(1) + 'ms');
        if (perf.cls >= 0.1) failures.push(route + ': CLS ' + perf.cls.toFixed(3));
        if (perf.inp > 200) failures.push(route + ': INP ' + perf.inp.toFixed(1) + 'ms');
      }
    }
  }
  const externalFonts = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(name => name.includes('fonts.googleapis.com') || name.includes('fonts.gstatic.com')));
  if (externalFonts.length) failures.push('external Google font requests detected');

  const faviconHref = await page.locator('link[rel="icon"]').first().getAttribute('href');
  if (!faviconHref) failures.push('metadata favicon is missing');
  else {
    const faviconUrl = faviconHref.startsWith('http') ? faviconHref : base + (faviconHref.startsWith('/') ? '' : '/') + faviconHref;
    const favicon = await page.request.get(faviconUrl);
    if (favicon.status() !== 200 || !favicon.headers()['content-type']?.includes('image/svg+xml')) failures.push('metadata favicon is unavailable');
    else if (!(await favicon.text()).includes('M50 40 H40 A6 6 0 0 0 34 46')) failures.push('metadata favicon is not the read-frame mark');
  }
  const genericOg = await page.request.get(base + '/opengraph-image');
  if (genericOg.status() !== 200 || genericOg.headers()['content-type'] !== 'image/png') failures.push('generic Agentify Open Graph image failed');
  const missingAuditPage = await page.context().newPage();
  const missingPage = await missingAuditPage.goto(base + '/__agentify_missing_page__', { waitUntil: 'networkidle' });
  if (!missingPage || missingPage.status() !== 404 || await missingAuditPage.locator('svg[data-agentify-mark="standard"]').count() < 1) failures.push('branded 404 page failed');
  await missingAuditPage.close();

  const fakeScan = '018f3f56-2ec8-7b16-8f66-5b8f93f3251f';
  const unauthorizedReport = await page.request.get(base + '/api/v1/reports/' + fakeScan);
  if (unauthorizedReport.status() !== 404) failures.push('anonymous full report did not return 404');

  if (localFlow) {
    await page.goto(base + '/owner', { waitUntil: 'networkidle' });
    await page.evaluate(() => localStorage.removeItem('agentify.consent.current.v1'));
    await page.reload({ waitUntil: 'networkidle' });
    const consentDialog = page.getByRole('dialog', { name: 'Privacy choices' });
    for (let attempt = 0; attempt < 3 && !await consentDialog.isVisible(); attempt += 1) {
      const preferencesButton = page.getByRole('button', { name: 'Preferences' });
      if (await preferencesButton.isVisible()) await preferencesButton.click();
      else await page.getByRole('button', { name: 'Privacy choices' }).click();
      await consentDialog.waitFor({ timeout: 1500 }).catch(() => undefined);
    }
    await consentDialog.waitFor();
    await consentDialog.getByLabel('Product analytics').check();
    await consentDialog.getByRole('button', { name: 'Save choices' }).click();
    await page.goto(localFlow.scanUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1, name: 'Callable-ready' }).waitFor();
    await page.addScriptTag({ path: axePath });
    const privateScanViolations = await page.evaluate(async () => (await window.axe.run(document)).violations.map(item => item.id + ': ' + item.nodes.slice(0, 3).map(node => node.target.join(' ')).join(', ')));
    if (privateScanViolations.length) failures.push('private scan axe ' + privateScanViolations.join(','));
    if (expectBrowserObservations) {
      await page.getByText('Browser observations', { exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Passive browser observations complete' }).waitFor();
    }
    const shareHeading = page.getByRole('heading', { name: 'Share this research' });
    const promptButton = page.getByRole('button', { name: 'Copy AI fix prompt' });
    if (await shareHeading.count() !== 1 || await promptButton.count() !== 1) failures.push('share-first or prompt action missing');
    else {
      const shareBox = await shareHeading.boundingBox();
      const promptBox = await promptButton.boundingBox();
      if (!shareBox || !promptBox || shareBox.y >= promptBox.y) failures.push('share action is not before prompt action');
    }
    await promptButton.click();
    const contactDialog = page.getByRole('dialog', { name: 'Confirm where to send access' });
    await contactDialog.waitFor();
    await contactDialog.getByRole('textbox', { name: 'Email' }).fill(localFlow.email);
    await contactDialog.getByRole('textbox', { name: 'Phone' }).fill('+1 415 555 0123');
    const marketing = contactDialog.getByRole('checkbox', { name: 'Send optional product research updates.' });
    if (await marketing.isChecked()) failures.push('marketing consent was preselected');
    await contactDialog.getByRole('button', { name: 'Close registration' }).click();
    await page.context().addCookies([{ name: 'agentify_report_session', value: localFlow.reportSessionToken, url: base }]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const teaserPromptResponse = page.waitForResponse(response => response.url().includes('/remediation-prompt?scope=teaser'));
    await page.getByRole('button', { name: 'Copy AI fix prompt' }).click();
    if ((await teaserPromptResponse).status() !== 200) failures.push('verified teaser prompt API failed');
    const teaserDownloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download .md' }).click();
    if ((await teaserDownloadPromise).suggestedFilename() !== 'agentify-visible-findings-prompt.md') failures.push('teaser remediation markdown filename is incorrect');
    await page.goto(localFlow.reportUrl, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ path: axePath });
    const privateReportViolations = await page.evaluate(async () => (await window.axe.run(document)).violations.map(item => item.id + ': ' + item.nodes.slice(0, 3).map(node => node.target.join(' ')).join(', ')));
    if (privateReportViolations.length) failures.push('private report axe ' + privateReportViolations.join(','));
    const canonicalChecks = page.locator('section').filter({ has: page.getByRole('heading', { name: 'All 18 checks' }) }).locator('details');
    if (await canonicalChecks.count() !== 18) failures.push('verified report does not contain 18 canonical checks');
    const intentResponse = page.waitForResponse(response => response.url().includes('/waitlist/') && response.url().endsWith('/answer'));
    await page.getByRole('button', { name: 'Fix it with AI' }).click();
    if ((await intentResponse).status() !== 200) failures.push('post-registration intent API failed');
    await page.getByText('Saved. Your report and tools stay available on this page.', { exact: true }).waitFor();
    const promptResponse = page.waitForResponse(response => response.url().includes('/remediation-prompt?scope=full'));
    await page.getByRole('button', { name: 'Copy AI fix prompt' }).click();
    if ((await promptResponse).status() !== 200) failures.push('full remediation prompt API failed');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download .md' }).click();
    const download = await downloadPromise;
    if (download.suggestedFilename() !== 'agentify-complete-implementation-prompt.md') failures.push('remediation markdown filename is incorrect');
    if (expectBrowserObservations) {
      const browserPanel = page.locator('section').filter({ has: page.getByText('Browser observations', { exact: true }) });
      await browserPanel.getByRole('heading', { name: 'Passive browser observations complete' }).waitFor();
      if (await browserPanel.locator(':scope details').count() !== 14) failures.push('verified report does not contain 14 browser observations');
      await browserPanel.getByRole('button', { name: 'Copy this fix' }).first().click();
    }
    const cardPanel = page.locator('#card-signal');
    if (expectLocalCard && await cardPanel.count() !== 1) failures.push('card signal missing from verified report');
    const preConsentStripe = await page.locator(\"script[src*='js.stripe.com']\").count();
    if (preConsentStripe) failures.push('Stripe SDK loaded before card consent');
    const shareResponsePromise = page.waitForResponse(response => response.url().endsWith('/share') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Copy share link' }).click();
    const shareResponse = await shareResponsePromise;
    const sharePayload = await shareResponse.json().catch(() => null);
    const slug = typeof sharePayload?.slug === 'string' ? sharePayload.slug : null;
    const imageHref = slug ? '/api/v1/shares/' + encodeURIComponent(slug) + '/image' : null;
    if (shareResponse.status() !== 201 || !imageHref || !slug) failures.push('one-click share publish/copy failed');
    const shareStatus = page.locator('[aria-live="polite"]').filter({ hasText: /Public link copied|Clipboard access is unavailable/ });
    await shareStatus.waitFor();
    const shareImageDownloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download image' }).click();
    if (!(await shareImageDownloadPromise).suggestedFilename().endsWith('.png')) failures.push('direct share image download filename is incorrect');
    if (imageHref && slug) {
      const publicPage = await page.request.get(base + '/s/' + slug);
      if (publicPage.status() !== 200) failures.push('published public share is unavailable');
      const publicText = await publicPage.text();
      if (publicText.includes(localFlow.email)) failures.push('public share leaked registration email');
      const image = await page.request.get(base + imageHref);
      if (image.status() !== 200 || image.headers()['content-type'] !== 'image/png') failures.push('public share PNG failed');
      const publicAuditPage = await page.context().newPage();
      publicAuditPage.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      for (const width of widths) {
        await publicAuditPage.setViewportSize({ width, height: width <= 390 ? 844 : 1000 });
        const publicResponse = await publicAuditPage.goto(base + '/s/' + slug, { waitUntil: 'networkidle' });
        if (!publicResponse || publicResponse.status() !== 200) failures.push('public share@' + width + ': HTTP ' + (publicResponse?.status() ?? 'none'));
        const publicDimensions = await publicAuditPage.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
        if (publicDimensions.scroll !== publicDimensions.viewport) failures.push('public share@' + width + ': overflow ' + publicDimensions.scroll);
        if (await publicAuditPage.getByRole('textbox', { name: 'Website URL' }).count() !== 1) failures.push('public share@' + width + ': scan entry missing');
        if (width <= 390) {
          const scanButton = publicAuditPage.getByRole('button', { name: 'Scan →' });
          const privacyButton = publicAuditPage.getByRole('button', { name: 'Privacy choices' });
          if (await scanButton.isVisible() && await privacyButton.isVisible()) {
            const scanBox = await scanButton.boundingBox();
            const privacyBox = await privacyButton.boundingBox();
            if (scanBox && privacyBox) {
              const overlapWidth = Math.max(0, Math.min(scanBox.x + scanBox.width, privacyBox.x + privacyBox.width) - Math.max(scanBox.x, privacyBox.x));
              const overlapHeight = Math.max(0, Math.min(scanBox.y + scanBox.height, privacyBox.y + privacyBox.height) - Math.max(scanBox.y, privacyBox.y));
              if (overlapWidth * overlapHeight > 0) failures.push('public share@' + width + ': privacy control overlaps scan CTA');
            }
          }
        }
        for (const label of ['Invisible','Readable','Callable-ready','Ahead of the market']) {
          if (await publicAuditPage.getByText(label, { exact: true }).count() < 1) failures.push('public share@' + width + ': scale label missing ' + label);
        }
        if (width === 390 || width === 1440) {
          await publicAuditPage.addScriptTag({ path: axePath });
          const publicViolations = await publicAuditPage.evaluate(async () => (await window.axe.run(document)).violations.map(item => item.id + ': ' + item.nodes.slice(0, 3).map(node => node.target.join(' ')).join(', ')));
          if (publicViolations.length) failures.push('public share@' + width + ': axe ' + publicViolations.join(','));
        }
      }
      await publicAuditPage.close();
      await page.getByRole('button', { name: 'Revoke' }).click();
      await page.getByText('Public link revoked.', { exact: true }).waitFor();
      if ((await page.request.get(base + '/s/' + slug)).status() !== 404) failures.push('revoked share remains public');
    }
    if (expectLocalCard) {
      await dismissConsentBanner(page);
      await cardPanel.getByRole('checkbox').check();
      await cardPanel.getByRole('button', { name: 'Continue to secure card form' }).click();
      await cardPanel.getByRole('button', { name: 'Simulate provider confirmation' }).click();
      await cardPanel.getByText('Card saved', { exact: true }).waitFor();
      await dismissConsentBanner(page);
      await cardPanel.getByRole('button', { name: 'Remove card' }).click();
      await cardPanel.getByRole('button', { name: 'Yes, remove card' }).click();
      await cardPanel.getByText('Card removed', { exact: true }).waitFor();
      const republishResponse = page.waitForResponse(response => response.url().endsWith('/share') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Copy share link' }).click();
      if ((await republishResponse).status() !== 201) failures.push('share republish failed before deletion');
      const privateReportUrl = page.url();
      await page.goto(base + '/data-request', { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Delete my data' }).click();
      await page.getByRole('button', { name: 'Confirm deletion' }).click();
      await page.getByText('Deletion completed.', { exact: false }).waitFor();
      await page.goto(privateReportUrl, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Private report access required' }).waitFor();
      await page.waitForTimeout(500);
    }
  }
  if (localFlow && expectedContactGate401s !== 1) failures.push('contact gate did not produce exactly one expected unauthorized preflight');
  if (!localFlow && expectedContactGate401s) failures.push('unexpected unauthorized browser response');
  if (consoleErrors.length) failures.push('console errors: ' + consoleErrors.slice(0, 3).join(' | '));
  if (failures.length) throw new Error(failures.join('\n'));
  return { routes: routes.length, widths, overflow: 0, axe: 0, consoleErrors: 0, localCoreFlow: Boolean(localFlow) };
}" >"$run_output" 2>&1
run_status=$?
set -e

if [[ "$run_status" -ne 0 ]] || grep -q '^### Error' "$run_output"; then
  if grep -q '^### Error' "$run_output"; then
    sed -n '/^### Error/,$p' "$run_output"
  else
    sed -n '1,80p' "$run_output"
  fi \
    | sed -E 's/(access_token=)[^ "&]+/\1[REDACTED]/g; s/local-e2e-access-[^ "&]+/[REDACTED]/g' \
    | sed -n '1,80p' >&2
  echo "Playwright reported a JavaScript error" >&2
  exit 1
fi

echo "Browser, axe, responsive and local performance smoke passed at 360/390/768/1024/1440 for $WEB_BASE_URL."

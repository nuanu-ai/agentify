#!/usr/bin/env bash
set -euo pipefail

# Browser-only regression: every merchant POST is intercepted, never stored or emailed.
WEB_BASE_URL="${WEB_BASE_URL:-http://127.0.0.1:41814}"
PWCLI="${PWCLI:-${CODEX_HOME:-$HOME/.codex}/skills/playwright/scripts/playwright_cli.sh}"
session="agentify-merchant-feedback-$$"
trap '"$PWCLI" --session "$session" close >/dev/null 2>&1 || true' EXIT
"$PWCLI" --session "$session" open "$WEB_BASE_URL/agentic-shop" >/dev/null
"$PWCLI" --session "$session" run-code 'async (page) => {
  const origin = await page.evaluate(() => location.origin);
  let requests = [];
  await page.route("**/api/v1/merchant-applications", async route => {
    requests.push(route.request().headers()["idempotency-key"]);
    const first = requests.length === 1;
    await route.fulfill({
      status: first ? 503 : 202,
      contentType: "application/json",
      body: JSON.stringify(first ? { error: { message: "Controlled test failure. Please retry." } } : { status: "received" }),
    });
  });
  const feedbackInView = async text => {
    await page.waitForFunction(text => {
      const el = document.activeElement;
      if (!el || !el.textContent?.includes(text)) return false;
      const rect = el.getBoundingClientRect();
      return rect.top >= 80 && rect.bottom <= innerHeight;
    }, text, { timeout: 5000 });
  };
  const fillApplication = async form => {
    await form.getByRole("textbox", { name: "Business name", exact: true }).fill("Browser-only regression");
    await form.getByRole("textbox", { name: "Website or business page", exact: true }).fill("https://agentify.ad");
    await form.getByRole("textbox", { name: "Work email", exact: true }).fill("browser-regression@example.invalid");
    await form.getByRole("combobox", { name: "What do you sell?", exact: true }).selectOption("digital");
    await form.getByRole("textbox", { name: "Business country", exact: true }).fill("Indonesia");
    await form.getByRole("checkbox").check();
  };
  const scriptPattern = "**/_next/static/**/*.js";
  await page.route(scriptPattern, route => route.abort());
  await page.goto(origin + "/agentic-shop", { waitUntil: "domcontentloaded" });
  const coldForm = page.getByRole("form", { name: "Merchant application" });
  if (!await coldForm.getByRole("button", { name: "Apply to connect" }).isDisabled()) throw new Error("Unhydrated form can submit");
  if (await coldForm.getAttribute("method") !== "post") throw new Error("Native fallback can expose contacts in URL");
  await fillApplication(coldForm);
  await coldForm.getByRole("textbox", { name: "Work email", exact: true }).press("Enter");
  if (page.url() !== origin + "/agentic-shop" || await coldForm.count() !== 1 || requests.length) throw new Error("Submission escaped the hydration guard");
  await page.unroute(scriptPattern);
  const results = [];
  for (const width of [1440, 390, 360]) {
    requests = [];
    await page.setViewportSize({ width, height: width < 400 ? 844 : 1000 });
    await page.goto(origin + "/agentic-shop", { waitUntil: "domcontentloaded" });
    const form = page.getByRole("form", { name: "Merchant application" });
    const button = form.getByRole("button", { name: "Apply to connect" });
    await button.click();
    if (requests.length) throw new Error("Empty form was submitted");
    await fillApplication(form);
    await button.click();
    await page.getByRole("alert").filter({ hasText: "Controlled test failure" }).waitFor();
    await feedbackInView("Controlled test failure");
    if (await page.getByText("Application received", { exact: true }).count()) throw new Error("False success after failure");
    await button.click();
    await page.getByText("Application received", { exact: true }).waitFor();
    await feedbackInView("Application received");
    if (requests.length !== 2 || !requests[0] || requests[0] !== requests[1]) throw new Error("Retry lost idempotency");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth !== innerWidth);
    if (overflow) throw new Error("Horizontal overflow at " + width);
    results.push({ width, errorFocusedAndVisible: true, successFocusedAndVisible: true, retryKeyPreserved: true });
  }
  return { status: "passed", realApplicationsSubmitted: 0, blockedJsSubmissionPrevented: true, results };
}'

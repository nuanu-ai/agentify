import assert from "node:assert/strict";
import test from "node:test";

import { routeDataOf } from "./route-data-lib.mjs";

/**
 * The script the built scanner wrote into `/scan/runtime-smoke`, started with
 * the production runtime's settings from `web-runtime-image-smoke.mjs`.
 */
const SCAN_PAGE = String.raw`<!DOCTYPE html><html><body><main></main><script>window.__reactRouterContext.streamController.enqueue("[{\"_1\":2,\"_3\":-5,\"_4\":-5},\"loaderData\",{\"_5\":6,\"_7\":8},\"actionData\",\"errors\",\"root\",{\"_20\":21,\"_22\":23},\"routes/scan.id\",{\"_9\":10,\"_11\":12,\"_13\":12,\"_14\":15,\"_16\":15,\"_17\":18,\"_19\":-5},\"scanId\",\"runtime-smoke\",\"browserObservationsEnabled\",false,\"publicShareEnabled\",\"remediationPromptEnabled\",true,\"registrationEnabled\",\"segment\",\"owner\",\"fixture\",\"app\",{\"_38\":39,\"_40\":41,\"_42\":43,\"_44\":45,\"_46\":47,\"_48\":49,\"_50\":15},\"analytics\",{\"_24\":25,\"_26\":27,\"_28\":29},\"runtimeEnvironment\",\"production\",\"posthog\",{\"_34\":35,\"_36\":37,\"_32\":25},\"meta\",{\"_30\":31,\"_32\":33},\"pixelId\",\"meta-production-runtime\",\"destinationEnvironment\",\"preview\",\"key\",\"posthog-production-runtime\",\"host\",\"https://posthog-production-runtime.example.com\",\"displayBrand\",\"Agentify\",\"baseUrl\",\"https://production-runtime.agentify.example\",\"scannerUserAgent\",\"agentify-scanner/1.0 (+https://production-runtime.agentify.example/scanner)\",\"privacyEmail\",\"privacy-production-runtime@example.com\",\"abuseEmail\",\"abuse-production-runtime@example.com\",\"legalOperator\",\"production-runtime legal operator\",\"legalIdentityConfirmed\"]\n");</script></body></html>`;

test("route data reads each value under its own name, though the page writes them apart", () => {
  const data = routeDataOf(SCAN_PAGE);

  assert.equal(data["routes/scan.id"].registrationEnabled, true);
  assert.equal(data["routes/scan.id"].browserObservationsEnabled, false);
  assert.equal(data["routes/scan.id"].fixture, null);
  assert.equal(data.root.analytics.posthog.destinationEnvironment, "production");
  assert.equal(data.root.analytics.meta.destinationEnvironment, "preview");
  assert.equal(data.root.app.legalIdentityConfirmed, true);
});

test("route data is refused on a page that carries none", () => {
  assert.throws(() => routeDataOf("<!DOCTYPE html><html><body></body></html>"), /no route data/);
});

test("route data refuses a value it does not read rather than guessing at it", () => {
  const dated = String.raw`<script>window.__reactRouterContext.streamController.enqueue("[{\"_1\":2},\"loaderData\",{\"_3\":4},\"root\",[\"D\",0]]\n");</script>`;

  assert.throws(() => routeDataOf(dated), /kind "D"/);
});

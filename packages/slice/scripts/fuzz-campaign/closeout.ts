/** Bounded functional readback and cleanup of the two campaign merchants on TEST. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const base = "https://test.agentify.ad";
const fixtures = ["sdk", "woo"].map((name) => ({
  name,
  ...JSON.parse(
    readFileSync(
      new URL(`../../../../.local/fuzz-campaign/${name}-merchant.json`, import.meta.url),
      "utf8",
    ),
  ),
}));
const observations: unknown[] = [];
let calls = 0;
async function call(path: string, key?: string, method = "GET", body?: string) {
  assert(++calls <= 40);
  await new Promise((r) => setTimeout(r, 220));
  const r = await fetch(base + path, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body,
  });
  const data = await r.json();
  return { http: r.status, data };
}
for (const fixture of fixtures) {
  const before = await call("/v0/cards", fixture.apiKey);
  assert.equal(before.http, 200);
  assert(before.data.cards.length > 0);
  const anon = await call("/v0/cards");
  assert.equal(anon.http, 401);
  const invalid = await call("/v0/cards", "fuzz-campaign-invalid");
  assert.equal(invalid.http, 401);
  const other = fixtures.find((f) => f.name !== fixture.name);
  assert(other);
  const foreign = await call(`/v0/cards/${before.data.cards[0].id}/pause`, other.apiKey, "POST");
  assert([403, 404].includes(foreign.http));
  const malformed = await call("/v0/catalog/publish", fixture.apiKey, "POST", "{");
  assert.equal(malformed.http, 400);
  const after = await call("/v0/cards", fixture.apiKey);
  assert.deepEqual(after, before);
  observations.push({
    merchant: fixture.name,
    checks: {
      anonymous: anon.http,
      invalidKey: invalid.http,
      otherMerchantPause: foreign.http,
      malformedJson: malformed.http,
      unchangedCatalog: true,
    },
  });
  const paused = await call("/v0/selling/pause", fixture.apiKey, "POST");
  assert.equal(paused.http, 200);
  const again = await call("/v0/selling/pause", fixture.apiKey, "POST");
  assert.deepEqual(again, paused);
  const readback = await call("/v0/cards", fixture.apiKey);
  assert.deepEqual(readback, paused);
  observations.push({
    merchant: fixture.name,
    cleanup: { sellingPaused: true, repeatedPauseIdempotent: true, readbackMatches: true },
  });
}
// The public key API deliberately refuses self-revocation. Cleanup uses the owner session path afterward.
for (const fixture of fixtures) {
  const refused = await call(`/v0/keys/${fixture.keyId}/disable`, fixture.apiKey, "POST");
  assert.equal(refused.http, 409);
  const stillActive = await call("/v0/cards", fixture.apiKey);
  assert.equal(stillActive.http, 200);
  observations.push({
    merchant: fixture.name,
    selfRevocationRefused: 409,
    callingKeyRemainsActive: true,
  });
}
const report = { at: new Date().toISOString(), base, passed: true, calls, observations };
writeFileSync(
  new URL(
    "../../../../docs/research/fuzz-campaign-2026-10-15/closeout-evidence.json",
    import.meta.url,
  ),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report));

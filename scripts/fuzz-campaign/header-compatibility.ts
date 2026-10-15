/** Measures whether an accepted card's discovery response reaches ordinary HTTP clients. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { get, maxHeaderSize } from "node:http";
import { fileURLToPath } from "node:url";
import { harness, serve } from "../../apps/gateway/src/testing/harness.js";

const base = JSON.parse(
  readFileSync(
    new URL("../../apps/docs/examples/card/access-monthly.json", import.meta.url),
    "utf8",
  ),
);
const counts = [1, 32, 64, 128, 256, 512, 1024, 2048];
const observations: Record<string, unknown>[] = [];

async function read(
  url: string,
  headerLimit?: number,
): Promise<{ status?: number; headerBytes?: number; code?: string }> {
  return await new Promise((resolve) => {
    const request = get(
      url,
      { ...(headerLimit === undefined ? {} : { maxHeaderSize: headerLimit }) },
      (response) => {
        const header = response.headers["payment-required"];
        response.resume();
        response.once("end", () =>
          resolve({
            status: response.statusCode,
            headerBytes: typeof header === "string" ? Buffer.byteLength(header) : 0,
          }),
        );
      },
    );
    request.setTimeout(5000, () => request.destroy(new Error("response timeout")));
    request.once("error", (error: NodeJS.ErrnoException) =>
      resolve({ code: error.code ?? error.message }),
    );
  });
}

for (const count of counts) {
  const running = await harness();
  const served = await serve(running);
  try {
    const card = {
      ...base,
      merchant_item_id: `header-${count}`,
      params: Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`field_${i}`, { type: "string" }]),
      ),
    };
    const inputBytes = Buffer.byteLength(JSON.stringify(card));
    assert(inputBytes <= 256 * 1024);
    const published = await served.call("POST", "/v0/catalog/publish", {
      body: card,
      headers: { authorization: `Bearer ${running.merchant.key}` },
    });
    assert.equal(published.status, 200);
    const id = (published.body as { id?: string }).id;
    assert(id, `card was not accepted: ${JSON.stringify(published.body)}`);
    const url = `${served.url}/x402/${encodeURIComponent(id)}/purchase`;
    const observed = await read(url, 1024 * 1024);
    assert.equal(observed.status, 402);
    const ordinary = await read(url);
    const row = {
      caseId: `header-${count}`,
      count,
      inputBytes,
      ...observed,
      ordinary,
      passed: ordinary.status === 402,
    };
    observations.push(row);
    console.log(JSON.stringify(row));
  } finally {
    await served.close();
    await running.stop();
  }
}
const result = {
  subject: "e11fef741e875ef6f9c42465a6b27577dd2921a1",
  node: process.version,
  defaultHeaderLimit: maxHeaderSize,
  cases: observations,
};
writeFileSync(
  fileURLToPath(
    new URL("../../docs/research/fuzz-campaign-2026-10-15/header-evidence.json", import.meta.url),
  ),
  `${JSON.stringify(result, null, 2)}\n`,
);

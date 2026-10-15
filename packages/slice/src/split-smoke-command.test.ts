/**
 * The split smoke run whole, as a person types it, against an RPC on this
 * machine that answers as Base does. Pointed by mistake at a live chain's RPC,
 * the command would pay real USDC into a split and send real transactions; it
 * must refuse at the first answer, before it boots a gateway, writes a journal
 * or signs anything.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";

/** An RPC that answers every request as Base's does to eth_chainId, and counts what it was asked. */
const baseLikeRpc = async (): Promise<{ url: string; asked: string[]; server: Server }> => {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      const calls = [JSON.parse(body)].flat() as { id: number; method: string }[];
      asked.push(...calls.map((call) => call.method));
      const answers = calls.map((call) =>
        call.method === "eth_chainId"
          ? { jsonrpc: "2.0", id: call.id, result: "0x2105" }
          : { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "not here" } },
      );
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? answers : answers[0]));
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, asked, server };
};

const command = (
  environment: Record<string, string>,
  cwd: string,
): Promise<{ readonly code: number | null; readonly printed: string }> =>
  new Promise((resolve, reject) => {
    let printed = "";
    // tsx by its own path, since the command runs in an empty directory where
    // nothing resolves, so the journal it would write lands where it can be seen.
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const running = spawn(
      process.execPath,
      ["--import", tsx, fileURLToPath(new URL("./split-smoke.ts", import.meta.url)), "--confirm"],
      { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 },
    );
    running.stdout.on("data", (chunk) => {
      printed += String(chunk);
    });
    running.stderr.on("data", (chunk) => {
      printed += String(chunk);
    });
    running.once("error", reject);
    running.once("close", (code) => resolve({ code, printed }));
  });

describe("the split smoke pointed at Base's RPC", () => {
  let rpc: Awaited<ReturnType<typeof baseLikeRpc>> | undefined;

  afterEach(() => {
    rpc?.server.close();
  });

  it("refuses at the chain's first answer, asking it nothing more and writing nothing", async () => {
    rpc = await baseLikeRpc();
    const cwd = mkdtempSync(path.join(tmpdir(), "split-smoke-command-"));

    const run = await command(
      {
        PATH: process.env.PATH ?? "",
        AGENTIFY_SMOKE: "1",
        SMOKE_BUYER_KEY: generatePrivateKey(),
        SMOKE_PAYOUT_KEY: generatePrivateKey(),
        BASE_SEPOLIA_RPC_URL: rpc.url,
      },
      cwd,
    );

    expect(run.printed).toMatch(/8453/);
    expect(run.code).toBe(1);
    expect(rpc.asked).toStrictEqual(["eth_chainId"]);
    expect(readdirSync(cwd)).toStrictEqual([]);
  });
});

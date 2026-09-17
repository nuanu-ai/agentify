/**
 * Real-HTTP regression for the shared Caddy route table.
 *
 * Run explicitly because it creates an isolated Docker network and containers:
 *
 *   node ops/scripts/caddy-routing-smoke.mjs
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const CADDY_IMAGE =
  "caddy:2.10.0-alpine@sha256:ae4458638da8e1a91aafffb231c5f8778e964bca650c8a8cb23a7e8ac557aa3c";
const projectRoot = process.cwd();
const sourceCaddyfile = path.join(projectRoot, "deploy/Caddyfile");
const edgeCaddyfile = path.join(projectRoot, "deploy/edge/Caddyfile");
const suffix = `${process.pid}-${Date.now()}`;
const networkName = `agentify-routing-${suffix}`;
const innerName = `agentify-routing-inner-${suffix}`;
const edgeName = `agentify-routing-edge-${suffix}`;
const mutatedName = `agentify-routing-mutated-${suffix}`;
const temporary = mkdtempSync(path.join(os.tmpdir(), "agentify-routing-"));
const upstreams = [];

function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function dockerResult(...args) {
  return spawnSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function ipv4ToInteger(address) {
  return address
    .split(".")
    .map(Number)
    .reduce((value, octet) => value * 256 + octet, 0);
}

function integerToIpv4(value) {
  return [24, 16, 8, 0]
    .map((shift) => Math.floor(value / 2 ** shift) % 256)
    .join(".");
}

function addressesIn(subnet) {
  const [address, prefixText] = subnet.split("/");
  const prefix = Number(prefixText);
  assert.ok(
    prefix <= 28,
    `Docker network ${subnet} is too small for the smoke`,
  );
  const blockSize = 2 ** (32 - prefix);
  const base = Math.floor(ipv4ToInteger(address) / blockSize) * blockSize;
  return {
    edge: integerToIpv4(base + 10),
    inner: integerToIpv4(base + 11),
    mutated: integerToIpv4(base + 12),
  };
}

async function listen(role) {
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        role,
        path: request.url,
        forwardedFor: request.headers["x-forwarded-for"] ?? null,
        forwardedProto: request.headers["x-forwarded-proto"] ?? null,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  upstreams.push(server);
  return server.address().port;
}

async function waitFor(baseUrl) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.status < 500) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (thrown) {
      lastError = thrown;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError;
}

function publishedBase(containerName) {
  const port = docker("port", containerName, "8080/tcp").split(":").pop();
  return `http://127.0.0.1:${port}`;
}

async function expectProxy(baseUrl, requestPath, role) {
  const response = await fetch(`${baseUrl}${requestPath}`);
  assert.equal(response.status, 200, requestPath);
  assert.equal(
    response.headers.get("referrer-policy"),
    "same-origin",
    requestPath,
  );
  const body = await response.json();
  assert.equal(body.role, role, requestPath);
  assert.equal(body.path, requestPath, requestPath);
  return body;
}

async function expectSharedAssets(baseUrl) {
  const expected = new Map([
    ["/assets/agentify-mark.svg", "image/svg+xml"],
    ["/assets/agentify-mark-dark.svg", "image/svg+xml"],
    ["/assets/agentify-mark-heavy.svg", "image/svg+xml"],
    ["/styles/fonts.css", "text/css"],
  ]);
  for (const [requestPath, contentType] of expected) {
    const response = await fetch(`${baseUrl}${requestPath}`);
    assert.equal(response.status, 200, requestPath);
    assert.match(
      response.headers.get("content-type") ?? "",
      new RegExp(`^${contentType.replace("+", "\\+")}(?:;|$)`),
      requestPath,
    );
    assert.ok((await response.arrayBuffer()).byteLength > 0, requestPath);
  }

  const stylesheet = await (await fetch(`${baseUrl}/styles/fonts.css`)).text();
  const fontPaths = [
    ...stylesheet.matchAll(/url\(["']?(\/styles\/fonts\/[^"')]+\.woff2)/g),
  ].map((match) => match[1]);
  assert.equal(fontPaths.length, 7, "the browser font inventory changed");
  for (const fontPath of fontPaths) {
    const response = await fetch(`${baseUrl}${fontPath}`);
    assert.equal(response.status, 200, fontPath);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^font\/woff2(?:;|$)/,
      fontPath,
    );
    assert.ok((await response.arrayBuffer()).byteLength > 0, fontPath);
  }
}

async function expectSingleForwardedClient(baseUrl, spoofed) {
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: { "X-Forwarded-For": spoofed },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.role, "scanner");
  assert.equal(typeof body.forwardedFor, "string");
  assert.ok(body.forwardedFor.length > 0);
  assert.notEqual(body.forwardedFor, spoofed);
  assert.equal(body.forwardedFor.includes(","), false, body.forwardedFor);
}

function runInner({
  configPath,
  containerName,
  ip,
  trustedEdge,
  ports,
  adminHash,
}) {
  docker(
    "run",
    "-d",
    "--name",
    containerName,
    "--network",
    networkName,
    "--ip",
    ip,
    "-p",
    "127.0.0.1::8080",
    "-v",
    `${configPath}:/etc/caddy/Caddyfile:ro`,
    "-v",
    `${path.join(projectRoot, "apps/landing/public")}:/srv/landing:ro`,
    "-v",
    `${path.join(temporary, "docs")}:/srv/docs:ro`,
    "-e",
    "AGENTIFY_FRONT_PAGE=scanner_front_page",
    "-e",
    `AGENTIFY_TRUSTED_EDGE_CIDR=${trustedEdge}/32`,
    "-e",
    `ADMIN_BASIC_AUTH_HASH=${adminHash}`,
    "-e",
    "ADMIN_BASIC_AUTH_USER=acceptance",
    "-e",
    `AGENTIFY_SCANNER_UPSTREAM=host.docker.internal:${ports.scanner}`,
    "-e",
    `AGENTIFY_CABINET_UPSTREAM=host.docker.internal:${ports.cabinet}`,
    "-e",
    `AGENTIFY_GATEWAY_UPSTREAM=host.docker.internal:${ports.gateway}`,
    CADDY_IMAGE,
  );
}

try {
  const docsRoot = path.join(temporary, "docs");
  mkdirSync(path.join(docsRoot, "assets"), { recursive: true });
  writeFileSync(
    path.join(docsRoot, "index.html"),
    "<p>documentation fixture</p>",
  );
  writeFileSync(
    path.join(docsRoot, "guide.html"),
    "<p>documentation guide</p>",
  );
  writeFileSync(
    path.join(docsRoot, "assets/doc.css"),
    "body { color: black; }\n",
  );

  const ports = {
    scanner: await listen("scanner"),
    cabinet: await listen("cabinet"),
    gateway: await listen("gateway"),
  };
  const adminHash = docker(
    "run",
    "--rm",
    CADDY_IMAGE,
    "caddy",
    "hash-password",
    "--plaintext",
    "acceptance-only-not-a-secret",
  );
  const edgeAdapt = dockerResult(
    "run",
    "--rm",
    "-v",
    `${edgeCaddyfile}:/etc/caddy/Caddyfile:ro`,
    CADDY_IMAGE,
    "caddy",
    "adapt",
    "--config",
    "/etc/caddy/Caddyfile",
  );
  assert.equal(edgeAdapt.status, 0, edgeAdapt.stderr);

  docker("network", "create", networkName);
  const subnet = docker(
    "network",
    "inspect",
    "--format",
    "{{(index .IPAM.Config 0).Subnet}}",
    networkName,
  );
  const addresses = addressesIn(subnet);

  const edgeConfig = path.join(temporary, "edge.Caddyfile");
  writeFileSync(
    edgeConfig,
    `:8080 {\n\treverse_proxy ${addresses.inner}:8080\n}\n`,
  );
  docker(
    "run",
    "-d",
    "--name",
    edgeName,
    "--network",
    networkName,
    "--ip",
    addresses.edge,
    "-p",
    "127.0.0.1::8080",
    "-v",
    `${edgeConfig}:/etc/caddy/Caddyfile:ro`,
    CADDY_IMAGE,
  );
  runInner({
    configPath: sourceCaddyfile,
    containerName: innerName,
    ip: addresses.inner,
    trustedEdge: addresses.edge,
    ports,
    adminHash,
  });

  const innerBase = publishedBase(innerName);
  const edgeBase = publishedBase(edgeName);
  await Promise.all([waitFor(innerBase), waitFor(edgeBase)]);

  for (const [requestPath, role] of [
    ["/", "scanner"],
    ["/owner", "scanner"],
    ["/api/health", "scanner"],
    ["/cabinet", "cabinet"],
    ["/cabinet/sign-in", "cabinet"],
    ["/cabinet/healthz", "cabinet"],
    ["/v0", "gateway"],
    ["/v0/cards", "gateway"],
    ["/x402", "gateway"],
    ["/x402/catalog", "gateway"],
    ["/healthz", "gateway"],
    ["/cabinet-other", "scanner"],
    ["/v0-other", "scanner"],
    ["/x402-other", "scanner"],
    ["/assets/scanner-owned.svg", "scanner"],
    ["/styles/scanner-owned.css", "scanner"],
    ["/styles/landing.css", "scanner"],
    ["/styles/fonts/OFL-Schibsted-Grotesk.txt", "scanner"],
  ]) {
    await expectProxy(innerBase, requestPath, role);
  }

  await expectSharedAssets(innerBase);

  let response = await fetch(`${innerBase}/docs`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/docs/");
  response = await fetch(`${innerBase}/docs/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /documentation fixture/);
  response = await fetch(`${innerBase}/docs/guide`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /documentation guide/);
  response = await fetch(`${innerBase}/docs/assets/doc.css`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/css(?:;|$)/);

  for (const [encodedEdge, role] of [
    ["/cabinet%2Fsign-in", "cabinet"],
    ["/v0%2Fcards", "gateway"],
    ["/x402%2Fcatalog", "gateway"],
  ]) {
    await expectProxy(innerBase, encodedEdge, role);
  }
  response = await fetch(`${innerBase}/docs%2Fguide`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /documentation guide/);

  for (const baseUrl of [innerBase, edgeBase]) {
    await expectSingleForwardedClient(baseUrl, "198.51.100.77");
    for (const adminPath of ["/admin", "/admin%2Fusers"]) {
      const admin = await fetch(`${baseUrl}${adminPath}`);
      assert.equal(admin.status, 401, adminPath);
      assert.equal(
        admin.headers.get("referrer-policy"),
        "same-origin",
        adminPath,
      );
    }
  }
  response = await fetch(`${edgeBase}/admin`, {
    headers: {
      Authorization: `Basic ${Buffer.from(
        "acceptance:acceptance-only-not-a-secret",
      ).toString("base64")}`,
    },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).role, "scanner");

  const missingSelector = dockerResult(
    "run",
    "--rm",
    "-v",
    `${sourceCaddyfile}:/etc/caddy/Caddyfile:ro`,
    CADDY_IMAGE,
    "caddy",
    "adapt",
    "--config",
    "/etc/caddy/Caddyfile",
  );
  assert.notEqual(
    missingSelector.status,
    0,
    "missing front-page selector was accepted",
  );
  assert.match(missingSelector.stderr, /AGENTIFY_FRONT_PAGE|import|filename/i);

  const original = readFileSync(sourceCaddyfile, "utf8");
  const mutationNeedle = "\n\timport commerce_shared_assets\n";
  assert.ok(
    original.includes(mutationNeedle),
    "shared-asset import moved without updating the smoke",
  );
  const mutatedConfig = path.join(temporary, "mutated.Caddyfile");
  writeFileSync(mutatedConfig, original.replace(mutationNeedle, "\n"));
  runInner({
    configPath: mutatedConfig,
    containerName: mutatedName,
    ip: addresses.mutated,
    trustedEdge: addresses.edge,
    ports,
    adminHash,
  });
  const mutatedBase = publishedBase(mutatedName);
  await waitFor(mutatedBase);
  await assert.rejects(
    () => expectSharedAssets(mutatedBase),
    /\/assets\/agentify-mark\.svg/,
    "the old scanner fallback unexpectedly passed the shared browser-asset check",
  );

  console.log(
    "PASS: actual Caddy preserves exact commerce/docs/assets/admin routes and one trusted scanner client IP",
  );
} finally {
  for (const container of [mutatedName, innerName, edgeName]) {
    dockerResult("rm", "-f", container);
  }
  dockerResult("network", "rm", networkName);
  for (const server of upstreams) server.close();
  rmSync(temporary, { recursive: true, force: true });
}

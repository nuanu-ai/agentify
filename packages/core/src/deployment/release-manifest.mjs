#!/usr/bin/env node

/**
 * The small hand-off between an off-host build and an operator-controlled
 * release. The manifest names one source commit, the tracked configuration
 * archive made from it, and only digest-addressed images. It contains no
 * delivery instruction: applying it remains a separate Ansible operation.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const REVISION = /^[0-9a-f]{40}$/;
const DIGEST = "sha256:[0-9a-f]{64}";
const ARCHIVE_VALIDATOR = fileURLToPath(new URL("./validate-release-archive.py", import.meta.url));

const FIRST_PARTY = {
  "commerce-app": new RegExp(`^ghcr\\.io/nuanu-ai/agentify-commerce-app@${DIGEST}$`),
  "commerce-web": new RegExp(`^ghcr\\.io/nuanu-ai/agentify-commerce-web@${DIGEST}$`),
  "scanner-web": new RegExp(`^ghcr\\.io/nuanu-ai/agentify-scanner-web@${DIGEST}$`),
  "scanner-worker": new RegExp(`^ghcr\\.io/nuanu-ai/agentify-scanner-worker@${DIGEST}$`),
  "scanner-privacy": new RegExp(`^ghcr\\.io/nuanu-ai/agentify-scanner-privacy@${DIGEST}$`),
};

const INFRASTRUCTURE = {
  postgres: new RegExp(`^docker\\.io/library/postgres@${DIGEST}$`),
  caddy: new RegExp(`^docker\\.io/library/caddy@${DIGEST}$`),
  alpine: new RegExp(`^docker\\.io/library/alpine@${DIGEST}$`),
};

const TOPOLOGY_IMAGES = {
  commerce: {
    postgres: ["infrastructure", "postgres"],
    migrate: ["firstParty", "commerce-app"],
    gateway: ["firstParty", "commerce-app"],
    cabinet: ["firstParty", "commerce-app"],
    web: ["firstParty", "commerce-web"],
  },
  scanner: {
    "roles-reconcile": ["infrastructure", "postgres"],
    migrate: ["firstParty", "scanner-worker"],
    "queue-init": ["firstParty", "scanner-worker"],
    "database-dashboards-install": ["infrastructure", "postgres"],
    "database-access-finalize": ["infrastructure", "postgres"],
    web: ["firstParty", "scanner-web"],
    worker: ["firstParty", "scanner-worker"],
    "privacy-cleanup": ["firstParty", "scanner-privacy"],
    "database-backup": ["infrastructure", "postgres"],
    "database-config-check": ["infrastructure", "alpine"],
    "database-access-verify": ["infrastructure", "postgres"],
  },
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const unknownKeys = (where, value, allowed) => {
  if (!isRecord(value)) return [];
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `unknown ${where} field: ${key}`);
};

const imageProblems = (groupName, value, expected) => {
  if (!isRecord(value)) return [`images.${groupName} must be an object`];

  const problems = [];
  for (const [role, pattern] of Object.entries(expected)) {
    const reference = value[role];
    if (typeof reference !== "string") {
      problems.push(`images.${groupName}.${role} is required`);
    } else if (!pattern.test(reference)) {
      const repository = pattern.source.split("@")[0].replaceAll("\\", "").replace("^", "");
      problems.push(
        `images.${groupName}.${role} must be ${repository}@ followed by a full sha256 digest`,
      );
    }
  }

  for (const role of Object.keys(value)) {
    if (!(role in expected)) problems.push(`unknown ${groupName} image: ${role}`);
  }
  return problems;
};

export const sha256Of = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function problemsWithReleaseManifest(manifest, actualArchiveSha256) {
  if (!isRecord(manifest)) return ["release manifest must be an object"];

  const problems = unknownKeys("manifest", manifest, [
    "schemaVersion",
    "repository",
    "revision",
    "configuration",
    "images",
  ]);
  if (manifest.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  if (manifest.repository !== "nuanu-ai/agentify") {
    problems.push("repository must be nuanu-ai/agentify");
  }

  const revision = manifest.revision;
  if (typeof revision !== "string" || !REVISION.test(revision)) {
    problems.push("revision must be a 40-character lowercase Git SHA");
  }

  const configuration = manifest.configuration;
  if (!isRecord(configuration)) {
    problems.push("configuration must be an object");
  } else {
    problems.push(...unknownKeys("configuration", configuration, ["archive", "sha256"]));
    const expectedArchive =
      typeof revision === "string" && REVISION.test(revision)
        ? `agentify-config-${revision}.tar.gz`
        : undefined;
    if (configuration.archive !== expectedArchive) {
      problems.push(`configuration.archive must be ${expectedArchive ?? "named from revision"}`);
    }
    if (
      typeof configuration.sha256 !== "string" ||
      !new RegExp(`^${DIGEST}$`).test(configuration.sha256)
    ) {
      problems.push("configuration.sha256 must be a full sha256 digest");
    }
    if (actualArchiveSha256 !== undefined && configuration.sha256 !== actualArchiveSha256) {
      problems.push("configuration checksum does not match the archive bytes");
    }
  }

  const images = manifest.images;
  if (!isRecord(images)) {
    problems.push("images must be an object");
  } else {
    problems.push(...unknownKeys("images", images, ["firstParty", "infrastructure"]));
    problems.push(...imageProblems("firstParty", images.firstParty, FIRST_PARTY));
    problems.push(...imageProblems("infrastructure", images.infrastructure, INFRASTRUCTURE));
  }

  return problems;
}

export function createReleaseManifest(input) {
  const archiveBytes = readFileSync(input.archive);
  const manifest = {
    schemaVersion: 1,
    repository: input.repository,
    revision: input.revision,
    configuration: {
      archive: basename(input.archive),
      sha256: sha256Of(archiveBytes),
    },
    images: {
      firstParty: input.firstParty,
      infrastructure: input.infrastructure,
    },
  };
  const problems = problemsWithReleaseManifest(manifest, manifest.configuration.sha256);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return manifest;
}

const commandProblems = (surface, role, testService, productionService) => {
  const problems = [];
  for (const [channel, service] of [
    ["test", testService],
    ["production", productionService],
  ]) {
    const command = service.command;
    if (
      command !== null &&
      command !== undefined &&
      typeof command !== "string" &&
      !(Array.isArray(command) && command.every((part) => typeof part === "string"))
    ) {
      problems.push(`${channel} ${surface}.${role} command must be a string or string array`);
    }
  }
  if (
    JSON.stringify(testService.command ?? null) !==
    JSON.stringify(productionService.command ?? null)
  ) {
    problems.push(`${surface}.${role} command differs between test and production`);
  }
  return problems;
};

export function problemsWithReleaseTopology(testTopology, productionTopology, manifest) {
  const manifestProblems = problemsWithReleaseManifest(manifest);
  if (manifestProblems.length > 0) {
    return manifestProblems.map((problem) => `release manifest: ${problem}`);
  }

  const problems = [];
  for (const [channel, topology] of [
    ["test", testTopology],
    ["production", productionTopology],
  ]) {
    if (!isRecord(topology)) {
      problems.push(`${channel} topology must be an object`);
      continue;
    }
    for (const [surface, roles] of Object.entries(TOPOLOGY_IMAGES)) {
      const services = topology[surface];
      if (!isRecord(services)) {
        problems.push(`${channel} ${surface} services must be an object`);
        continue;
      }
      for (const role of Object.keys(roles)) {
        if (!isRecord(services[role])) {
          problems.push(`${channel} ${surface}.${role} is required`);
        }
      }
      for (const role of Object.keys(services)) {
        if (!(role in roles)) problems.push(`${channel} ${surface} has unknown service ${role}`);
      }
    }
  }

  if (problems.length > 0) return problems;

  for (const [surface, roles] of Object.entries(TOPOLOGY_IMAGES)) {
    for (const [role, [group, imageRole]] of Object.entries(roles)) {
      const expectedImage = manifest.images[group][imageRole];
      const testService = testTopology[surface][role];
      const productionService = productionTopology[surface][role];
      for (const [channel, service] of [
        ["test", testService],
        ["production", productionService],
      ]) {
        if (Object.hasOwn(service, "build")) {
          problems.push(`${channel} ${surface}.${role} carries a build instruction`);
        }
        if (service.image !== expectedImage) {
          problems.push(`${channel} ${surface}.${role} image is not the manifest digest`);
        }
      }
      problems.push(...commandProblems(surface, role, testService, productionService));
    }
  }

  return problems;
}

function fail(problems) {
  console.error("release manifest refused:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(65);
}

if (process.argv[1]?.endsWith("release-manifest.mjs")) {
  const command = process.argv[2];
  if (command === "create" && process.argv.length === 14) {
    const [repository, revision, archive, ...references] = process.argv.slice(3);
    try {
      const manifest = createReleaseManifest({
        repository,
        revision,
        archive,
        firstParty: Object.fromEntries(
          Object.keys(FIRST_PARTY).map((role, index) => [role, references[index]]),
        ),
        infrastructure: Object.fromEntries(
          Object.keys(INFRASTRUCTURE).map((role, index) => [role, references[index + 5]]),
        ),
      });
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    } catch (error) {
      fail([error instanceof Error ? error.message : String(error)]);
    }
  } else if (command === "verify" && process.argv.length === 5) {
    try {
      const manifest = JSON.parse(readFileSync(process.argv[3], "utf8"));
      const archiveSha256 = sha256Of(readFileSync(process.argv[4]));
      const problems = problemsWithReleaseManifest(manifest, archiveSha256);
      if (problems.length > 0) fail(problems);
      const archiveCheck = spawnSync(
        "python3",
        [ARCHIVE_VALIDATOR, process.argv[4], `agentify-${manifest.revision}`],
        { encoding: "utf8" },
      );
      if (archiveCheck.status !== 0) {
        fail([
          archiveCheck.stderr?.trim() ||
            archiveCheck.error?.message ||
            "configuration archive structure is unsafe",
        ]);
      }
      console.log(`release manifest accepted for ${manifest.revision}`);
    } catch (error) {
      fail([error instanceof Error ? error.message : String(error)]);
    }
  } else if (command === "topology" && process.argv.length === 6) {
    try {
      const manifest = JSON.parse(readFileSync(process.argv[3], "utf8"));
      const testTopology = JSON.parse(readFileSync(process.argv[4], "utf8"));
      const productionTopology = JSON.parse(readFileSync(process.argv[5], "utf8"));
      const problems = problemsWithReleaseTopology(testTopology, productionTopology, manifest);
      if (problems.length > 0) fail(problems);
      console.log(`release topology accepted for ${manifest.revision}`);
    } catch (error) {
      fail([error instanceof Error ? error.message : String(error)]);
    }
  } else {
    console.error(
      "usage: release-manifest.mjs create <repository> <revision> <archive> " +
        "<commerce-app> <commerce-web> <scanner-web> <scanner-worker> <scanner-privacy> " +
        "<postgres> <caddy> <alpine>\n" +
        "   or: release-manifest.mjs verify <manifest> <archive>\n" +
        "   or: release-manifest.mjs topology <manifest> <test-topology> <production-topology>",
    );
    process.exit(64);
  }
}

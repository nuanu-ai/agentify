import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ReleaseManifest } from "./release-manifest.d.mts";
import {
  createReleaseManifest,
  problemsWithReleaseManifest,
  problemsWithReleaseTopology,
  sha256Of,
} from "./release-manifest.mjs";

const REVISION = "a786afdd131424e5b3326ee7668208f3c705b598";
const ARCHIVE_VALIDATOR = fileURLToPath(new URL("./validate-release-archive.py", import.meta.url));
const digest = (character: string) => `sha256:${character.repeat(64)}`;

const image = (name: string, character: string) => `ghcr.io/nuanu-ai/${name}@${digest(character)}`;

const firstParty = {
  "commerce-app": image("agentify-commerce-app", "1"),
  "commerce-web": image("agentify-commerce-web", "2"),
  "scanner-web": image("agentify-scanner-web", "3"),
  "scanner-worker": image("agentify-scanner-worker", "4"),
  "scanner-privacy": image("agentify-scanner-privacy", "5"),
};

const infrastructure = {
  postgres: `docker.io/library/postgres@${digest("a")}`,
  caddy: `docker.io/library/caddy@${digest("b")}`,
  alpine: `docker.io/library/alpine@${digest("c")}`,
};

interface MutableManifest {
  schemaVersion: number;
  repository: string;
  revision: string;
  configuration: { archive: string; sha256: string };
  images: {
    firstParty: Record<string, string>;
    infrastructure: Record<string, string>;
  };
  [key: string]: unknown;
}

const validManifest = (): ReleaseManifest => ({
  schemaVersion: 1,
  repository: "nuanu-ai/agentify",
  revision: REVISION,
  configuration: {
    archive: `agentify-config-${REVISION}.tar.gz`,
    sha256: digest("d"),
  },
  images: { firstParty, infrastructure },
});

const mutableManifest = (): MutableManifest =>
  structuredClone(validManifest()) as unknown as MutableManifest;

const validTopology = () => ({
  commerce: {
    postgres: { image: infrastructure.postgres },
    migrate: { image: firstParty["commerce-app"], command: ["pnpm", "db:migrate"] },
    gateway: {
      image: firstParty["commerce-app"],
      command: ["pnpm", "--filter", "@agentify/commerce-gateway", "start"],
    },
    cabinet: {
      image: firstParty["commerce-app"],
      command: ["pnpm", "--filter", "@agentify/commerce-cabinet", "start"],
    },
    web: { image: firstParty["commerce-web"] },
  },
  scanner: {
    "roles-reconcile": { image: infrastructure.postgres, command: ["/runtime-reconcile.sh"] },
    migrate: {
      image: firstParty["scanner-worker"],
      command: ["node", "packages/scanner-database/dist/migrate-cli.js"],
    },
    "queue-init": {
      image: firstParty["scanner-worker"],
      command: ["node", "apps/scanner-worker/dist/queue-init-cli.js"],
    },
    "database-dashboards-install": {
      image: infrastructure.postgres,
      command: ["/runtime-install-database-dashboards.sh"],
    },
    "database-access-finalize": {
      image: infrastructure.postgres,
      command: ["/runtime-finalize-database-access.sh"],
    },
    web: { image: firstParty["scanner-web"] },
    worker: { image: firstParty["scanner-worker"] },
    "privacy-cleanup": { image: firstParty["scanner-privacy"] },
    "database-backup": {
      image: infrastructure.postgres,
      command: ["/runtime-database-backup.sh"],
    },
    "database-config-check": {
      image: infrastructure.alpine,
      command: ["/runtime-validate-database-config.sh"],
    },
    "database-access-verify": {
      image: infrastructure.postgres,
      command: ["/runtime-verify-database-access.sh"],
    },
  },
});

describe("an immutable release manifest", () => {
  it("accepts one exact source revision, a matching config archive and digest-only images", () => {
    expect(problemsWithReleaseManifest(validManifest(), digest("d"))).toEqual([]);
  });

  it("requires every deployed first-party and infrastructure image role", () => {
    for (const role of Object.keys(firstParty)) {
      const wrong = mutableManifest();
      delete wrong.images.firstParty[role];
      expect(problemsWithReleaseManifest(wrong, digest("d"))).toContainEqual(
        expect.stringMatching(new RegExp(`firstParty.*${role}`)),
      );
    }

    for (const role of Object.keys(infrastructure)) {
      const wrong = mutableManifest();
      delete wrong.images.infrastructure[role];
      expect(problemsWithReleaseManifest(wrong, digest("d"))).toContainEqual(
        expect.stringMatching(new RegExp(`infrastructure.*${role}`)),
      );
    }
  });

  it("requires every manifest, archive and image-group field", () => {
    for (const [field, message] of [
      ["schemaVersion", /schemaVersion/],
      ["repository", /repository/],
      ["revision", /revision/],
      ["configuration", /configuration/],
      ["images", /images/],
      ["configuration.archive", /configuration\.archive/],
      ["configuration.sha256", /configuration\.sha256/],
      ["images.firstParty", /images\.firstParty/],
      ["images.infrastructure", /images\.infrastructure/],
    ] as const) {
      const wrong = mutableManifest();
      const path = field.split(".");
      const owner = path
        .slice(0, -1)
        .reduce<Record<string, unknown>>(
          (value, key) => value[key] as Record<string, unknown>,
          wrong,
        );
      delete owner[path.at(-1) ?? ""];
      expect(problemsWithReleaseManifest(wrong, digest("d")).join("\n"), field).toMatch(message);
    }
  });

  it("refuses tags, foreign image names and incomplete digests", () => {
    const tagged = structuredClone(validManifest());
    tagged.images.firstParty["commerce-app"] = `ghcr.io/nuanu-ai/agentify-commerce-app:${REVISION}`;
    expect(problemsWithReleaseManifest(tagged, digest("d"))).toContainEqual(
      expect.stringMatching(/commerce-app.*digest/),
    );

    const foreign = structuredClone(validManifest());
    foreign.images.firstParty["scanner-web"] = image("another-scanner-web", "3");
    expect(problemsWithReleaseManifest(foreign, digest("d"))).toContainEqual(
      expect.stringMatching(/scanner-web.*agentify-scanner-web/),
    );

    const short = structuredClone(validManifest());
    short.images.infrastructure.postgres = "docker.io/library/postgres@sha256:1234";
    expect(problemsWithReleaseManifest(short, digest("d"))).toContainEqual(
      expect.stringMatching(/postgres.*digest/),
    );
  });

  it("allows two roles to resolve to one digest while preserving their named repositories", () => {
    const shared = structuredClone(validManifest());
    shared.images.firstParty["commerce-web"] =
      `ghcr.io/nuanu-ai/agentify-commerce-web@${digest("1")}`;
    expect(problemsWithReleaseManifest(shared, digest("d"))).toEqual([]);
  });

  it("refuses another repository, malformed source revisions and a mismatched archive name", () => {
    for (const change of [
      (wrong: MutableManifest) => {
        wrong.repository = "someone/else";
      },
      (wrong: MutableManifest) => {
        wrong.revision = `${REVISION.slice(0, -1)}Z`;
      },
      (wrong: MutableManifest) => {
        wrong.configuration.archive = `agentify-config-${"0".repeat(40)}.tar.gz`;
      },
      (wrong: MutableManifest) => {
        wrong.configuration.archive = `../agentify-config-${REVISION}.tar.gz`;
      },
    ]) {
      const wrong = mutableManifest();
      change(wrong);
      expect(problemsWithReleaseManifest(wrong, digest("d")).length).toBeGreaterThan(0);
    }
  });

  it("refuses an archive whose bytes do not match the recorded checksum", () => {
    expect(problemsWithReleaseManifest(validManifest(), digest("e"))).toContainEqual(
      expect.stringMatching(/configuration.*checksum/),
    );
  });

  it("refuses unknown fields instead of silently widening the release contract", () => {
    const wrong = mutableManifest();
    wrong.delivery = { automatic: true };
    wrong.images.firstParty.experimental = image("agentify-experimental", "e");
    expect(problemsWithReleaseManifest(wrong, digest("d"))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unknown manifest field.*delivery/),
        expect.stringMatching(/unknown firstParty image.*experimental/),
      ]),
    );
  });
});

describe("creating the manifest beside the exact source archive", () => {
  it("hashes the archive bytes and emits a manifest that verifies against them", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentify-release-manifest-"));
    const archive = join(directory, `agentify-config-${REVISION}.tar.gz`);
    writeFileSync(archive, "the tracked configuration archive");

    const manifest = createReleaseManifest({
      repository: "nuanu-ai/agentify",
      revision: REVISION,
      archive,
      firstParty,
      infrastructure,
    });

    expect(manifest.configuration.sha256).toBe(sha256Of(readFileSync(archive)));
    expect(problemsWithReleaseManifest(manifest, sha256Of(readFileSync(archive)))).toEqual([]);
  });
});

describe("the configuration archive boundary", () => {
  const pack = (root: string, archive: string) =>
    spawnSync("tar", ["-czf", archive, "-C", dirname(root), root.split("/").at(-1) ?? ""], {
      encoding: "utf8",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });

  it("accepts one exact revision root made only of files, directories and confined links", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentify-release-archive-"));
    const root = join(directory, `agentify-${REVISION}`);
    const archive = join(directory, "release.tar.gz");
    mkdirSync(join(root, "deploy"), { recursive: true });
    writeFileSync(join(root, "compose.yaml"), "services: {}\n");
    symlinkSync("../compose.yaml", join(root, "deploy", "compose-link.yaml"));
    expect(pack(root, archive).status).toBe(0);

    const result = spawnSync("python3", [ARCHIVE_VALIDATOR, archive, `agentify-${REVISION}`], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("refuses a link that leaves the revision root", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentify-release-archive-"));
    const root = join(directory, `agentify-${REVISION}`);
    const archive = join(directory, "release.tar.gz");
    mkdirSync(root, { recursive: true });
    symlinkSync("../../outside", join(root, "escape"));
    expect(pack(root, archive).status).toBe(0);

    const result = spawnSync("python3", [ARCHIVE_VALIDATOR, archive, `agentify-${REVISION}`], {
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsafe link target/);
  });
});

describe("test and production application topology", () => {
  it("accepts the exact service roles, commands and manifest image digests", () => {
    const topology = validTopology();
    (topology.commerce.web as { image: string; command: null }).command = null;
    expect(
      problemsWithReleaseTopology(topology, structuredClone(topology), validManifest()),
    ).toEqual([]);
  });

  it("refuses a missing or additional active service", () => {
    const missing = validTopology();
    delete (missing.scanner as Record<string, unknown>)["database-backup"];
    expect(problemsWithReleaseTopology(missing, validTopology(), validManifest())).toContainEqual(
      expect.stringMatching(/test scanner.*database-backup.*required/),
    );

    const additional = validTopology() as ReturnType<typeof validTopology> & {
      commerce: Record<string, unknown>;
    };
    additional.commerce.merchant = { image: firstParty["commerce-app"] };
    expect(
      problemsWithReleaseTopology(additional, validTopology(), validManifest()),
    ).toContainEqual(expect.stringMatching(/test commerce.*unknown.*merchant/));
  });

  it("refuses any deploy-time build and any image not pinned by the manifest", () => {
    const building = validTopology();
    (building.commerce.gateway as Record<string, unknown>).build = { context: "." };
    expect(problemsWithReleaseTopology(building, validTopology(), validManifest())).toContainEqual(
      expect.stringMatching(/test commerce.gateway.*build/),
    );

    const tagged = validTopology();
    tagged.scanner.worker.image = `ghcr.io/nuanu-ai/agentify-scanner-worker:${REVISION}`;
    expect(problemsWithReleaseTopology(tagged, validTopology(), validManifest())).toContainEqual(
      expect.stringMatching(/test scanner.worker.*manifest/),
    );
  });

  it("refuses a command difference between test and production", () => {
    const production = validTopology();
    (production.scanner["privacy-cleanup"] as { image: string; command?: string[] }).command = [
      "sh",
      "-c",
      "do-something-else",
    ];
    expect(
      problemsWithReleaseTopology(validTopology(), production, validManifest()),
    ).toContainEqual(expect.stringMatching(/scanner.privacy-cleanup.*command differs/));
  });
});

/**
 * One application tag, `app-v<release>`, is the acceptance that puts a revision
 * on production (ADR-0016) and publishes whatever SDK and contracts versions
 * that revision carries and the registry does not yet hold. These tests
 * execute the same resolver as the publish workflow: a tag that is not the
 * application's, an unreleased manifest, a prerelease or a third public
 * package must stop before authentication and before `npm publish`. The
 * number in the tag is the application's and says nothing about the SDK
 * version, which comes from the manifest alone.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const resolver = fileURLToPath(
  new URL("../../../scripts/check-sdk-release-tag.sh", import.meta.url),
);
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { force: true, recursive: true });
});

const resolverFor = (
  sdkVersion: string,
  contractsVersion: string,
  extraPublicPackage?: string,
): string => {
  const root = mkdtempSync(join(tmpdir(), "agentify-sdk-release-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "packages", "sdk"), { recursive: true });
  mkdirSync(join(root, "packages", "contracts"), { recursive: true });

  const executable = join(root, "scripts", "check-sdk-release-tag.sh");
  copyFileSync(resolver, executable);
  chmodSync(executable, 0o755);
  writeFileSync(
    join(root, "packages", "sdk", "package.json"),
    JSON.stringify({ name: "@nuanu-ai/agentify", version: sdkVersion }),
  );
  writeFileSync(
    join(root, "packages", "contracts", "package.json"),
    JSON.stringify({ name: "@nuanu-ai/agentify-contracts", version: contractsVersion }),
  );
  if (extraPublicPackage) {
    mkdirSync(join(root, "packages", "extra"), { recursive: true });
    writeFileSync(
      join(root, "packages", "extra", "package.json"),
      JSON.stringify({ name: extraPublicPackage, version: "1.0.0" }),
    );
  }
  return executable;
};

const resolve = (tag: string, sdkVersion: string, contractsVersion = sdkVersion): string =>
  execFileSync(resolverFor(sdkVersion, contractsVersion), [tag], { encoding: "utf8" });

const refuse = (tag: string, sdkVersion: string, contractsVersion = sdkVersion) =>
  spawnSync(resolverFor(sdkVersion, contractsVersion), [tag], { encoding: "utf8" });

describe("the application release tag", () => {
  it("names the manifest versions and the stable npm channel", () => {
    expect(resolve("app-v2026.09.22", "0.1.0")).toBe(
      "sdk_version=0.1.0\ncontracts_version=0.1.0\ndist_tag=latest\n",
    );
  });

  it("takes the SDK version from the manifest, not from the number in the tag", () => {
    expect(resolve("app-v7", "0.2.6", "0.3.2")).toBe(
      "sdk_version=0.2.6\ncontracts_version=0.3.2\ndist_tag=latest\n",
    );
  });

  it("refuses a tag that is not the application's acceptance tag", () => {
    for (const tag of ["sdk-v0.1.0", "v0.1.0", "app-v", "app-v0.1.0 extra"]) {
      const result = refuse(tag, "0.1.0");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("must be an app-v<release> acceptance tag");
    }
  });

  it("refuses prereleases instead of deriving an unsafe npm channel", () => {
    for (const version of ["0.2.0-rc.3", "0.2.0-latest.1", "0.2.0-1"]) {
      const result = refuse("app-v1", version);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not a stable semantic version");
    }
  });

  it("refuses manifests that still say unreleased", () => {
    for (const [sdk, contracts] of [
      ["0.0.0", "0.1.0"],
      ["0.1.0", "0.0.0"],
    ] as const) {
      const result = refuse("app-v1", sdk, contracts);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("0.0.0 is not publishable");
    }
  });

  it("refuses to let Changesets publish another public workspace package", () => {
    const result = spawnSync(resolverFor("0.1.0", "0.1.0", "@nuanu-ai/extra"), ["app-v1"], {
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SDK release may publish only");
    expect(result.stderr).toContain("@nuanu-ai/extra");
  });
});

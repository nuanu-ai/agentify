import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RELEASE_RECEIVER = fileURLToPath(new URL("../../../../deploy/release.sh", import.meta.url));
const PULL_AGENT = fileURLToPath(new URL("../../../../deploy/pull-agent.sh", import.meta.url));

describe("the retired automatic delivery path", () => {
  it("refuses the old source-build receiver before reading a candidate", () => {
    const result = spawnSync(RELEASE_RECEIVER, ["test", "a".repeat(40)], {
      encoding: "utf8",
      input: "candidate bytes that must not be read",
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("source-build receiver is retired");
  });

  it("refuses the old timer pull path before making a network request", () => {
    const result = spawnSync("/bin/bash", [PULL_AGENT, "unexpected", "arguments"], {
      encoding: "utf8",
      env: { PATH: "" },
    });

    expect(result.status).toBe(75);
    expect(result.stderr).toContain("automatic delivery is retired");
  });
});

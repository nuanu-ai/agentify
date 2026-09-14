import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("queue bootstrap ACL contract", () => {
  it("uses the connected admin role and revokes Supabase public roles", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./queue-init-cli.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain("ALTER DEFAULT PRIVILEGES FOR ROLE");
    expect(source).toContain("ALTER DEFAULT PRIVILEGES IN SCHEMA public");
    expect(source).toContain("ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss");
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(source).toContain(`'${role}'`);
    }
    expect(source).toContain(
      "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public, pgboss FROM PUBLIC",
    );
    expect(source).toContain(
      "REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public, pgboss FROM %I",
    );
    expect(source).toContain(
      "GRANT SELECT, INSERT ON public.rate_limit_events TO agentify_web",
    );
    expect(source).toContain(
      "GRANT SELECT, INSERT, UPDATE ON public.rate_windows TO agentify_web",
    );
    expect(source).not.toContain(
      "DELETE ON public.rate_limit_events TO agentify_web",
    );
  });
});

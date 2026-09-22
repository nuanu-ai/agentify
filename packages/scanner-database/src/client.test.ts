import { describe, expect, it } from "vitest";

import { normalizeNodePostgresConnectionString } from "./client.js";

describe("normalizeNodePostgresConnectionString", () => {
  it("opts Node pg into standard libpq require semantics", () => {
    const normalized = normalizeNodePostgresConnectionString(
      "postgresql://agentify:p%40ss%21@pooler.example:5432/postgres?sslmode=require",
    );
    const url = new URL(normalized);

    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.searchParams.get("uselibpqcompat")).toBe("true");
    expect(url.password).toBe("p%40ss%21");
  });

  it("does not weaken an explicit certificate-verification mode", () => {
    const normalized = normalizeNodePostgresConnectionString(
      "postgresql://agentify:secret@db.example:5432/postgres?sslmode=verify-full",
    );

    expect(new URL(normalized).searchParams.has("uselibpqcompat")).toBe(false);
  });

  it("preserves an explicit compatibility decision", () => {
    const normalized = normalizeNodePostgresConnectionString(
      "postgresql://agentify:secret@db.example:5432/postgres?sslmode=require&uselibpqcompat=false",
    );

    expect(new URL(normalized).searchParams.get("uselibpqcompat")).toBe("false");
  });
});

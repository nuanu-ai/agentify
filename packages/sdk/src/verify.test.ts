import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runVerify } from "./verify.js";

const validCard = {
  merchant_item_id: "access-monthly",
  title: "Доступ к сервису на один месяц",
  description: "Что покупатель получает, для какой задачи это годится и что в это не входит.",
  price: { amount: "5.00", currency: "USD" },
  params: { email: { type: "string", required: true, title: "Куда прислать доступ" } },
  result: { access_url: { type: "string", title: "Ссылка для входа" } },
  fulfillment: "sync",
};

let directory: string | undefined;

const fileHolding = (name: string, contents: unknown): string => {
  directory ??= mkdtempSync(join(tmpdir(), "agentify-verify-"));
  const path = join(directory, name);

  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));

  return path;
};

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

// The exit codes are written out as numbers: a merchant's build branches on
// them, and comparing with the constant would stay green if the number moved.
const verifying = async (...argv: string[]): Promise<{ code: number; said: string }> => {
  const lines: string[] = [];
  const code = await runVerify(argv, (line) => lines.push(line));

  return { code, said: lines.join("\n") };
};

describe("agentify verify", () => {
  it("answers zero for cards that are complete, and says what it does not check", async () => {
    // A complete card must read as success to a build. What the command does
    // not check is said in its output, not counted as a failed check.
    const { code, said } = await verifying("verify", fileHolding("card.json", validCard));

    expect(said).toMatch(/access-monthly/);
    expect(said).toMatch(/complete/i);
    expect(said).toMatch(/test purchase/);
    expect(code).toBe(0);
  });

  it("reports every finding of a card, pointing at the fields", async () => {
    const broken = { ...validCard, title: undefined, price: { amount: "5,00", currency: "USD" } };
    const { code, said } = await verifying("verify", fileHolding("card.json", broken));

    expect(said).toMatch(/title/);
    expect(said).toMatch(/price\.amount/);
    expect(code).toBe(1);
  });

  it("checks every card it was given, not just the first that failed", async () => {
    // One run reports every bad card, not just the first.
    const { code, said } = await verifying(
      "verify",
      fileHolding("one.json", { ...validCard, result: {} }),
      fileHolding("two.json", { ...validCard, merchant_item_id: "esim-7d", fulfillment: "later" }),
    );

    expect(said).toMatch(/result/);
    expect(said).toMatch(/fulfillment/);
    expect(code).toBe(1);
  });

  it("says a card file that is not JSON is a finding about that card", async () => {
    const { code, said } = await verifying("verify", fileHolding("card.json", "{not json at all"));

    expect(said).toMatch(/card\.json/);
    expect(said).toMatch(/JSON/);
    expect(code).toBe(1);
  });

  it("warns that a card which failed its shape may have more findings behind it", async () => {
    // A short list does not imply a clean second run, and the output says so.
    const { said } = await verifying(
      "verify",
      fileHolding("card.json", { ...validCard, nonsense: 1 }),
    );

    expect(said).toMatch(/again/i);
    expect(said).toMatch(/shape.*wrong/i);
    expect(said).toMatch(/not checked.*rules.*compare one field.*another/i);
    expect(said).toMatch(/more behind/i);
  });

  it("asks for local card files and says that it makes no remote check", async () => {
    const { code, said } = await verifying("verify");
    expect(said).toMatch(/no key.*no address/i);
    expect(said).toMatch(/cannot ask.*published/s);
    expect(said).toMatch(/Name.*card files/i);
    expect(said).toMatch(/next publish/);
    expect(code).toBe(2);
  });

  it("says which file it could not find", async () => {
    const { code, said } = await verifying("verify", join(tmpdir(), "no-such-card-file.json"));

    expect(said).toMatch(/no-such-card-file\.json/);
    expect(code).toBe(2);
  });

  it("answers an unknown word with what it does know", async () => {
    const { code, said } = await verifying("publish", "card.json");

    expect(said).toMatch(/verify/);
    expect(code).toBe(2);
  });
});

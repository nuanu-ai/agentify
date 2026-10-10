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

// The answers are written out as numbers rather than read from the module.
// They are what a merchant's build branches on and what the usage text
// promises, and a test comparing the answer with the constant that produced it
// would stay green when the number moved.
const verifying = async (...argv: string[]): Promise<{ code: number; said: string }> => {
  const lines: string[] = [];
  const code = await runVerify(argv, (line) => lines.push(line));

  return { code, said: lines.join("\n") };
};

describe("agentify verify", () => {
  it("answers zero for cards that are complete, and says what it does not check", async () => {
    // A build that runs this before publishing reads its exit code, and a
    // complete card has to read as one. What the command does not check —
    // whether the handler makes second goods for an order delivered twice —
    // is said in its output as outside it, not reported as a check that failed.
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
    // The portal promises a short edit cycle. A command that stopped at the
    // first bad card would turn one round of fixes into several.
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
    // The checker stops before the rules that compare fields when the shape
    // itself is wrong, and a merchant reading a short list is entitled to
    // know a clean second run is not implied by it.
    const { said } = await verifying(
      "verify",
      fileHolding("card.json", { ...validCard, nonsense: 1 }),
    );

    expect(said).toMatch(/again/i);
  });

  it("stops rather than scolds when it is given no card files", async () => {
    // The documentation shows the bare command, and the bare command cannot
    // work: it takes no key and no address, so nothing that was published is
    // within its reach — and the call that would hand those cards back,
    // list_merchant_cards, returns cards that passed this very check on their
    // way in. It is answered as a call the command cannot work from.
    //
    // Every part of the reason is pinned, because the reason is what the
    // merchant is owed here, and this text went stale once already: it named
    // an absent call after the call had been added. The tense is pinned too.
    // "passed on the day they went out" is the claim the code can support;
    // "have passed" would be a promise about a schema that is allowed to move.
    //
    // The message is also addressed to whoever ran the command, and most of
    // them reached it through `npx` with no idea that a repository exists.
    // So it says "you" throughout and never "a merchant", and it talks about
    // the command they typed rather than about a package in a workspace.
    const { code, said } = await verifying("verify");

    expect(said).toMatch(/takes no key and no address/);
    expect(said).toMatch(/list_merchant_cards/);
    expect(said).toMatch(/passed this check on the day they went out/);
    // Wrapped across lines in the message, so the wrap is not what is pinned.
    expect(said).toMatch(/where you keep the cards\s+you\s+publish from/);
    expect(said).not.toMatch(/a merchant/);
    expect(said).toMatch(/Name the card files instead/);
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

  it("answers zero only when every card it was given is complete", async () => {
    // One input for each way out of runVerify — nothing to check, cards that
    // passed, cards that did not, a file that is not there, a word the command
    // does not know — and only the second may read as success to a build.
    const answers = await Promise.all([
      verifying("verify"),
      verifying("verify", fileHolding("good.json", validCard)),
      verifying("verify", fileHolding("bad.json", { ...validCard, result: {} })),
      verifying("verify", join(tmpdir(), "no-such-card-file.json")),
      verifying("publish"),
    ]);

    expect(answers.map((answer) => answer.code)).toStrictEqual([2, 0, 1, 2, 2]);
  });
});

/**
 * `pnpm smoke:recorded`: whether the services Agentify does not run still
 * answer as `@agentify/recorded` says they were seen to. It makes a few public
 * GET requests to each service, with no key and no sign-in, and spends
 * nothing.
 *
 * For Coinbase's public exchange rates it checks which of the currencies
 * WooCommerce offers a shop Coinbase rates one US dollar in, and the shape of
 * its answer for a base currency it does not know. For WooCommerce it reads
 * the list of currencies and every recorded statement from the source of the
 * recorded release on GitHub, and again from the source of the newest
 * release: a fact that no longer holds in either fails the run, and a newer
 * release in which every fact holds is reported, so that a person moves the
 * recording to it. For the payment facilitator it reads the recorded refusal
 * codes again from the npm tarballs of the versions the gateway pins, and
 * holds the verification codes of the newest published versions against the
 * gateway's refusal table in both directions. A code they add that the table
 * cannot read fails the run unless the recording lists it as awaiting the
 * product owner's decision, and so does a code the table reads that they drop.
 *
 * It leaves alone the rates themselves, which move; the other currencies and
 * tokens Coinbase lists, which come and go and are reported without failing;
 * every live shop, since WooCommerce's source is read instead; WordPress's own
 * codes; the facilitator's answers over HTTP, which need its key; settlement
 * codes, because the gateway keeps an unfamiliar settlement refusal as an
 * unknown outcome and reads its table only at verification; and refusal codes
 * of the payment schemes, networks and transfer methods the gateway does not
 * offer. The x402 file declares verification and settlement codes together
 * without saying which a verification can carry, so each of its codes counts
 * as a possible verification code. A code awaiting a decision is reported on
 * every run, and so is one that the table has come to read or the newest
 * version no longer names, so that the list does not outlive its codes. It
 * finds the table's codes among the string literals of the table's source
 * file, so a code moved to another file goes unseen.
 *
 * It exits 1 when a recorded fact no longer holds, and 2 when none changed but
 * something could not be checked. No answer, a refusal to answer (401, 403,
 * 429 or a server error) and a page that is not JSON, such as a challenge page
 * in front of Coinbase, are never read as a change, while JSON from Coinbase
 * that the dashboard cannot read as its rates is.
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { readRefusal } from "../../../apps/gateway/src/adapters/x402/refusal-codes.js";
import { coinbaseRates, coinbaseUnknownBase, facilitatorRefusals, wooCommerce } from "./index.js";

const ANSWERS_WITHIN_MS = 30_000;

type Outcome = "holds" | "changed" | "could not check" | "notice";

interface Finding {
  readonly outcome: Outcome;
  readonly fact: string;
  readonly source: string;
  readonly recorded?: string;
  readonly live?: string;
}

const findings: Finding[] = [];

const say = (finding: Finding): void => {
  findings.push(finding);
  console.log(`${finding.outcome.toUpperCase()}  ${finding.fact}`);
  console.log(`  source    ${finding.source}`);
  if (finding.recorded !== undefined) console.log(`  recorded  ${finding.recorded}`);
  if (finding.live !== undefined) console.log(`  live      ${finding.live}`);
  if (process.env.GITHUB_ACTIONS === "true" && finding.outcome !== "holds") {
    const level = finding.outcome === "changed" ? "error" : "warning";
    console.log(`::${level} title=${finding.outcome}::${finding.fact}`);
  }
  console.log("");
};

/** A service that gave no readable answer, which says nothing about the fact asked. */
class Unanswered extends Error {}

/** Statuses that turn a request away unanswered: a sign-in, a block or a rate limit. */
const TURNED_AWAY = [401, 403, 429];

const get = async (url: string): Promise<Response> => {
  let answered: Response;
  try {
    answered = await fetch(url, { signal: AbortSignal.timeout(ANSWERS_WITHIN_MS) });
  } catch (error) {
    throw new Unanswered(`${url} did not answer: ${(error as Error).message}`);
  }
  if (TURNED_AWAY.includes(answered.status) || answered.status >= 500) {
    throw new Unanswered(`${url} answered HTTP ${answered.status}`);
  }
  return answered;
};

/** The body at `url`, or null where the service says nothing is there. */
const read = async (url: string): Promise<string | null> => {
  const answered = await get(url);
  if (answered.status === 404) return null;
  if (!answered.ok) throw new Unanswered(`${url} answered HTTP ${answered.status}`);
  return await answered.text();
};

/** `text` read as JSON; a page that is not JSON is no answer from the service. */
const jsonOf = <Shape>(text: string, url: string): Shape => {
  try {
    return JSON.parse(text) as Shape;
  } catch {
    throw new Unanswered(`${url} answered with a page that is not JSON`);
  }
};

const checking = async (fact: string, source: string, check: () => Promise<void>) => {
  try {
    await check();
  } catch (error) {
    if (!(error instanceof Unanswered)) throw error;
    say({ outcome: "could not check", fact, source, live: error.message });
  }
};

const listed = (codes: readonly string[]): string =>
  codes.length === 0 ? "none" : codes.join(" ");

const without = (codes: readonly string[], others: readonly string[]): string[] =>
  codes.filter((code) => !others.includes(code));

const within = (codes: readonly string[], others: readonly string[]): string[] =>
  codes.filter((code) => others.includes(code));

const now = (): string => new Date().toISOString();

const SHOP_CURRENCIES = wooCommerce.currencies.codes;

/**
 * The codes `body` rates one US dollar in, null for a body that is not JSON,
 * which is no answer from Coinbase, or why the JSON is not what the dashboard
 * reads.
 */
const ratedIn = (body: string): readonly string[] | string | null => {
  let answer: { data?: { currency?: unknown; rates?: unknown } };
  try {
    answer = JSON.parse(body);
  } catch {
    return null;
  }
  const rates = answer.data?.rates;
  if (answer.data?.currency !== "USD") return "it is not for one US dollar";
  if (typeof rates !== "object" || rates === null) return "it carries no rates";
  const unreadable = Object.entries(rates).find(
    ([, rate]) => typeof rate !== "string" || !/^\d+(?:\.\d+)?$/.test(rate),
  );
  if (unreadable !== undefined) return `its rate for ${unreadable[0]} is not a decimal`;
  return Object.keys(rates);
};

/** The status and the body's fields with their types, or null for a body that is not JSON. */
const shapeOf = (status: number, body: string): string | null => {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return `HTTP ${status}, ${typeof value}`;
  const fields = Object.entries(value)
    .map(([key, inner]) => `${key}: ${typeof inner}`)
    .sort();
  return `HTTP ${status} {${fields.join(", ")}}`;
};

const coinbase = async (): Promise<void> => {
  const rated = `Coinbase rates one US dollar in every currency WooCommerce ${wooCommerce.release} offers a shop except these`;
  await checking(rated, coinbaseRates.url, async () => {
    const recorded = ratedIn(coinbaseRates.body);
    if (recorded === null || typeof recorded === "string") {
      throw new Error(`the recorded answer is not Coinbase's: ${recorded ?? "not JSON"}`);
    }
    const recordedLine = `${coinbaseRates.readAt.toISOString()}: ${listed(without(SHOP_CURRENCIES, recorded))}`;
    const answered = await get(coinbaseRates.url);
    if (!answered.ok) throw new Unanswered(`${coinbaseRates.url} answered HTTP ${answered.status}`);
    const live = ratedIn(await answered.text());
    if (live === null) {
      throw new Unanswered(`${coinbaseRates.url} answered with a page that is not JSON`);
    }
    if (typeof live === "string") {
      say({
        outcome: "changed",
        fact: rated,
        source: coinbaseRates.url,
        recorded: recordedLine,
        live: `${now()}: the answer is not one the dashboard reads, since ${live}`,
      });
      return;
    }
    const nowRated = within(SHOP_CURRENCIES, live);
    const thenRated = within(SHOP_CURRENCIES, recorded);
    const added = without(nowRated, thenRated);
    const dropped = without(thenRated, nowRated);
    say({
      outcome: added.length + dropped.length === 0 ? "holds" : "changed",
      fact: rated,
      source: coinbaseRates.url,
      recorded: recordedLine,
      live:
        `${now()}: ${listed(without(SHOP_CURRENCIES, live))}` +
        (added.length > 0 ? `; now rates ${listed(added)}` : "") +
        (dropped.length > 0 ? `; no longer rates ${listed(dropped)}` : ""),
    });
    const others = (codes: readonly string[]) => without(codes, SHOP_CURRENCIES);
    const listedNow = without(others(live), recorded);
    const delisted = without(others(recorded), live);
    if (listedNow.length + delisted.length > 0) {
      say({
        outcome: "notice",
        fact: "Coinbase lists other currencies and tokens than its recorded answer, none of them one a shop can price in",
        source: coinbaseRates.url,
        recorded: `${coinbaseRates.readAt.toISOString()}: ${recorded.length} codes`,
        live: `${now()}: ${live.length} codes; added ${listed(listedNow)}; dropped ${listed(delisted)}`,
      });
    }
  });

  const refused = "Coinbase refuses a base currency it does not know with this status and body";
  await checking(refused, coinbaseUnknownBase.url, async () => {
    const answered = await get(coinbaseUnknownBase.url);
    const body = await answered.text();
    const live = shapeOf(answered.status, body);
    if (live === null) {
      throw new Unanswered(
        `${coinbaseUnknownBase.url} answered HTTP ${answered.status} with a page that is not JSON`,
      );
    }
    const recorded = shapeOf(coinbaseUnknownBase.status, coinbaseUnknownBase.body);
    say({
      outcome: live === recorded ? "holds" : "changed",
      fact: refused,
      source: coinbaseUnknownBase.url,
      recorded: `${coinbaseUnknownBase.readAt.toISOString()}: ${recorded} ${coinbaseUnknownBase.body}`,
      live: `${now()}: ${live} ${body}`,
    });
  });
};

const WOO_RELEASES =
  "https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=woocommerce";

const collapsed = (text: string): string => text.replace(/\s+/g, " ").trim();

type WooRefusal = (typeof wooCommerce.refusals)[number];

/** What a recorded refusal says that its own statement does not, if anything. */
const contradiction = (refusal: WooRefusal): string | null => {
  const postType =
    refusal.postType === undefined
      ? undefined
      : /\$post_type = '(\w+)'/.exec(refusal.postType.statement)?.[1];
  const written =
    postType === undefined
      ? refusal.statement
      : refusal.statement.replaceAll("{$this->post_type}", postType);
  if (!written.includes(`'${refusal.code}'`) && !written.includes(`"${refusal.code}"`)) {
    return `the recorded statement gives no code ${refusal.code}`;
  }
  if (refusal.status !== null && !new RegExp(`\\b${refusal.status}\\b`).test(refusal.statement)) {
    return `the recorded statement gives no status ${refusal.status}`;
  }
  if (refusal.message !== null && !refusal.statement.includes(`'${refusal.message}'`)) {
    return `the recorded statement says no "${refusal.message}"`;
  }
  return null;
};

interface WooFact {
  readonly fact: string;
  readonly source: string;
  readonly recorded: string;
  /** What the release's source lacks of the fact, or null where it holds. */
  readonly missing: string | null;
}

/** Every recorded WooCommerce fact, held against the source of `release`. */
const wooFactsAt = async (release: string): Promise<readonly WooFact[]> => {
  const at = (file: string) => `${wooCommerce.repository}${release}/${file}`;
  const files = new Map<string, string | null>();
  const fileOf = async (file: string): Promise<string | null> => {
    if (!files.has(file)) files.set(file, await read(at(file)));
    return files.get(file) ?? null;
  };
  const recorded = `${wooCommerce.readAt}, ${wooCommerce.release}`;

  const { currencies } = wooCommerce;
  const text = await fileOf(currencies.file);
  const offered =
    text === null
      ? null
      : [...text.matchAll(/^\s*'([A-Z]{3})'\s*=>/gm)].map(([, code]) => code ?? "");
  const added = offered === null ? [] : without(offered, currencies.codes);
  const dropped = offered === null ? [] : without(currencies.codes, offered);
  const facts: WooFact[] = [
    {
      fact: `WooCommerce ${release} offers a shop the ${currencies.codes.length} recorded currencies`,
      source: at(currencies.file),
      recorded: `${recorded}: ${currencies.codes.length} currencies`,
      missing:
        offered === null
          ? `no file ${currencies.file}`
          : added.length + dropped.length === 0
            ? null
            : `added ${listed(added)}; dropped ${listed(dropped)}`,
    },
  ];

  for (const refusal of wooCommerce.refusals) {
    let missing = contradiction(refusal);
    for (const said of [refusal, ...(refusal.postType === undefined ? [] : [refusal.postType])]) {
      if (missing !== null) break;
      const source = await fileOf(said.file);
      if (source === null) missing = `no file ${said.file}`;
      else if (!collapsed(source).includes(said.statement)) missing = `no "${said.statement}"`;
    }
    facts.push({
      fact:
        refusal.status === null
          ? `WooCommerce ${release} lists a cart's errors under ${refusal.code}`
          : `WooCommerce ${release} refuses with ${refusal.code}, HTTP ${refusal.status}, "${refusal.message}"`,
      source: at(refusal.file),
      recorded: `${recorded}: ${refusal.statement}`,
      missing,
    });
  }

  // A release GitHub holds none of the files for is one it has no tag for yet.
  if ([...files.values()].every((one) => one === null)) {
    throw new Unanswered(`GitHub holds none of the recorded files at ${at("")}`);
  }
  return facts;
};

const woo = async (): Promise<void> => {
  const { release, repository } = wooCommerce;
  await checking(
    `The facts recorded from WooCommerce ${release}`,
    `${repository}${release}/`,
    async () => {
      for (const one of await wooFactsAt(release)) {
        say({
          outcome: one.missing === null ? "holds" : "changed",
          fact: one.fact,
          source: one.source,
          recorded: one.recorded,
          live: `${now()}: ${one.missing ?? "the same"}`,
        });
      }
    },
  );

  const newest = "The newest WooCommerce release keeps every recorded fact";
  await checking(newest, WOO_RELEASES, async () => {
    const text = await read(WOO_RELEASES);
    const latest =
      text === null ? undefined : jsonOf<{ version?: string }>(text, WOO_RELEASES).version;
    if (latest === undefined) throw new Unanswered(`${WOO_RELEASES} named no version`);
    if (latest === release) {
      say({
        outcome: "holds",
        fact: `WooCommerce ${release}, the recorded release, is the newest`,
        source: WOO_RELEASES,
        recorded: release,
        live: `${now()}: ${latest}`,
      });
      return;
    }
    const broken = (await wooFactsAt(latest)).filter((one) => one.missing !== null);
    for (const one of broken) {
      say({
        outcome: "changed",
        fact: one.fact,
        source: one.source,
        recorded: one.recorded,
        live: `${now()}: ${one.missing}`,
      });
    }
    if (broken.length === 0) {
      say({
        outcome: "notice",
        fact: `WooCommerce ${latest} is out, and every recorded fact holds in it`,
        source: WOO_RELEASES,
        recorded: release,
        live: `${now()}: ${latest}; the recording stays at ${release} until a person moves it`,
      });
    }
  });
};

const REGISTRY = "https://registry.npmjs.org";

const GATEWAY_PINS = (
  JSON.parse(
    readFileSync(new URL("../../../apps/gateway/package.json", import.meta.url), "utf8"),
  ) as { dependencies: Record<string, string> }
).dependencies;

/** Codes of the payment schemes, networks and transfer methods the gateway does not offer. */
const OTHER_PAYMENTS = /permit2|erc20_approval|eip2612|batch_settlement|upto|solana|svm|siwx/;

const readingOf = (code: string): string => {
  const reading = readRefusal(code);
  if ("noVerdict" in reading) return `no verdict, ${reading.noVerdict}`;
  return reading.refused === "unrecognised" ? "unrecognised" : `refused, ${reading.refused}`;
};

const TABLE = new URL("../../../apps/gateway/src/adapters/x402/refusal-codes.ts", import.meta.url);

const TABLE_CODES = [...readFileSync(TABLE, "utf8").matchAll(/"([a-z0-9_]+)"/g)]
  .map(([, code]) => code ?? "")
  .filter((code) => readingOf(code) !== "unrecognised");

/** The file at `path` in a gzipped tar, as npm packs a package. */
const fileInTarball = (tgz: Buffer, path: string): string | null => {
  const tar = gunzipSync(tgz);
  let named: string | undefined;
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (from: number, to: number) =>
      header
        .subarray(from, to)
        .toString("utf8")
        .replace(/\0[\s\S]*$/, "");
    const size = Number.parseInt(field(124, 136).trim() || "0", 8);
    const body = tar.subarray(at + 512, at + 512 + size);
    const prefix = field(345, 500);
    const name = named ?? (prefix === "" ? field(0, 100) : `${prefix}/${field(0, 100)}`);
    named = undefined;
    // A POSIX extended header carries a long path for the entry after it.
    if (field(156, 157) === "x") named = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString())?.[1];
    else if (name === path) return body.toString("utf8");
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
};

/**
 * The codes `list` declares in `text`: an object of codes in Coinbase's
 * generated client, or the constants of one source file inside a source map.
 */
const codesIn = (text: string, file: string, list: string): readonly string[] | null => {
  if (file.endsWith(".map")) {
    const map = JSON.parse(text) as { sources: string[]; sourcesContent?: (string | null)[] };
    const source = map.sourcesContent?.[map.sources.findIndex((one) => one.endsWith(list))];
    if (typeof source !== "string") return null;
    return [...source.matchAll(/export const \w+\s*=\s*"([^"]+)"/g)].map(([, code]) => code ?? "");
  }
  const block = new RegExp(`export const ${list} = \\{([\\s\\S]*?)\\n\\} as const;`).exec(
    text,
  )?.[1];
  return block === undefined ? null : [...block.matchAll(/:\s*"([^"]+)"/g)].map(([, c]) => c ?? "");
};

/** The package's file at `version`, or null where npm has no such version. */
const packedFile = async (name: string, version: string, file: string): Promise<string | null> => {
  const at = `${REGISTRY}/${name}/${version}`;
  const manifest = await read(at);
  if (manifest === null) return null;
  const tarball = jsonOf<{ dist?: { tarball?: string } }>(manifest, at).dist?.tarball;
  if (tarball === undefined) throw new Unanswered(`npm named no tarball for ${name}@${version}`);
  const answered = await get(tarball);
  if (!answered.ok) throw new Unanswered(`${tarball} answered HTTP ${answered.status}`);
  const packed = Buffer.from(await answered.arrayBuffer());
  try {
    return fileInTarball(packed, file);
  } catch {
    throw new Unanswered(`${tarball} answered with something that is not a gzipped tarball`);
  }
};

const facilitator = async (): Promise<void> => {
  const verifying = new Set<string>();
  const awaiting = new Set<string>();
  for (const vocabulary of facilitatorRefusals.packages) {
    const { package: name, version, file, lists, settlement, awaitingDecision } = vocabulary;
    const at = `${REGISTRY}/${name}/${version}`;
    for (const [list, codes] of Object.entries(lists)) {
      if (!settlement.includes(list)) for (const code of codes) verifying.add(code);
    }
    for (const known of awaitingDecision) awaiting.add(known.code);

    say({
      outcome: GATEWAY_PINS[name] === version ? "holds" : "changed",
      fact: `The gateway pins ${name} at the recorded version`,
      source: "apps/gateway/package.json",
      recorded: version,
      live: GATEWAY_PINS[name] ?? "not a dependency",
    });

    await checking(`${name}@${version} names the recorded refusal codes`, at, async () => {
      const text = await packedFile(name, version, file);
      for (const [list, codes] of Object.entries(lists)) {
        const live = text === null ? null : codesIn(text, file, list);
        say({
          outcome:
            live !== null && without(live, codes).length + without(codes, live).length === 0
              ? "holds"
              : "changed",
          fact: `${name}@${version} names these ${codes.length} refusal codes in ${list}`,
          source: `${at}, ${file}`,
          recorded: `${facilitatorRefusals.readAt}: ${codes.length} codes`,
          live:
            live === null
              ? `${now()}: ${text === null ? "npm has no such version or file" : "the file declares no such list"}`
              : `${now()}: ${live.length} codes; added ${listed(without(live, codes))}; dropped ${listed(without(codes, live))}`,
        });
      }
    });

    const fact = `The newest ${name} adds no verification code the gateway's table cannot read, and drops none it reads`;
    const latestAt = `${REGISTRY}/${name}/latest`;
    await checking(fact, latestAt, async () => {
      const manifest = await read(latestAt);
      const latest =
        manifest === null ? undefined : jsonOf<{ version?: string }>(manifest, latestAt).version;
      if (latest === undefined) throw new Unanswered(`npm named no latest version of ${name}`);
      const text = latest === version ? null : await packedFile(name, latest, file);
      const newestIn = (list: string): readonly string[] => {
        if (latest === version) return lists[list] ?? [];
        const codes = text === null ? null : codesIn(text, file, list);
        if (codes === null)
          throw new Unanswered(`${name}@${latest} declares no ${list} in ${file}`);
        return codes;
      };

      const failing: string[] = [];
      const waiting: string[] = [];
      const noted: string[] = [];
      for (const [list, codes] of Object.entries(lists)) {
        const settles = settlement.includes(list);
        const newest = newestIn(list);
        // A settlement refusal is never read by the table, so its reading is not shown.
        const told = (change: string, code: string, reading: string) =>
          `${list} ${change} ${code}${settles ? "" : ` (${reading})`}`;
        for (const code of without(newest, codes)) {
          const reading = readingOf(code);
          const said = told("adds", code, reading);
          if (settles || reading !== "unrecognised" || OTHER_PAYMENTS.test(code)) noted.push(said);
          else if (!awaiting.has(code)) failing.push(said);
        }
        for (const code of without(codes, newest)) {
          const reading = readingOf(code);
          const said = told("drops", code, reading);
          (settles || reading === "unrecognised" ? noted : failing).push(said);
        }
      }
      for (const known of awaitingDecision) {
        const reading = readingOf(known.code);
        if (reading !== "unrecognised") {
          noted.push(`${known.code} awaits a decision, and the table now reads it (${reading})`);
        } else if (!newestIn(known.list).includes(known.code)) {
          noted.push(`${known.code} awaits a decision, and ${known.list} no longer names it`);
        } else {
          waiting.push(
            `${known.list} names ${known.code} (unrecognised), first seen in ${known.seenIn} on ${known.seenOn}`,
          );
        }
      }

      say({
        outcome: failing.length === 0 ? "holds" : "changed",
        fact,
        source: latestAt,
        recorded: version,
        live: `${now()}: ${latest}${failing.length === 0 ? "" : `; ${failing.join("; ")}`}`,
      });
      if (waiting.length > 0) {
        say({
          outcome: "notice",
          fact: `The newest ${name} adds verification codes the gateway's table cannot read, awaiting the product owner's decision`,
          source: latestAt,
          recorded: version,
          live: `${now()}: ${latest}; ${waiting.join("; ")}`,
        });
      }
      if (noted.length > 0) {
        say({
          outcome: "notice",
          fact: `The newest ${name} also changes codes the gateway reads, keeps unknown at settlement or leaves alone`,
          source: latestAt,
          recorded: version,
          live: `${now()}: ${latest}; ${noted.join("; ")}`,
        });
      }
    });
  }

  const unnamed = without(TABLE_CODES, [...verifying]);
  const unread = [...verifying].filter(
    (code) =>
      !OTHER_PAYMENTS.test(code) && !awaiting.has(code) && readingOf(code) === "unrecognised",
  );
  if (unnamed.length + unread.length > 0) {
    say({
      outcome: "notice",
      fact: "The gateway's refusal table and the recorded verification codes differ",
      source: "apps/gateway/src/adapters/x402/refusal-codes.ts",
      recorded: `named by the recorded versions at verification and read as unrecognised: ${listed(unread)}`,
      live: `read by the gateway's table and named by no recorded verification list: ${listed(unnamed)}`,
    });
  }
};

await coinbase();
await woo();
await facilitator();

const count = (outcome: Outcome) => findings.filter((one) => one.outcome === outcome).length;
console.log(
  `${count("holds")} hold, ${count("changed")} changed, ${count("could not check")} could not be checked, ${count("notice")} to note`,
);
process.exitCode = count("changed") > 0 ? 1 : count("could not check") > 0 ? 2 : 0;

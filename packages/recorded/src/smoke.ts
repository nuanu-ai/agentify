/**
 * `pnpm smoke:recorded`: whether the services Agentify does not run still
 * answer as `@agentify/recorded` says they were seen to. It makes a few public
 * GET requests to each service, with no key and no sign-in, and spends
 * nothing.
 *
 * For Coinbase's public exchange rates it checks which of the currencies
 * WooCommerce offers a shop Coinbase rates one US dollar in, and the shape of
 * its answer for a base currency it does not know. For WooCommerce it checks
 * that each recorded statement, and the list of currencies, is in the source
 * of the recorded release on GitHub. For the payment facilitator it reads the
 * recorded refusal codes again from the npm tarballs of the versions the
 * gateway pins, and holds the newest published versions against the gateway's
 * refusal table in both directions: a code they add that the table cannot
 * read, and a code the table reads that they drop.
 *
 * It leaves alone the rates themselves, which move; the other currencies and
 * tokens Coinbase lists, which come and go and are reported without failing;
 * a newer WooCommerce release or package version as such, which is reported
 * so that a person decides when to move a recording to it; every live shop,
 * since WooCommerce's source is read instead; WordPress's own codes; the
 * facilitator's answers over HTTP, which need its key; and refusal codes of
 * the payment schemes, networks and transfer methods the gateway does not
 * offer. Codes the recorded versions already name and the table cannot read
 * are reported without failing, because reading one is a decision about the
 * product. It finds the table's codes among the string literals of its source
 * file, so a code moved to another file goes unseen.
 *
 * It exits 1 when a recorded fact no longer holds, and 2 when none changed but
 * something could not be checked. A service that does not answer is never
 * read as a change.
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

const get = async (url: string): Promise<Response> => {
  let answered: Response;
  try {
    answered = await fetch(url, { signal: AbortSignal.timeout(ANSWERS_WITHIN_MS) });
  } catch (error) {
    throw new Unanswered(`${url} did not answer: ${(error as Error).message}`);
  }
  if (answered.status === 429 || answered.status >= 500) {
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

/** The codes `body` rates one US dollar in, or why it is not the shape the dashboard reads. */
const ratedIn = (body: string): readonly string[] | string => {
  let answer: { data?: { currency?: unknown; rates?: unknown } };
  try {
    answer = JSON.parse(body);
  } catch {
    return "it is not JSON";
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

const shapeOf = (status: number, body: string): string => {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return `HTTP ${status}, not JSON`;
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
    if (typeof recorded === "string") throw new Error(`the recorded answer: ${recorded}`);
    const answered = await get(coinbaseRates.url);
    const live = answered.ok ? ratedIn(await answered.text()) : `HTTP ${answered.status}`;
    const recordedLine = `${coinbaseRates.readAt.toISOString()}: ${listed(without(SHOP_CURRENCIES, recorded))}`;
    if (typeof live === "string") {
      say({
        outcome: "changed",
        fact: rated,
        source: coinbaseRates.url,
        recorded: recordedLine,
        live: `${now()}: the answer is not the recorded shape, ${live}`,
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
    const recorded = shapeOf(coinbaseUnknownBase.status, coinbaseUnknownBase.body);
    const live = shapeOf(answered.status, body);
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

const woo = async (): Promise<void> => {
  const { release, source } = wooCommerce;
  const files = new Map<string, Promise<string | null>>();
  const fileOf = (file: string): Promise<string | null> => {
    const known = files.get(file) ?? read(`${source}${file}`);
    files.set(file, known);
    return known;
  };

  const { currencies } = wooCommerce;
  const offered = `WooCommerce ${release} offers a shop these ${currencies.codes.length} currencies`;
  await checking(offered, `${source}${currencies.file}`, async () => {
    const text = await fileOf(currencies.file);
    const live =
      text === null
        ? []
        : [...text.matchAll(/^\s*'([A-Z]{3})'\s*=>/gm)].map(([, code]) => code ?? "");
    const added = without(live, currencies.codes);
    const dropped = without(currencies.codes, live);
    say({
      outcome: added.length + dropped.length === 0 ? "holds" : "changed",
      fact: offered,
      source: `${source}${currencies.file}`,
      recorded: `${wooCommerce.readAt}: ${currencies.codes.length} currencies`,
      live:
        text === null
          ? `${now()}: no such file in ${release}`
          : `${now()}: ${live.length} currencies; added ${listed(added)}; dropped ${listed(dropped)}`,
    });
  });

  for (const refusal of wooCommerce.refusals) {
    const fact =
      refusal.status === null
        ? `WooCommerce ${release} lists a cart's errors under ${refusal.code}`
        : `WooCommerce ${release} refuses with ${refusal.code}, HTTP ${refusal.status}, "${refusal.message}"`;
    const at = `${source}${refusal.file}`;
    await checking(fact, at, async () => {
      const recorded = `${wooCommerce.readAt}: ${refusal.statement}`;
      const contradicted = contradiction(refusal);
      if (contradicted !== null) {
        say({ outcome: "changed", fact, source: at, recorded, live: contradicted });
        return;
      }
      for (const said of [refusal, ...(refusal.postType === undefined ? [] : [refusal.postType])]) {
        const text = await fileOf(said.file);
        if (text === null || !collapsed(text).includes(said.statement)) {
          const missing = text === null ? `no file ${said.file}` : `no "${said.statement}"`;
          say({ outcome: "changed", fact, source: at, recorded, live: `${now()}: ${missing}` });
          return;
        }
      }
      say({ outcome: "holds", fact, source: at, recorded, live: `${now()}: the same statement` });
    });
  }

  const newest = `WooCommerce ${release} is the newest release`;
  await checking(newest, WOO_RELEASES, async () => {
    const text = await read(WOO_RELEASES);
    const version = text === null ? undefined : (JSON.parse(text) as { version?: string }).version;
    if (version === undefined) throw new Unanswered(`${WOO_RELEASES} named no version`);
    say({
      outcome: version === release ? "holds" : "notice",
      fact: newest,
      source: WOO_RELEASES,
      recorded: release,
      live:
        version === release
          ? `${now()}: ${version}`
          : `${now()}: ${version} is out; the recording stays at ${release} until a person moves it`,
    });
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
  const manifest = await read(`${REGISTRY}/${name}/${version}`);
  if (manifest === null) return null;
  const tarball = (JSON.parse(manifest) as { dist?: { tarball?: string } }).dist?.tarball;
  if (tarball === undefined) throw new Unanswered(`npm named no tarball for ${name}@${version}`);
  const answered = await get(tarball);
  if (!answered.ok) throw new Unanswered(`${tarball} answered HTTP ${answered.status}`);
  return fileInTarball(Buffer.from(await answered.arrayBuffer()), file);
};

const facilitator = async (): Promise<void> => {
  const named = new Set<string>();
  for (const vocabulary of facilitatorRefusals.packages) {
    const { package: name, version, file, lists } = vocabulary;
    const at = `${REGISTRY}/${name}/${version}`;
    for (const codes of Object.values(lists)) for (const code of codes) named.add(code);

    const pinned = `The gateway pins ${name} at the recorded version`;
    say({
      outcome: GATEWAY_PINS[name] === version ? "holds" : "changed",
      fact: pinned,
      source: "apps/gateway/package.json",
      recorded: version,
      live: GATEWAY_PINS[name] ?? "not a dependency",
    });

    await checking(`${name}@${version} names the recorded refusal codes`, at, async () => {
      const text = await packedFile(name, version, file);
      for (const [list, codes] of Object.entries(lists)) {
        const fact = `${name}@${version} names these ${codes.length} refusal codes in ${list}`;
        const live = text === null ? null : codesIn(text, file, list);
        say({
          outcome:
            live !== null && without(live, codes).length + without(codes, live).length === 0
              ? "holds"
              : "changed",
          fact,
          source: `${at}, ${file}`,
          recorded: `${facilitatorRefusals.readAt}: ${codes.length} codes`,
          live:
            live === null
              ? `${now()}: ${text === null ? "npm has no such version or file" : "the file declares no such list"}`
              : `${now()}: ${live.length} codes; added ${listed(without(live, codes))}; dropped ${listed(without(codes, live))}`,
        });
      }
    });

    const newest = `The newest ${name} names no refusal code the gateway's table cannot read, and drops none it reads`;
    await checking(newest, `${REGISTRY}/${name}/latest`, async () => {
      const manifest = await read(`${REGISTRY}/${name}/latest`);
      const latest =
        manifest === null ? undefined : (JSON.parse(manifest) as { version?: string }).version;
      if (latest === undefined) throw new Unanswered(`npm named no latest version of ${name}`);
      if (latest === version) {
        say({
          outcome: "holds",
          fact: newest,
          source: `${REGISTRY}/${name}/latest`,
          recorded: version,
          live: `${now()}: ${latest}, the recorded version`,
        });
        return;
      }
      const text = await packedFile(name, latest, file);
      const drift: string[] = [];
      const beside: string[] = [];
      for (const [list, codes] of Object.entries(lists)) {
        const live = text === null ? null : codesIn(text, file, list);
        if (live === null) throw new Unanswered(`${name}@${latest} declares no ${list} in ${file}`);
        for (const code of without(live, codes)) {
          const reading = readingOf(code);
          const unread = reading === "unrecognised" && !OTHER_PAYMENTS.test(code);
          (unread ? drift : beside).push(`${list} adds ${code} (${reading})`);
        }
        for (const code of without(codes, live)) {
          const reading = readingOf(code);
          (reading === "unrecognised" ? beside : drift).push(`${list} drops ${code} (${reading})`);
        }
      }
      say({
        outcome: drift.length === 0 ? "holds" : "changed",
        fact: newest,
        source: `${REGISTRY}/${name}/latest`,
        recorded: version,
        live: `${now()}: ${latest}${drift.length === 0 ? "" : `; ${drift.join("; ")}`}`,
      });
      if (beside.length > 0) {
        say({
          outcome: "notice",
          fact: `The newest ${name} also changes codes the gateway already reads or leaves alone`,
          source: `${REGISTRY}/${name}/latest`,
          recorded: version,
          live: `${now()}: ${latest}; ${beside.join("; ")}`,
        });
      }
    });
  }

  const unnamed = without(TABLE_CODES, [...named]);
  const unread = [...named].filter(
    (code) => !OTHER_PAYMENTS.test(code) && readingOf(code) === "unrecognised",
  );
  if (unnamed.length + unread.length > 0) {
    say({
      outcome: "notice",
      fact: "The gateway's refusal table and the recorded versions' codes differ",
      source: "apps/gateway/src/adapters/x402/refusal-codes.ts",
      recorded: `named by the recorded versions and read as unrecognised: ${listed(unread)}`,
      live: `read by the gateway's table and named by no recorded version: ${listed(unnamed)}`,
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

/**
 * The dashboard's outbound faults, worked from the host:
 *
 *   pnpm outbound status
 *   pnpm outbound coinbase pass|refuse|silent|log
 *   pnpm outbound mail accept|refuse|silent|read
 *   pnpm outbound restore
 *
 * Each command talks to the stand-in's control port, 127.0.0.1:8789 unless
 * `--port` names another. `serve` is what the stand-in's container runs; the
 * stack it belongs to is laid out in `packages/slice/outbound/compose.yaml`,
 * and this package's README says how to use both.
 */

import {
  COINBASE_MODES,
  type CoinbaseRequest,
  describeCoinbase,
  describeMail,
  MAIL_MODES,
  type MailPost,
  type StandInState,
  startStandIn,
} from "./outbound-standin.js";

const DEFAULT_PORT = 8789;

const USAGE =
  "usage: pnpm outbound status | coinbase pass|refuse|silent|log | mail accept|refuse|silent|read" +
  " | restore, with --port <control port> when it is not 8789";

const counted = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

const describeState = (state: StandInState): string =>
  `Coinbase: ${state.coinbase}, ${counted(state.coinbaseRequests, "request")} recorded. ` +
  `Mail: ${state.mail}, ${counted(state.mailPosts, "post")} recorded.`;

const serve = async (): Promise<void> => {
  const standIn = await startStandIn({
    coinbaseUpstream: new URL("https://api.coinbase.com"),
    coinbasePort: 8080,
    mailPort: 8081,
    controlPort: DEFAULT_PORT,
    host: "0.0.0.0",
    say: (line) => console.log(line),
  });
  console.log(
    "outbound stand-in: Coinbase passes to https://api.coinbase.com, mail is accepted and kept" +
      " here; nothing is sent to any mail provider",
  );
  const stop = (): void => {
    void standIn.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
};

const control = async (port: number, method: "GET" | "POST", path: string): Promise<unknown> => {
  const address = `http://127.0.0.1:${port}${path}`;
  let answer: Response;
  try {
    answer = await fetch(address, { method });
  } catch {
    throw new Error(
      `Nothing answers at 127.0.0.1:${port}. Start the stack with packages/slice/outbound/compose.yaml` +
        " laid over compose.yaml, or name the stand-in's published port with --port.",
    );
  }
  let body: unknown;
  try {
    body = await answer.json();
  } catch {
    throw new Error(
      `Something at 127.0.0.1:${port} answered ${answer.status} without the stand-in's JSON; it is not the stand-in's control port.`,
    );
  }
  if (!answer.ok) {
    const why = (body as { error?: unknown }).error;
    throw new Error(typeof why === "string" ? why : `the stand-in answered ${answer.status}`);
  }
  return body;
};

const run = async (args: readonly string[]): Promise<string> => {
  const words = [...args];
  let port = DEFAULT_PORT;
  const flag = words.indexOf("--port");
  if (flag !== -1) {
    const given = words[flag + 1] ?? "";
    port = Number(given);
    if (!/^\d+$/.test(given) || port < 1 || port > 65_535) {
      throw new Error("--port takes the stand-in's published control port, from 1 to 65535");
    }
    words.splice(flag, 2);
  }
  const [command, word, ...rest] = words;
  if (rest.length > 0) throw new Error(USAGE);

  if (command === "status" && word === undefined) {
    return describeState((await control(port, "GET", "/status")) as StandInState);
  }
  if (command === "restore" && word === undefined) {
    return describeState((await control(port, "POST", "/restore")) as StandInState);
  }
  if (command === "coinbase" && word === "log") {
    const record = (await control(port, "GET", "/coinbase")) as CoinbaseRequest[];
    return record.length === 0
      ? "No request has reached api.coinbase.com through the stand-in since it started."
      : record.map(describeCoinbase).join("\n");
  }
  if (
    command === "coinbase" &&
    (COINBASE_MODES as readonly (string | undefined)[]).includes(word)
  ) {
    return describeState((await control(port, "POST", `/coinbase/${word}`)) as StandInState);
  }
  if (command === "mail" && word === "read") {
    const record = (await control(port, "GET", "/mail")) as MailPost[];
    if (record.length === 0) return "No post has reached the mail stand-in since it started.";
    return record
      .map(
        (one) =>
          `${describeMail(one)}\nFrom: ${one.from ?? "(none)"}\n\n${one.text ?? "(no plain text)"}\n`,
      )
      .join("\n");
  }
  if (command === "mail" && (MAIL_MODES as readonly (string | undefined)[]).includes(word)) {
    return describeState((await control(port, "POST", `/mail/${word}`)) as StandInState);
  }
  throw new Error(USAGE);
};

if (process.argv[2] === "serve" && process.argv.length === 3) {
  await serve();
} else {
  try {
    console.log(await run(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

/**
 * The response-cutting proxy between a real upstream on loopback and a raw
 * `node:http` caller, so that what reaches the caller is read byte by byte and
 * a premature end is seen as one. The tester's promise is that a cut lands
 * only after the upstream finished a 2xx answer, lands once and at the phase
 * asked for, and that everything else passes through untouched.
 */

import { spawn } from "node:child_process";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCut } from "./cut-command.js";

/** One request as the upstream received it. */
interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface Upstream {
  readonly url: string;
  readonly received: Received[];
  /** What happened, in order, on both sides of the proxy. */
  readonly events: string[];
  close(): Promise<void>;
}

/** What the caller was left with. */
interface Reply {
  readonly status: number | null;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  /** Whether the answer ended where its own framing said it would. */
  readonly whole: boolean;
  /** The network code the caller got instead of an answer, if it got none. */
  readonly error: string | null;
}

const running: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

const upstream = async (
  answer: (n: number, response: ServerResponse) => void | Promise<void>,
): Promise<Upstream> => {
  const received: Received[] = [];
  const events: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    received.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    const n = received.length;
    response.once("finish", () => events.push(`upstream finished #${n}`));
    await answer(n, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const handle = {
    url: `http://127.0.0.1:${port}`,
    received,
    events,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  running.push(handle);
  return handle;
};

/**
 * Answers in two writes with a pause between them, so a proxy that decided on
 * the headers alone would act before the upstream had finished.
 */
const inTwoParts =
  (status: number, body: string, headers: Record<string, string> = {}) =>
  async (_n: number, response: ServerResponse) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    const half = Math.floor(body.length / 2);
    response.write(body.slice(0, half));
    await pause(30);
    response.end(body.slice(half));
  };

const plainly =
  (status: number, body: string, headers: Record<string, string> = {}) =>
  (_n: number, response: ServerResponse) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(body);
  };

const call = (
  port: number,
  method: string,
  path: string,
  { headers = {}, body = "" }: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> =>
  new Promise((resolve) => {
    let answered = false;
    const request = httpRequest({ host: "127.0.0.1", port, method, path, headers, agent: false });
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (!answered) {
        resolve({
          status: null,
          headers: {},
          body: Buffer.alloc(0),
          whole: false,
          error: error.code ?? error.message,
        });
      }
    });
    request.on("response", (response) => {
      answered = true;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", () => {});
      response.on("close", () =>
        resolve({
          status: response.statusCode ?? null,
          headers: response.headers,
          body: Buffer.concat(chunks),
          whole: response.complete,
          error: null,
        }),
      );
    });
    request.end(body);
  });

const proxy = async (
  to: string,
  rule: readonly string[],
): Promise<{ readonly port: number; readonly log: string[] }> => {
  const log: string[] = [];
  const started = await runCut(["--to", to, "--port", "0", ...rule], (line) => log.push(line));
  if (!started.ok) {
    throw new Error(started.why);
  }
  running.push(started.proxy);
  return { port: started.proxy.port, log };
};

const PURCHASE = '{"answers":{"email":"buyer@example.com"}}';
const PAID = '{"order_id":"ord_4f1c","status":"delivered","goods":{"code":"GIFT-0042"}}';

const purchases = (phase: string, more: readonly string[] = []) => [
  "--method",
  "POST",
  "--path",
  "/x402/*/purchase",
  "--phase",
  phase,
  ...more,
];

describe("a cut before the headers", () => {
  it("lands after the upstream finished its answer, leaves the caller with no status, and lets the next identical request through whole", async () => {
    const up = await upstream(inTwoParts(200, PAID));
    const { port } = await proxy(up.url, purchases("before-headers"));

    const cut = await call(port, "POST", "/x402/itm_7/purchase", { body: PURCHASE });
    up.events.push("caller left without an answer");

    expect(cut.status).toBeNull();
    expect(cut.error).toBe("ECONNRESET");
    expect(up.events).toEqual(["upstream finished #1", "caller left without an answer"]);
    expect(up.received[0]?.body).toBe(PURCHASE);

    const next = await call(port, "POST", "/x402/itm_7/purchase", { body: PURCHASE });

    expect(next.status).toBe(200);
    expect(next.whole).toBe(true);
    expect(next.body.toString("utf8")).toBe(PAID);
    expect(up.received).toHaveLength(2);
  });
});

describe("a cut midway through the body", () => {
  it("gives the caller the status, the headers and exactly half the bytes, then ends early; the next request passes whole", async () => {
    const goods = "g".repeat(1001);
    const up = await upstream(inTwoParts(200, goods, { "x-upstream-says": "kept" }));
    const { port } = await proxy(up.url, purchases("mid-body"));

    const cut = await call(port, "POST", "/x402/itm_7/purchase", { body: PURCHASE });
    up.events.push("caller saw the end");

    expect(cut.status).toBe(200);
    expect(cut.headers["content-length"]).toBe("1001");
    expect(cut.headers["x-upstream-says"]).toBe("kept");
    expect(cut.body.toString("utf8")).toBe("g".repeat(500));
    expect(cut.whole).toBe(false);
    expect(up.events).toEqual(["upstream finished #1", "caller saw the end"]);

    const next = await call(port, "POST", "/x402/itm_7/purchase", { body: PURCHASE });

    expect(next.status).toBe(200);
    expect(next.whole).toBe(true);
    expect(next.body.toString("utf8")).toBe(goods);
  });

  it("passes an empty and a one-byte answer whole and uncounted, and cuts the next one that has a middle", async () => {
    const bodies = ["", "x", '{"ok":true}'];
    const up = await upstream((n, response) => plainly(200, bodies[n - 1] ?? "")(n, response));
    const { port } = await proxy(up.url, purchases("mid-body"));

    const empty = await call(port, "POST", "/x402/itm_7/purchase");
    const oneByte = await call(port, "POST", "/x402/itm_7/purchase");
    const cut = await call(port, "POST", "/x402/itm_7/purchase");

    expect([empty.whole, empty.body.length]).toEqual([true, 0]);
    expect([oneByte.whole, oneByte.body.toString("utf8")]).toEqual([true, "x"]);
    expect([cut.whole, cut.body.toString("utf8")]).toEqual([false, '{"ok"']);
  });
});

describe("which answer is cut", () => {
  it("with --nth 2, cuts the second matching 2xx answer and neither the first nor the third", async () => {
    const up = await upstream(plainly(200, PAID));
    const { port } = await proxy(up.url, purchases("before-headers", ["--nth", "2"]));

    const first = await call(port, "POST", "/x402/itm_7/purchase");
    const second = await call(port, "POST", "/x402/itm_7/purchase");
    const third = await call(port, "POST", "/x402/itm_7/purchase");

    expect([first.status, first.whole]).toEqual([200, true]);
    expect(second.status).toBeNull();
    expect([third.status, third.whole]).toEqual([200, true]);
  });

  it("does not count a refusal: a 402 passes, and the 200 after it is the one cut", async () => {
    const up = await upstream((n, response) =>
      n === 1 ? plainly(402, "{}")(n, response) : plainly(200, PAID)(n, response),
    );
    const { port } = await proxy(up.url, purchases("before-headers"));

    const refused = await call(port, "POST", "/x402/itm_7/purchase");
    const paid = await call(port, "POST", "/x402/itm_7/purchase");

    expect([refused.status, refused.whole, refused.body.toString("utf8")]).toEqual([
      402,
      true,
      "{}",
    ]);
    expect(paid.status).toBeNull();
    expect(up.received).toHaveLength(2);
  });

  it("matches * within one path segment and the method exactly, ignores the query string in matching, and forwards the query under the upstream's base path", async () => {
    const up = await upstream(plainly(200, PAID));
    const { port } = await proxy(`${up.url}/gateway`, purchases("before-headers"));

    const deeper = await call(port, "POST", "/x402/itm_7/extra/purchase");
    const otherMethod = await call(port, "GET", "/x402/itm_7/purchase");
    const cut = await call(port, "POST", "/x402/itm_7/purchase?ref=campaign");

    expect([deeper.status, deeper.whole]).toEqual([200, true]);
    expect([otherMethod.status, otherMethod.whole]).toEqual([200, true]);
    expect(cut.status).toBeNull();
    expect(up.received.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "POST /gateway/x402/itm_7/extra/purchase",
      "GET /gateway/x402/itm_7/purchase",
      "POST /gateway/x402/itm_7/purchase?ref=campaign",
    ]);
  });

  it("does not spend the cut on a caller that left before the answer was complete", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived: () => void = () => {};
    const firstArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const up = await upstream(async (n, response) => {
      if (n === 1) {
        arrived();
        await held;
      }
      plainly(200, PAID)(n, response);
    });
    const { port, log } = await proxy(up.url, purchases("before-headers"));

    const leaving = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/x402/itm_7/purchase",
      agent: false,
    });
    leaving.on("error", () => {});
    leaving.end(PURCHASE);
    await firstArrived;
    leaving.destroy();
    // The proxy runs in this process; the pause gives its socket room to hear
    // the close before the upstream answers.
    await pause(50);
    release();
    while (!log.some((line) => line.includes("#1 "))) {
      await pause(5);
    }

    const next = await call(port, "POST", "/x402/itm_7/purchase");

    expect(up.events).toContain("upstream finished #1");
    expect(next.status).toBeNull();
  });
});

describe("what passes between the caller and the upstream", () => {
  it("carries request and response headers to their ends, and the log names the phase and the order but no header value, body or query", async () => {
    const answers = [
      plainly(200, '{"order_id":"ord_from_answer","goods":"BODY-MARKER-OUT"}', {
        "payment-response": "SECRET-SETTLEMENT",
      }),
      plainly(200, '{"ok":true,"result":"delivered","note":"BODY-MARKER-OUT"}'),
    ];
    const up = await upstream((n, response) => answers[n - 1]?.(n, response));
    const { port, log } = await proxy(up.url, [
      "--method",
      "POST",
      "--path",
      "/v0/orders/*/answer",
      "--phase",
      "mid-body",
    ]);
    const secrets = {
      authorization: "Bearer SECRET-MERCHANT-KEY",
      "payment-signature": "SECRET-SIGNATURE",
    };

    const passed = await call(port, "POST", "/x402/itm_7/purchase?token=SECRET-QUERY", {
      headers: secrets,
      body: '{"address":"BODY-MARKER-IN"}',
    });
    const cut = await call(port, "POST", "/v0/orders/ord_from_path/answer?token=SECRET-QUERY", {
      headers: secrets,
      body: '{"goods":"BODY-MARKER-IN"}',
    });

    expect(up.received[0]?.headers.authorization).toBe(secrets.authorization);
    expect(up.received[0]?.headers["payment-signature"]).toBe(secrets["payment-signature"]);
    expect(up.received[0]?.headers.host).toBe(new URL(up.url).host);
    expect(passed.headers["payment-response"]).toBe("SECRET-SETTLEMENT");
    expect(passed.whole).toBe(true);
    expect(cut.whole).toBe(false);

    const printed = log.join("\n");
    expect(printed).not.toMatch(/SECRET|BODY-MARKER|token=/);
    expect(printed).toContain("ord_from_answer");
    expect(printed).toContain("ord_from_path");
    expect(printed).toContain("mid-body");
    expect(log[0]).toContain(`127.0.0.1:${port}`);
    expect(log[0]).toContain(up.url);
    expect(log[0]).toContain("POST /v0/orders/*/answer");
  });
});

describe("an upstream that gives no whole answer", () => {
  it("answers the caller 502 naming the upstream and the network code", async () => {
    const vacant = await upstream(() => {});
    const to = vacant.url;
    await vacant.close();
    const { port } = await proxy(to, purchases("before-headers"));

    const reply = await call(port, "POST", "/x402/itm_7/purchase");

    expect(reply.status).toBe(502);
    expect(reply.headers["content-type"]).toMatch(/^text\/plain/);
    expect(reply.body.toString("utf8")).toContain(to);
    expect(reply.body.toString("utf8")).toContain("ECONNREFUSED");
  });

  it("does not count an answer the upstream broke off, and cuts the whole one after it", async () => {
    const up = await upstream((n, response) => {
      if (n === 1) {
        response.writeHead(200, { "content-length": "100" });
        response.write("partial");
        setImmediate(() => response.destroy());
        return;
      }
      plainly(200, PAID)(n, response);
    });
    const { port } = await proxy(up.url, purchases("before-headers"));

    const broken = await call(port, "POST", "/x402/itm_7/purchase");
    const cut = await call(port, "POST", "/x402/itm_7/purchase");

    expect(broken.status).toBe(502);
    expect(broken.body.toString("utf8")).toContain("ECONNRESET");
    expect(cut.status).toBeNull();
  });
});

describe("the command line", () => {
  const valid = (): string[] => [
    "--to",
    "http://127.0.0.1:9",
    "--method",
    "POST",
    "--path",
    "/x402/*/purchase",
    "--phase",
    "mid-body",
  ];
  const without = (flag: string): string[] => {
    const argv = valid();
    argv.splice(argv.indexOf(flag), 2);
    return argv;
  };
  const withValue = (flag: string, value: string): string[] => {
    const argv = valid();
    const at = argv.indexOf(flag);
    if (at === -1) {
      return [...argv, flag, value];
    }
    argv[at + 1] = value;
    return argv;
  };

  it.each([
    ["--to is missing", without("--to"), "--to"],
    ["--method is missing", without("--method"), "--method"],
    ["--path is missing", without("--path"), "--path"],
    ["--phase is missing", without("--phase"), "--phase"],
    ["--to is not a URL", withValue("--to", "gateway"), "--to"],
    ["--to is not http or https", withValue("--to", "ftp://127.0.0.1"), "--to"],
    ["--to carries a query", withValue("--to", "http://127.0.0.1/?env=test"), "--to"],
    ["--port is not a number", withValue("--port", "eighty"), "--port"],
    ["--port is out of range", withValue("--port", "70000"), "--port"],
    ["--method is in lower case", withValue("--method", "post"), "--method"],
    ["--path does not start with /", withValue("--path", "x402/*/purchase"), "--path"],
    ["--path carries a query", withValue("--path", "/x402/*/purchase?ref=1"), "--path"],
    ["--phase is neither phase", withValue("--phase", "after-body"), "--phase"],
    ["--nth is zero", withValue("--nth", "0"), "--nth"],
    ["--nth is a fraction", withValue("--nth", "1.5"), "--nth"],
    ["--nth is a word", withValue("--nth", "second"), "--nth"],
    ["--phase is given twice", [...valid(), "--phase", "before-headers"], "--phase"],
    ["--nth has no value", [...valid(), "--nth"], "--nth"],
    ["--port is followed by another flag", [...valid(), "--port", "--nth", "2"], "--port"],
    ["a flag it does not know", [...valid(), "--speed", "1"], "--speed"],
  ])("refuses to start when %s, naming the flag", async (_case, argv, flag) => {
    const started = await runCut(argv, () => {});

    expect(started.ok).toBe(false);
    expect(started.ok ? "" : started.why).toContain(flag);
  });

  it("refuses an upstream with credentials in it without repeating them", async () => {
    const started = await runCut(withValue("--to", "http://tester:hunter2@127.0.0.1:9"), () => {});

    expect(started.ok).toBe(false);
    const why = started.ok ? "" : started.why;
    expect(why).toContain("--to");
    expect(why).not.toContain("hunter2");
  });

  it("refuses a port that is already taken, naming it", async () => {
    const first = await runCut([...valid(), "--port", "0"], () => {});
    if (!first.ok) {
      throw new Error(first.why);
    }
    running.push(first.proxy);

    const second = await runCut([...valid(), "--port", String(first.proxy.port)], () => {});

    expect(second.ok).toBe(false);
    expect(second.ok ? "" : second.why).toContain(String(first.proxy.port));
  });

  it("exits non-zero with the refusal when started with a malformed rule", async () => {
    const ran = await new Promise<{ code: number | null; printed: string }>((resolve, reject) => {
      let printed = "";
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/cut.ts", ...withValue("--phase", "sideways")],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 20_000,
        },
      );
      child.stdout.on("data", (chunk) => {
        printed += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        printed += String(chunk);
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, printed }));
    });

    expect(ran.code).not.toBe(0);
    expect(ran.printed).toContain("--phase");
  });
});

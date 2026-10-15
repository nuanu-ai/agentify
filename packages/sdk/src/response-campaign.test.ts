/** Ordinary SDK responses over loopback; this checks returned consumer values and single-call semantics. */
import { readFileSync, writeFileSync } from "node:fs";
import type { CardInput, WorkerEnvelope } from "@nuanu-ai/agentify-contracts";
import { afterAll, describe, expect, it } from "vitest";
import { AgentifyError, ANSWER_NOT_UNDERSTOOD, createClient } from "./client.js";
import { contractVersion } from "./contract.js";
import { type GatewayAnswer, startFakeGateway } from "./testing/fake-gateway.js";
import { batch, polling } from "./testing/worker-stream.js";
import { WORKER_PROBLEM_KINDS, type WorkerProblem } from "./worker.js";

const example = JSON.parse(
  readFileSync(
    new URL("../../../apps/docs/examples/card/access-monthly.json", import.meta.url),
    "utf8",
  ),
) as CardInput;
const routes = [
  "publish_card",
  "get_order",
  "list_orders",
  "deliver_order",
  "refuse_order",
  "accept_order",
] as const;
type Route = (typeof routes)[number];
const inputs = [
  "order-1",
  "SKU 100/1",
  "Заказ-17",
  "café",
  "cafe\u0301",
  `order-${"x".repeat(250)}`,
] as const;
const classes = [
  "success",
  "route-refusal",
  "envelope-retryable",
  "envelope-final",
  "malformed-json",
  "wrong-document",
  "503-document",
  "empty-body",
  "truncated-json",
  "429-envelope",
] as const;
type ResponseClass = (typeof classes)[number];
const at = "2026-08-26T10:20:00Z";
const report = {
  subject: "e11fef741e875ef6f9c42465a6b27577dd2921a1",
  cases: [] as {
    caseId: string;
    route: string;
    responseClass: string;
    inputIndex: number;
    httpCalls: number;
    observation: string;
    result: "passed";
  }[],
  workerCases: [] as {
    caseId: string;
    deliveredSubjects: string[];
    polls: number;
    answers: number;
    problems: string[];
  }[],
};

const readRoute = (route: Route): boolean => route === "get_order" || route === "list_orders";
const order = (id: string) => ({
  id,
  merchant_item_id: "access-monthly",
  params: {},
  price: { amount: "5.00", currency: "USD", at, as_of: at },
  test: true,
  status: "in_progress",
});
function success(route: Route, id: string): unknown {
  switch (route) {
    case "publish_card":
      return { ok: true, id };
    case "get_order":
      return order(id);
    case "list_orders":
      return { orders: [order(id)] };
    case "accept_order":
      return { ok: true };
    case "refuse_order":
      return { ok: true, result: "refused" };
    case "deliver_order":
      return { ok: true, result: "delivered" };
  }
}
const refusal = {
  code: "order_already_closed",
  message: "This order is already closed.",
  retryable: false,
};
function response(route: Route, kind: ResponseClass, id: string): GatewayAnswer {
  switch (kind) {
    case "success":
      return { body: success(route, id) };
    case "503-document":
      return { status: 503, body: success(route, id) };
    case "route-refusal":
      return readRoute(route)
        ? { status: 404, body: { error: refusal } }
        : {
            body: {
              ok: false,
              error:
                route === "publish_card"
                  ? {
                      code: "card_rejected",
                      retryable: false,
                      message: "This card cannot be published.",
                      problems: [
                        { path: ["title"], code: "invalid", message: "Provide the product title." },
                      ],
                    }
                  : refusal,
            },
          };
    case "envelope-retryable":
      return {
        status: 503,
        body: { error: { code: "temporarily_busy", message: "Try again later.", retryable: true } },
      };
    case "envelope-final":
      return { status: 409, body: { error: refusal } };
    case "429-envelope":
      return {
        status: 429,
        body: { error: { code: "temporarily_busy", message: "Try again later.", retryable: true } },
      };
    case "malformed-json":
      return { text: "This response is temporarily unavailable." };
    case "wrong-document":
      return { text: JSON.stringify({ items: [] }) };
    case "empty-body":
      return { text: "" };
    case "truncated-json":
      return { text: '{"ok":true,"result":' };
  }
}

describe("SDK complete response matrix", () => {
  for (const route of routes)
    for (const kind of classes)
      for (const [inputIndex, id] of inputs.entries()) {
        it(`${route}/${kind}/${inputIndex}`, async () => {
          const gateway = await startFakeGateway({
            apiKey: "local-response-campaign",
            routes: {
              [route]: () => response(route, kind, id),
            },
          });
          try {
            const client = createClient({
              apiKey: "local-response-campaign",
              baseUrl: gateway.url,
            });
            const handle = client.orders.forId(id);
            expect(handle.delivered({ access_url: "https://example.com/access" })).toEqual({
              delivered: { access_url: "https://example.com/access" },
            });
            expect(
              handle.refused({ code: "cannot_fulfill", message: "The service is unavailable." }),
            ).toEqual({
              refused: { code: "cannot_fulfill", message: "The service is unavailable." },
            });
            expect(handle.accepted()).toEqual({ accepted: {} });
            expect(gateway.calls).toHaveLength(0);
            const call = () => {
              switch (route) {
                case "publish_card":
                  return client.catalog.publish({ ...example, merchant_item_id: id });
                case "get_order":
                  return client.orders.get(id);
                case "list_orders":
                  return client.orders.list(
                    inputIndex % 3 === 0 ? undefined : { open: inputIndex % 3 === 1 },
                  );
                case "deliver_order":
                  return handle.deliver({ access_url: `https://example.com/access/${inputIndex}` });
                case "refuse_order":
                  return handle.refuse({
                    code: "cannot_fulfill",
                    message: `The service is unavailable (${inputIndex}).`,
                  });
                case "accept_order":
                  return handle.accept();
              }
            };
            let returned: unknown;
            let thrown: unknown;
            try {
              returned = await call();
            } catch (cause) {
              thrown = cause;
            }
            const good = kind === "success" || kind === "503-document";
            const localRefusal = kind === "route-refusal" && !readRoute(route);
            const invalid = [
              "malformed-json",
              "wrong-document",
              "empty-body",
              "truncated-json",
            ].includes(kind);
            const retryable = invalid || kind === "envelope-retryable" || kind === "429-envelope";
            const code = invalid
              ? ANSWER_NOT_UNDERSTOOD
              : retryable
                ? "temporarily_busy"
                : refusal.code;
            const throws = !good && !localRefusal && (readRoute(route) || route === "publish_card");
            if (throws) {
              expect(thrown).toBeInstanceOf(AgentifyError);
              const failure = thrown as AgentifyError;
              expect([failure.route, failure.code, failure.retryable]).toEqual([
                route,
                code,
                retryable,
              ]);
              expect(returned).toBeUndefined();
            } else {
              expect(thrown).toBeUndefined();
              if (good) {
                if (route === "get_order") expect(returned).toMatchObject(order(id));
                else if (route === "list_orders") expect(returned).toMatchObject([order(id)]);
                else expect(returned).toEqual(success(route, id));
              } else if (localRefusal) expect(returned).toEqual(response(route, kind, id).body);
              else expect(returned).toMatchObject({ ok: false, error: { code, retryable } });
            }
            // A returned failure is advice to the merchant, never an implicit retry.
            expect(gateway.calls).toHaveLength(1);
            const received = gateway.calls[0];
            expect(received?.route).toBe(route);
            if (route === "get_order" || (route.endsWith("_order") && route !== "list_orders"))
              expect(received?.params.order_id).toBe(id);
            if (route === "publish_card")
              expect(received?.body).toMatchObject({ merchant_item_id: id });
            if (route === "list_orders")
              expect(received?.query).toEqual(
                inputIndex % 3 === 0 ? {} : { open: inputIndex % 3 === 1 ? "true" : "false" },
              );
            if (route === "deliver_order")
              expect(received?.body).toEqual({
                access_url: `https://example.com/access/${inputIndex}`,
              });
            if (route === "refuse_order")
              expect(received?.body).toEqual({
                code: "cannot_fulfill",
                message: `The service is unavailable (${inputIndex}).`,
              });
            if (route === "accept_order") expect(received?.body).toEqual({});
            report.cases.push({
              caseId: `${route}/${kind}/${inputIndex}`,
              route,
              responseClass: kind,
              inputIndex,
              httpCalls: gateway.calls.length,
              observation: throws ? "AgentifyError" : good ? "success value" : "refusal value",
              result: "passed",
            });
          } finally {
            await gateway.close();
          }
        });
      }
});

function barrier() {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const messageKinds = ["order", "quote_request", "order_event"] as const;
const message = (kind: (typeof messageKinds)[number]): WorkerEnvelope => {
  const common = { id: `envelope-${kind}`, sent_at: at };
  switch (kind) {
    case "order": {
      const { status: _status, ...payload } = order("worker-order-1");
      return { ...common, kind, payload };
    }
    case "quote_request":
      return {
        ...common,
        kind,
        payload: {
          price_id: "worker-price-1",
          merchant_item_id: "access-monthly",
          purpose: "purchase",
          expires_at: "2026-08-26T10:25:00Z",
        },
      };
    case "order_event":
      return {
        ...common,
        kind,
        payload: {
          type: "order.refund_due",
          order_id: "worker-order-1",
          at,
          price: { amount: "5.00", currency: "USD" },
          reason: "deadline_passed",
        },
      };
  }
};

describe("finite worker stop schedules", () => {
  // A parked poll has no delivered message. Duplicating it for every handler
  // and hypothetical suffix would count one observation twenty-four times.
  it("stops a parked poll without pulling work or dispatching a handler", async () => {
    const entered = barrier();
    const answer = barrier();
    const gateway = await startFakeGateway({
      apiKey: "local-worker-campaign",
      routes: {
        poll_worker: async () => {
          entered.resolve();
          await answer.promise;
          return batch(message("order"));
        },
      },
    });
    const client = createClient({ apiKey: "local-worker-campaign", baseUrl: gateway.url });
    const delivered: string[] = [];
    client.on("order", (given) => {
      delivered.push(given.id);
      return given.accepted();
    });
    try {
      await client.start();
      await entered.promise;
      await client.stop();
      answer.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(delivered).toEqual([]);
      expect(gateway.callsTo("poll_worker")).toHaveLength(1);
      report.workerCases.push({
        caseId: "parked-poll",
        deliveredSubjects: delivered,
        polls: 1,
        answers: 0,
        problems: [],
      });
    } finally {
      answer.resolve();
      await client.stop();
      await gateway.close();
    }
  }, 3_000);

  for (const kind of messageKinds)
    for (const behavior of ["success", "throw", "invalid-answer", "rejecting-reporter"] as const)
      for (const phase of ["handler", "answer"] as const)
        for (const suffix of [false, true]) {
          // Events have no answer route. A throwing or invalid order/quote handler
          // also sends no answer. Those are absent cells rather than fake schedules.
          if (
            phase === "answer" &&
            (kind === "order_event" || behavior === "throw" || behavior === "invalid-answer")
          )
            continue;
          it(`${kind}/${behavior}/${phase}/${suffix ? "mixed-suffix" : "alone"}`, async () => {
            const entered = barrier();
            const release = barrier();
            const answering = barrier();
            const finishAnswer = barrier();
            const delivered: string[] = [];
            const problems: WorkerProblem[] = [];
            const first = message(kind);
            const tail = suffix ? messageKinds.filter((other) => other !== kind).map(message) : [];
            const gateway = await startFakeGateway({
              apiKey: "local-worker-campaign",
              routes: {
                poll_worker: polling(batch(first, ...tail)),
                answer_order: async () => {
                  answering.resolve();
                  await finishAnswer.promise;
                  return { body: { ok: true, result: "delivered" } };
                },
                answer_quote: async () => {
                  answering.resolve();
                  await finishAnswer.promise;
                  return { body: { used: true } };
                },
              },
            });
            const client = createClient({ apiKey: "local-worker-campaign", baseUrl: gateway.url });
            const handling = async (subject: string): Promise<void> => {
              delivered.push(subject);
              entered.resolve();
              if (phase === "handler") await release.promise;
              if (
                behavior === "throw" ||
                (behavior === "rejecting-reporter" && kind === "order_event")
              )
                throw new Error("The local handler could not complete.");
            };
            client.on("order", async (given) => {
              await handling(given.id);
              return behavior === "invalid-answer"
                ? (undefined as never)
                : given.delivered({ access_url: "https://example.com/access" });
            });
            client.on("quote", async (given) => {
              await handling(given.price_id);
              return behavior === "invalid-answer"
                ? (undefined as never)
                : given.available({ amount: "5.00", currency: "USD" }, at);
            });
            client.on("event", async (given) => {
              await handling(given.order_id);
              // Events carry no acknowledgement; a JavaScript callback's
              // return value must not be mistaken for an order answer.
              if (behavior === "invalid-answer") return { accepted: {} } as unknown as undefined;
            });
            client.on("problem", (problem) => {
              problems.push(problem);
              if (behavior === "rejecting-reporter")
                return Promise.reject(new Error("The local reporter could not complete."));
            });
            try {
              await client.start();
              await (phase === "handler" ? entered.promise : answering.promise);
              const stopped = client.stop();
              const alsoStopped = client.stop();
              await expect(client.start()).rejects.toThrow(/being stopped/);
              release.resolve();
              await alsoStopped;
              await stopped;
              finishAnswer.resolve();
              await new Promise<void>((resolve) => setImmediate(resolve));
              expect(delivered).toEqual([
                kind === "quote_request" ? "worker-price-1" : "worker-order-1",
              ]);
              expect(gateway.callsTo("poll_worker")).toHaveLength(1);
              const expectedProblem =
                phase === "answer"
                  ? WORKER_PROBLEM_KINDS.ANSWER_FAILED
                  : behavior === "throw" ||
                      (behavior === "rejecting-reporter" && kind === "order_event")
                    ? WORKER_PROBLEM_KINDS.HANDLER_FAILED
                    : behavior === "invalid-answer" && kind !== "order_event"
                      ? WORKER_PROBLEM_KINDS.HANDLER_ANSWER_REFUSED
                      : kind !== "order_event"
                        ? WORKER_PROBLEM_KINDS.ANSWER_FAILED
                        : undefined;
              if (expectedProblem)
                expect(problems.map((problem) => problem.kind)).toContain(expectedProblem);
              if (expectedProblem)
                expect(problems.find((problem) => problem.kind === expectedProblem)?.subject).toBe(
                  delivered[0],
                );
              expect(
                problems.filter((problem) => problem.kind === WORKER_PROBLEM_KINDS.BATCH_ABANDONED),
              ).toHaveLength(suffix ? 1 : 0);
              const answers =
                gateway.callsTo("answer_order").length + gateway.callsTo("answer_quote").length;
              expect(answers).toBe(phase === "answer" ? 1 : 0);
              report.workerCases.push({
                caseId: `${kind}/${behavior}/${phase}/${suffix ? "mixed-suffix" : "alone"}`,
                deliveredSubjects: delivered,
                polls: 1,
                answers,
                problems: problems.map((problem) => problem.kind),
              });
            } finally {
              release.resolve();
              finishAnswer.resolve();
              await client.stop();
              await gateway.close();
            }
          }, 3_000);
        }

  it("keeps the same order handler after stopping and starting again", async () => {
    const handled = [barrier(), barrier()];
    const advance = [barrier(), barrier()];
    let turn = 0;
    const delivered: string[] = [];
    const first = message("order");
    const gateway = await startFakeGateway({
      apiKey: "local-worker-campaign",
      routes: {
        poll_worker: () => ({ body: { contract_version: contractVersion, envelopes: [first] } }),
        answer_order: () => ({ body: { ok: true, result: "accepted" } }),
      },
    });
    const client = createClient({ apiKey: "local-worker-campaign", baseUrl: gateway.url });
    client.on("order", async (given) => {
      const index = turn++;
      delivered.push(given.id);
      handled[index]?.resolve();
      await advance[index]?.promise;
      return given.accepted();
    });
    client.on("problem", () => {});
    try {
      for (let index = 0; index < 2; index += 1) {
        await client.start();
        await handled[index]?.promise;
        const stopping = client.stop();
        advance[index]?.resolve();
        await stopping;
      }
      expect(delivered).toEqual(["worker-order-1", "worker-order-1"]);
      expect(gateway.callsTo("poll_worker")).toHaveLength(2);
      report.workerCases.push({
        caseId: "restart-keeps-handler",
        deliveredSubjects: delivered,
        polls: 2,
        answers: 0,
        problems: [],
      });
    } finally {
      advance.forEach((item) => {
        item.resolve();
      });
      await client.stop();
      await gateway.close();
    }
  }, 3_000);
});

afterAll(() => {
  if (process.env.AGENTIFY_SDK_CAMPAIGN_EVIDENCE)
    writeFileSync(
      process.env.AGENTIFY_SDK_CAMPAIGN_EVIDENCE,
      `${JSON.stringify(report, null, 2)}\n`,
    );
});

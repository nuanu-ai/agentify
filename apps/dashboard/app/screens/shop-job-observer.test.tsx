// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { presentShopJob } from "../../src/shop-job-presentation.js";
import type { ShopJobState, ShopJobView } from "../../src/shop-job-view.js";
import { useShopJob } from "./shop-job-observer.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const job = (status: ShopJobState["status"]): ShopJobView =>
  presentShopJob({
    id: "job-one",
    shopHost: "woo.nuanu.ai",
    revision: 1,
    kind: "check",
    status,
    read: 1,
    total: 1,
    ready: 1,
    published: 0,
    excluded: 0,
    publicationUnknown: null,
    currency: "USD",
    when: { text: "31 Oct 2026 10:00" },
    why: null,
    stopCode: null,
    current: true,
    groups: [],
  });

const started = job("running");

function Watched() {
  const [view] = useShopJob(started, "/shop-job");
  return <p>{view?.status}</p>;
}

it("asks the server about a running job until it ends, and no more after", async () => {
  vi.useFakeTimers();
  const answers = [job("running"), job("running"), job("completed")];
  let asked = 0;
  vi.stubGlobal("fetch", async () => {
    const answer = answers[Math.min(asked, answers.length - 1)];
    asked += 1;
    return Response.json(answer);
  });
  const Stub = createRoutesStub([{ path: "/", Component: Watched }]);
  render(<Stub initialEntries={["/"]} />);
  await act(() => vi.advanceTimersByTimeAsync(3_000));
  expect(asked).toBe(3);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(asked).toBe(3);
});

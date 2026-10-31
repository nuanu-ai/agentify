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

const job = (status: ShopJobState["status"], id = "job-one", revision = 1): ShopJobView =>
  presentShopJob({
    id,
    shopHost: "woo.nuanu.ai",
    revision,
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
  return <p>{view?.id}</p>;
}

it("reads a running job until it ends, then asks only which job is latest until another starts", async () => {
  vi.useFakeTimers();
  const results = [job("running"), job("running"), job("completed", "job-one", 3)];
  let latest = { id: "job-one", revision: 3 };
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    if (url.endsWith("?latest")) return Response.json(latest);
    return Response.json(results.shift() ?? job("completed", latest.id, latest.revision));
  });
  const Stub = createRoutesStub([{ path: "/", Component: Watched }]);
  const shown = render(<Stub initialEntries={["/"]} />);
  const resultsRead = () => asked.filter((url) => !url.endsWith("?latest")).length;
  await act(() => vi.advanceTimersByTimeAsync(3_000));
  expect(resultsRead()).toBe(3);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(resultsRead()).toBe(3);
  expect(asked.length).toBeGreaterThan(3);

  latest = { id: "job-one", revision: 4 };
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(resultsRead()).toBe(4);

  latest = { id: "job-two", revision: 1 };
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(resultsRead()).toBe(5);
  expect(shown.container.textContent).toBe("job-two");
});

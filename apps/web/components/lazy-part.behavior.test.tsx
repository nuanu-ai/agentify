// @vitest-environment jsdom

/**
 * A part whose script loads on its own, fetched ahead where the page knows it
 * will be wanted: a fetch ahead that failed is asked for again when the part
 * is drawn, and a part fetched ahead is drawn at once, with no fallback in
 * between. The reload a part that cannot be fetched at all asks for is held in
 * the browser, by the scanner's Chromium test.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { lazyPart } from "./lazy-part";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

function Shown() {
  return <p>The part</p>;
}

/** Lets whatever a resolved or rejected fetch has queued run. */
const settled = () => act(async () => {});

describe("a part fetched ahead", () => {
  it("is asked for again when drawn after the fetch ahead failed, and drawn without a reload", async () => {
    let asked = 0;
    const Part = lazyPart(() => {
      asked += 1;
      return asked === 1 ? Promise.reject(new Error("not fetched")) : Promise.resolve(Shown);
    });
    Part.preload();
    await settled();

    render(
      <Suspense fallback={null}>
        <Part />
      </Suspense>,
    );

    expect(await screen.findByText("The part")).toBeTruthy();
    expect(asked).toBe(2);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("is drawn the first time it is asked for, with no fallback before it", async () => {
    const Part = lazyPart(() => Promise.resolve(Shown));
    Part.preload();
    await settled();
    let fellBack = false;
    function Fallback() {
      fellBack = true;
      return null;
    }

    render(
      <Suspense fallback={<Fallback />}>
        <Part />
      </Suspense>,
    );

    expect(screen.queryByText("The part")).not.toBeNull();
    expect(fellBack).toBe(false);
  });
});

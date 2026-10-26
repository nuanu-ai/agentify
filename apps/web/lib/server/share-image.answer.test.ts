/**
 * A share's picture costs the process a fraction of a second of its own time
 * to draw, and anyone with the link may ask for it as often as they like. A
 * share's snapshot never changes, so the picture is tagged, a cache holding
 * the tag is told it still has it, and the process keeps a bounded number of
 * pictures it has drawn. Drawing is measured as the process's own processor
 * time, which a picture taken from memory does not spend.
 */

import type { PublicShareSnapshot } from "@agentify/scanner-contracts";
import { describe, expect, it } from "vitest";

import { pictureMemory, sharePictureAnswer } from "./share-image";

const snapshot = (host: string, score = 72): PublicShareSnapshot => ({
  host,
  score,
  level: "ahead_of_market",
  rubric_version: "gtm-v1.0.0",
  generated_at: "2026-10-24T12:00:00.000Z",
});

const ask = (cached?: string) =>
  new Request("https://agentify.ad/api/v1/shares/a-share/image", {
    headers: cached ? { "if-none-match": cached } : {},
  });

/** The answer, and the milliseconds of processor time the process spent on it. */
const timed = async (answering: () => Promise<Response>) => {
  const before = process.cpuUsage();
  const answer = await answering();
  const body = new Uint8Array(await answer.arrayBuffer());
  const spent = process.cpuUsage(before);
  return { answer, body, spent: (spent.user + spent.system) / 1000 };
};

describe("a share's picture, asked for over HTTP", () => {
  it("is tagged, and a cache that holds the tag is told so, with no picture", async () => {
    const shown = snapshot("tagged.example");
    const first = await sharePictureAnswer(ask(), shown);
    const tag = first.headers.get("etag") ?? "";
    const again = await sharePictureAnswer(ask(tag), shown);

    expect(first.status).toBe(200);
    expect(tag).toMatch(/^"[^"]+"$/);
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
    expect(again.headers.get("cache-control")).toBe(first.headers.get("cache-control"));
    expect(await again.text()).toBe("");
  });

  it("is sent whole to a cache holding another share's tag", async () => {
    const other = (await sharePictureAnswer(ask(), snapshot("other.example"))).headers.get("etag");
    const answer = await sharePictureAnswer(ask(other ?? ""), snapshot("this.example"));

    expect(answer.status).toBe(200);
    expect(answer.headers.get("etag")).not.toBe(other);
    expect(answer.headers.get("content-type")).toBe("image/png");
    expect(answer.headers.get("content-disposition")).toBe(
      'attachment; filename="agentify-this.example.png"',
    );
  });

  it("is drawn once, and a second ask is answered with the picture already drawn", async () => {
    const shown = snapshot("drawn-once.example");
    const first = await timed(() => sharePictureAnswer(ask(), shown));
    const second = await timed(() => sharePictureAnswer(ask(), shown));

    expect(Buffer.from(second.body).equals(Buffer.from(first.body))).toBe(true);
    expect(second.spent).toBeLessThan(first.spent / 5);
  });

  it("keeps a bounded number of pictures, drawing again one it let go", async () => {
    const drawn: string[] = [];
    const remembered = pictureMemory(2, async (shown) => {
      drawn.push(shown.host);
      return new Uint8Array(0);
    });
    const ask = (host: string) => remembered(host, snapshot(host));

    await ask("a.example");
    await ask("b.example");
    await ask("a.example");
    await ask("c.example");
    await ask("b.example");
    await ask("a.example");

    // a is kept when asked again; c lets b go, b lets a go, and both are drawn again.
    expect(drawn).toStrictEqual(["a.example", "b.example", "c.example", "b.example", "a.example"]);
  });
});

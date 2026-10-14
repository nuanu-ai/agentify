/**
 * A share's picture is drawn on the server, where no stylesheet applies, so
 * the inks it shares with the site are values of its own; each is held here
 * to the token it copies, so the picture's inks change when the site's do.
 * The picture's ground, its card's white and the tints of its critical and
 * warning tones copy no token and are not held.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { INK } from "./share-image";

const TOKENS = readFileSync(
  fileURLToPath(new URL("../../../../packages/visual/tokens.css", import.meta.url)),
  "utf8",
);

/** The value `tokens.css` gives the token, or undefined where it gives none. */
const token = (name: string): string | undefined =>
  new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\s*;`, "i").exec(TOKENS)?.[1]?.toLowerCase();

describe("a share's picture", () => {
  it.each(Object.entries(INK))("draws its %s ink as the site's token gives it", (name, value) => {
    expect(value.toLowerCase()).toBe(token(name));
  });
});

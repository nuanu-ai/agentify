import { Resvg } from "@resvg/resvg-wasm";

/** The pixels of a generated PNG, decoded independently of its drawing tree. */
export function pngPixels(png: Uint8Array, width: number, height: number): Uint8Array {
  const image = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  const decoder = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="${image}"/></svg>`,
  );
  try {
    const rendered = decoder.render();
    try {
      return new Uint8Array(rendered.pixels);
    } finally {
      rendered.free();
    }
  } finally {
    decoder.free();
  }
}

import { readFileSync } from "node:fs";
import { join } from "node:path";

type ImageFont = Readonly<{
  data: Buffer;
  name: string;
  style: "normal";
  weight: 400 | 500 | 600;
}>;

function loadBrandImageFonts(): ImageFont[] {
  try {
    const modules = join(process.cwd(), "node_modules");
    const human = join(
      modules,
      "@fontsource/schibsted-grotesk/files/schibsted-grotesk-latin-600-normal.woff",
    );
    const mono = join(modules, "@fontsource/ibm-plex-mono/files");
    return [
      {
        name: "Schibsted Grotesk",
        data: readFileSync(human),
        style: "normal",
        weight: 600,
      },
      ...([400, 500, 600] as const).map((weight) => ({
        name: "IBM Plex Mono",
        data: readFileSync(join(mono, `ibm-plex-mono-latin-${weight}-normal.woff`)),
        style: "normal" as const,
        weight,
      })),
    ];
  } catch {
    return [];
  }
}

export const BRAND_IMAGE_FONTS = loadBrandImageFonts();
export const BRAND_IMAGE_HUMAN_FONT = BRAND_IMAGE_FONTS.length ? "Schibsted Grotesk" : "sans-serif";
export const BRAND_IMAGE_MONO_FONT = BRAND_IMAGE_FONTS.length ? "IBM Plex Mono" : "monospace";

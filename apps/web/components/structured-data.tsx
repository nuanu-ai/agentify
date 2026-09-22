export function serializeJsonLd(schema: object): string {
  return JSON.stringify(schema).replace(/</g, "\\u003c");
}

export function StructuredData({ schema }: Readonly<{ schema: object }>) {
  return (
    <script
      // biome-ignore lint/security/noDangerouslySetInnerHtml: a JSON-LD script tag carries text, not markup, and serializeJsonLd escapes the one character that could close it early
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(schema) }}
      type="application/ld+json"
    />
  );
}

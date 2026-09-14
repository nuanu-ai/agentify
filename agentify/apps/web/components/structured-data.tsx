import React from "react";

export function serializeJsonLd(schema: object): string {
  return JSON.stringify(schema).replace(/</g, "\\u003c");
}

export function StructuredData({ schema }: Readonly<{ schema: object }>) {
  return (
    <script
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(schema) }}
      type="application/ld+json"
    />
  );
}

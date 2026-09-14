"use client";

import React from "react";

export const OPEN_PRIVACY_CHOICES_EVENT = "b2a:open-privacy-choices";

export function PrivacyChoicesButton({
  className,
}: Readonly<{ className?: string }>) {
  return (
    <button
      className={className}
      onClick={() =>
        window.dispatchEvent(new Event(OPEN_PRIVACY_CHOICES_EVENT))
      }
      type="button"
    >
      Privacy choices
    </button>
  );
}

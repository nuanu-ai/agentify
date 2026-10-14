import { OPEN_PRIVACY_CHOICES_EVENT } from "./events.js";

/** Opens the banner's preferences, for a visitor who chose already and wants to choose again. */
export function PrivacyChoicesButton({ className }: Readonly<{ className?: string }>) {
  return (
    <button
      className={className}
      onClick={() => window.dispatchEvent(new Event(OPEN_PRIVACY_CHOICES_EVENT))}
      type="button"
    >
      Privacy choices
    </button>
  );
}

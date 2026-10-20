import {
  CONSENT_POLICY_VERSION,
  CONSENT_STORAGE_KEY,
  type ConsentCategories,
  type ConsentSnapshot,
  createConsentSnapshot,
  readCurrentConsent,
  saveConsentDecision,
} from "@agentify/analytics/browser";
import { type KeyboardEvent as KeyPress, useCallback, useEffect, useRef, useState } from "react";
import { CONSENT_CHANGED_EVENT, OPEN_PRIVACY_CHOICES_EVENT } from "./events.js";

const policy = {
  policyVersion: CONSENT_POLICY_VERSION,
  requireOptInForAdsMeasurement: true,
  requireOptInForProductAnalytics: true,
};

/**
 * Run in the page's head before anything is painted: where a choice made
 * under the current policy is kept, a banner its script has not yet read the
 * choice for is hidden. The banner decides for itself once its script runs.
 */
const HIDDEN_WHILE_KEPT = {
  __html: `try{var kept=JSON.parse(localStorage.getItem(${JSON.stringify(CONSENT_STORAGE_KEY)})||"null");if(kept&&kept.policyVersion===${JSON.stringify(CONSENT_POLICY_VERSION)}){var style=document.createElement("style");style.textContent=".consent-banner:not([data-read]){display:none}";document.head.appendChild(style)}}catch(_){}`,
};

/**
 * For the page's head. The banner is drawn on the server for every visitor,
 * since only the browser knows whether they chose; this keeps a visitor who
 * already chose from seeing it flash up while the page's script loads.
 */
export function KeptChoiceScript() {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: this module's own constant, run before the first paint
  return <script dangerouslySetInnerHTML={HIDDEN_WHILE_KEPT} />;
}

/**
 * For a drawing of a page where no script runs, such as the screens gallery:
 * the page as a visitor who has already answered the banner sees it, with the
 * banner out of the way as their browser keeps it.
 */
export function BannerAnswered() {
  return <style>{".consent-banner{display:none}"}</style>;
}

/** Tab and Shift+Tab go round the dialog's own controls, as long as it is open. */
const keepTabInside = (event: KeyPress<HTMLElement>) => {
  if (event.key !== "Tab") return;
  const controls = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      "input:not([disabled]), button:not([disabled]), a[href]",
    ),
  ];
  const at = controls.indexOf(document.activeElement as HTMLElement);
  const next = event.shiftKey
    ? at <= 0
      ? controls.length - 1
      : at - 1
    : (at + 1) % controls.length;
  event.preventDefault();
  controls[next]?.focus();
};

/**
 * Where the focus goes once the banner or its preferences close: back to the
 * control that opened them, or, when that went with the banner, to the page's
 * content, which the next Tab continues from.
 */
const returnFocus = (opener: HTMLElement | null) => {
  if (opener?.isConnected) {
    opener.focus();
    return;
  }
  if (document.activeElement !== null && document.activeElement !== document.body) return;
  const content = document.querySelector<HTMLElement>("main");
  if (content === null) return;
  if (!content.hasAttribute("tabindex")) content.setAttribute("tabindex", "-1");
  content.focus({ preventScroll: true });
};

const decisions = (product: boolean, ads: boolean): Partial<ConsentCategories> => ({
  product_analytics: product,
  ads_measurement: ads,
});

export function ConsentPreferencesPanel(props: {
  productAnalytics: boolean;
  adsMeasurement: boolean;
  saving: boolean;
  error?: string;
  onProductAnalytics: (allowed: boolean) => void;
  onAdsMeasurement: (allowed: boolean) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking outside is a pointer shortcut; Escape and Cancel close the dialog from the keyboard
    <div className="consent-backdrop" role="presentation" onMouseDown={props.onClose}>
      <section
        aria-describedby="consent-description"
        aria-labelledby="consent-title"
        aria-modal="true"
        className="consent-dialog"
        role="dialog"
        onKeyDown={keepTabInside}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="consent-title" tabIndex={-1}>
          Privacy choices
        </h2>
        <p className="consent-copy" id="consent-description">
          Optional measurement is off until you choose otherwise. Your location never changes these
          choices automatically.
        </p>
        <label className="consent-option">
          <input checked disabled type="checkbox" />
          <strong>Essential processing</strong>
          <span>Required to save your preferences and run a scan you request.</span>
        </label>
        <label className="consent-option">
          <input
            checked={props.productAnalytics}
            onChange={(event) => props.onProductAnalytics(event.target.checked)}
            type="checkbox"
          />
          <strong>Product analytics</strong>
          <span>
            Explicit, pseudonymous product events in PostHog. No autocapture or session replay.
          </span>
        </label>
        <label className="consent-option">
          <input
            checked={props.adsMeasurement}
            onChange={(event) => props.onAdsMeasurement(event.target.checked)}
            type="checkbox"
          />
          <strong>Ads measurement</strong>
          <span>
            Allows Meta Pixel and server-side campaign measurement. Scanned sites and report details
            are excluded.
          </span>
        </label>
        {props.error ? (
          <p aria-live="polite" className="consent-error" role="status">
            {props.error}
          </p>
        ) : null}
        <div className="consent-actions">
          <button
            className="button button-primary"
            disabled={props.saving}
            onClick={props.onSave}
            type="button"
          >
            {props.saving ? "Saving…" : "Save choices"}
          </button>
          <button
            className="button button-secondary"
            disabled={props.saving}
            onClick={props.onClose}
            type="button"
          >
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}

/** A choice sent whose answer never came, or could not be read: it may have been recorded. */
class ChoiceUnanswered extends Error {}

/**
 * The bar that asks a visitor how their visit may be measured, until they
 * choose, and the preferences it and the page's "Privacy choices" open. The
 * choice is kept in the browser and recorded by the scanner at
 * `/api/v1/consent`, so one choice holds on every surface of the origin.
 * `brand` names the site in its question. It is drawn with
 * `@agentify/visual/consent.css`, which the page's root imports with its own
 * stylesheets, so the banner adds no stylesheet of its own to a first visit.
 */
export function ConsentBanner({ brand }: Readonly<{ brand: string }>) {
  const [visible, setVisible] = useState(true);
  const [read, setRead] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [productAnalytics, setProductAnalytics] = useState(false);
  const [adsMeasurement, setAdsMeasurement] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const preferencesButton = useRef<HTMLButtonElement>(null);
  const preferencesOpener = useRef<HTMLElement | null>(null);
  const banner = useRef<HTMLElement>(null);

  // The bar is fixed over the bottom of the window, so while it is up the page
  // is padded by its height (@agentify/visual/consent.css): a page no taller than the window
  // can still scroll its last control out from under the bar. The height is
  // measured because it depends on the width the words wrap at.
  useEffect(() => {
    const bar = banner.current;
    if (!visible || !bar || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() =>
      root.style.setProperty("--consent-banner-height", `${bar.offsetHeight}px`),
    );
    observer.observe(bar, { box: "border-box" });
    return () => {
      observer.disconnect();
      root.style.removeProperty("--consent-banner-height");
    };
  }, [visible]);

  const closePreferences = useCallback(() => {
    setPreferencesOpen(false);
    window.requestAnimationFrame(() => returnFocus(preferencesOpener.current));
  }, []);

  // A choice made in another of the site's tabs holds in this one as well.
  useEffect(() => {
    const read = () => {
      const current = readCurrentConsent(window.localStorage);
      setRead(true);
      setVisible(current === undefined);
      if (current === undefined) return;
      setProductAnalytics(current.categories.product_analytics);
      setAdsMeasurement(current.categories.ads_measurement);
    };
    read();
    const kept = (event: StorageEvent) => {
      if (event.key === null || event.key === CONSENT_STORAGE_KEY) read();
    };
    window.addEventListener("storage", kept);
    return () => window.removeEventListener("storage", kept);
  }, []);

  useEffect(() => {
    const open = () => {
      preferencesOpener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPreferencesOpen(true);
    };
    window.addEventListener(OPEN_PRIVACY_CHOICES_EVENT, open);
    return () => window.removeEventListener(OPEN_PRIVACY_CHOICES_EVENT, open);
  }, []);

  useEffect(() => {
    if (!preferencesOpen) return;
    document.getElementById("consent-title")?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePreferences();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [closePreferences, preferencesOpen]);

  const persist = async (snapshot: ConsentSnapshot) => {
    let response: Response;
    try {
      response = await fetch("/api/v1/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policy_version: snapshot.policyVersion,
          categories: snapshot.categories,
        }),
      });
    } catch {
      throw new ChoiceUnanswered();
    }
    if (response.ok) return;
    // Only the site's own refusal, in its error shape, says the choice was not
    // recorded; a proxy's error page in its place says nothing either way.
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: unknown };
    } | null;
    if (typeof body?.error?.message !== "string") throw new ChoiceUnanswered();
    throw new Error("consent_refused");
  };

  const save = async (product: boolean, ads: boolean) => {
    setSaving(true);
    setError(undefined);
    // Set once the site has recorded the choice, which the browser keeping it can still fail after.
    let recorded = false;
    const snapshot = createConsentSnapshot({
      policy,
      decisions: decisions(product, ads),
      source: "banner",
    });
    try {
      await saveConsentDecision({
        storage: window.localStorage,
        snapshot,
        persistAppendOnly: async (choice) => {
          await persist(choice);
          recorded = true;
        },
      });
      setProductAnalytics(product);
      setAdsMeasurement(ads);
      if (preferencesOpen) closePreferences();
      else window.requestAnimationFrame(() => returnFocus(null));
      setVisible(false);
      window.dispatchEvent(new CustomEvent(CONSENT_CHANGED_EVENT, { detail: snapshot }));
    } catch (failure) {
      setError(
        recorded
          ? "Your choices were saved, but this browser would not keep them, so you may be asked again."
          : failure instanceof ChoiceUnanswered
            ? "No answer came back, so we cannot tell whether your choices were saved. Choose again: the choice saved last is the one that holds."
            : "We could not save your choices. No optional analytics were enabled.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {visible ? (
        <aside
          aria-label="Privacy choices"
          className="consent-banner"
          data-read={read ? "" : undefined}
          ref={banner}
        >
          <div className="consent-banner-copy">
            <strong>Choose how {brand} measures this visit</strong>
            <p className="consent-copy">
              Optional analytics stay off unless you allow them. Read our{" "}
              <a href="/privacy">privacy notice</a>.
            </p>
            {error ? (
              <p aria-live="polite" className="consent-error" role="status">
                {error}
              </p>
            ) : null}
          </div>
          <div className="consent-actions">
            <button
              className="button button-primary button-compact"
              disabled={saving}
              onClick={() => void save(true, true)}
              type="button"
            >
              Allow optional analytics
            </button>
            <button
              className="button button-secondary button-compact"
              disabled={saving}
              onClick={() => void save(false, false)}
              type="button"
            >
              Essential only
            </button>
            <button
              className="consent-preferences-link"
              disabled={saving}
              onClick={() => {
                preferencesOpener.current = preferencesButton.current;
                setPreferencesOpen(true);
              }}
              ref={preferencesButton}
              type="button"
            >
              Preferences
            </button>
          </div>
        </aside>
      ) : null}
      {preferencesOpen ? (
        <ConsentPreferencesPanel
          adsMeasurement={adsMeasurement}
          error={error}
          onAdsMeasurement={setAdsMeasurement}
          onClose={closePreferences}
          onProductAnalytics={setProductAnalytics}
          onSave={() => void save(productAnalytics, adsMeasurement)}
          productAnalytics={productAnalytics}
          saving={saving}
        />
      ) : null}
    </>
  );
}

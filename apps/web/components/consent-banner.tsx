"use client";

import {
  CONSENT_POLICY_VERSION,
  type ConsentCategories,
  type ConsentSnapshot,
  createConsentSnapshot,
  readCurrentConsent,
  saveConsentDecision,
} from "@agentify/analytics/browser";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { DISPLAY_BRAND } from "../lib/brand";
import styles from "./consent-banner.module.css";
import { OPEN_PRIVACY_CHOICES_EVENT } from "./privacy-choices-button";

const policy = {
  policyVersion: CONSENT_POLICY_VERSION,
  requireOptInForAdsMeasurement: true,
  requireOptInForProductAnalytics: true,
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
    <div className={styles.backdrop} role="presentation" onMouseDown={props.onClose}>
      <section
        aria-describedby="consent-description"
        aria-labelledby="consent-title"
        aria-modal="true"
        className={styles.dialog}
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="consent-title" tabIndex={-1}>
          Privacy choices
        </h2>
        <p className={styles.copy} id="consent-description">
          Optional measurement is off until you choose otherwise. Your location never changes these
          choices automatically.
        </p>
        <label className={styles.option}>
          <input checked disabled type="checkbox" />
          <strong>Essential processing</strong>
          <span>Required to save your preferences and run a scan you request.</span>
        </label>
        <label className={styles.option}>
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
        <label className={styles.option}>
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
          <p aria-live="polite" className={styles.error} role="status">
            {props.error}
          </p>
        ) : null}
        <div className={styles.actions}>
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

export function ConsentBanner() {
  const pathname = usePathname();
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return null;
  return <ConsentBannerContent />;
}

function ConsentBannerContent() {
  const [visible, setVisible] = useState(true);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [productAnalytics, setProductAnalytics] = useState(false);
  const [adsMeasurement, setAdsMeasurement] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const preferencesButton = useRef<HTMLButtonElement>(null);
  const preferencesOpener = useRef<HTMLElement | null>(null);
  const banner = useRef<HTMLElement>(null);

  // The bar is fixed over the bottom of the window, so while it is up the page
  // is padded by its height (app/globals.css): a page no taller than the window
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
    window.requestAnimationFrame(() => {
      if (preferencesOpener.current?.isConnected) preferencesOpener.current.focus();
    });
  }, []);

  useEffect(() => {
    const current = readCurrentConsent(window.localStorage);
    if (!current || current.policyVersion !== CONSENT_POLICY_VERSION) return;
    setProductAnalytics(current.categories.product_analytics);
    setAdsMeasurement(current.categories.ads_measurement);
    setVisible(false);
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
    const response = await fetch("/api/v1/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        policy_version: snapshot.policyVersion,
        categories: snapshot.categories,
      }),
    });
    if (!response.ok) throw new Error("consent_save_failed");
  };

  const save = async (product: boolean, ads: boolean) => {
    setSaving(true);
    setError(undefined);
    const snapshot = createConsentSnapshot({
      policy,
      decisions: decisions(product, ads),
      source: "banner",
    });
    try {
      await saveConsentDecision({
        storage: window.localStorage,
        snapshot,
        persistAppendOnly: persist,
      });
      setProductAnalytics(product);
      setAdsMeasurement(ads);
      closePreferences();
      setVisible(false);
      window.dispatchEvent(new CustomEvent("agentify:consent-changed", { detail: snapshot }));
    } catch {
      setError("We could not save your choices. No optional analytics were enabled.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {visible ? (
        <aside aria-label="Privacy choices" className={styles.banner} ref={banner}>
          <div className={styles.bannerCopy}>
            <strong>Choose how {DISPLAY_BRAND} measures this visit</strong>
            <p className={styles.copy}>
              Optional analytics stay off unless you allow them. Read our{" "}
              <a href="/privacy">privacy notice</a>.
            </p>
            {error ? (
              <p aria-live="polite" className={styles.error} role="status">
                {error}
              </p>
            ) : null}
          </div>
          <div className={styles.actions}>
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
              className={styles.preferencesLink}
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

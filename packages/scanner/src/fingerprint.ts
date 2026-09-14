import type { FetchArtifact, FingerprintSignal } from "./model.js";

type Detector = { value: string; strong: RegExp[]; weak: RegExp[] };

const PLATFORM_DETECTORS: Detector[] = [
  {
    value: "Shopify",
    strong: [/cdn\.shopify\.com/i, /shopify-section/i],
    weak: [/shopify/i],
  },
  {
    value: "WooCommerce/WordPress",
    strong: [/wp-content\//i, /woocommerce/i],
    weak: [/wp-includes/i, /wordpress/i],
  },
  {
    value: "Magento/Adobe Commerce",
    strong: [/Magento_Ui/i, /mage\/cookies/i],
    weak: [/magento/i],
  },
  {
    value: "Wix",
    strong: [/static\.wixstatic\.com/i, /wix-viewer-model/i],
    weak: [/wix/i],
  },
  {
    value: "Webflow",
    strong: [/data-wf-page=/i, /assets\.website-files\.com/i],
    weak: [/webflow/i],
  },
  {
    value: "Squarespace",
    strong: [/static1\.squarespace\.com/i, /squarespace-cdn/i],
    weak: [/squarespace/i],
  },
];

const WAF_DETECTORS: Detector[] = [
  {
    value: "Cloudflare",
    strong: [/\bcf-ray\b/i, /cloudflare/i],
    weak: [/cf-cache-status/i],
  },
  {
    value: "Akamai",
    strong: [/akamai/i, /akamai-ghost/i],
    weak: [/x-akamai/i],
  },
  {
    value: "Fastly",
    strong: [/\bfastly\b/i, /x-served-by/i],
    weak: [/x-cache-hits/i],
  },
  {
    value: "Vercel",
    strong: [/x-vercel-id/i, /\bvercel\b/i],
    weak: [/_next\/static/i],
  },
  {
    value: "Netlify",
    strong: [/x-nf-request-id/i, /\bnetlify\b/i],
    weak: [/netlify/i],
  },
];

const PSP_DETECTORS: Detector[] = [
  {
    value: "Stripe",
    strong: [/js\.stripe\.com/i, /stripe-js/i],
    weak: [/stripe/i],
  },
  { value: "PayPal", strong: [/paypal\.com\/sdk\/js/i], weak: [/paypal/i] },
  {
    value: "Adyen",
    strong: [/checkoutshopper-.*\.adyen\.com/i, /adyen-checkout/i],
    weak: [/adyen/i],
  },
  {
    value: "Shopify Payments",
    strong: [/shopify_payments/i],
    weak: [/shopify payments/i],
  },
  {
    value: "Square",
    strong: [/web\.squarecdn\.com/i, /squareup\.com\/v1\/square/i],
    weak: [/square payments/i],
  },
];

const corpus = (artifact?: FetchArtifact): string => {
  if (!artifact) return "";
  return `${Object.entries(artifact.headers)
    .map(([key, value]) => `${key}:${value ?? ""}`)
    .join("\n")}\n${artifact.body.slice(0, 524_288)}`;
};

const detect = (
  input: string,
  detector: Detector,
): FingerprintSignal | undefined => {
  const strong = detector.strong
    .filter((pattern) => pattern.test(input))
    .map((pattern) => pattern.source);
  const weak = detector.weak
    .filter((pattern) => pattern.test(input))
    .map((pattern) => pattern.source);
  const count = strong.length + weak.length;
  if (!count) return undefined;
  return {
    value: detector.value,
    confidence: count >= 2 ? "high" : strong.length === 1 ? "medium" : "low",
    signals: [
      ...strong.map((signal) => `strong:${signal}`),
      ...weak.map((signal) => `weak:${signal}`),
    ].slice(0, 5),
  };
};

export const fingerprint = (artifact?: FetchArtifact) => {
  const input = corpus(artifact);
  const platforms = PLATFORM_DETECTORS.map((detector) =>
    detect(input, detector),
  ).filter((result): result is FingerprintSignal => Boolean(result));
  const platform = platforms.sort(
    (left, right) =>
      ({ high: 3, medium: 2, low: 1 })[right.confidence] -
      { high: 3, medium: 2, low: 1 }[left.confidence],
  )[0] ?? { value: "custom/unknown", confidence: "low" as const, signals: [] };
  return {
    detectorVersion: "fingerprint-v1.0.0" as const,
    platform,
    wafCdn: WAF_DETECTORS.map((detector) => detect(input, detector)).filter(
      (result): result is FingerprintSignal => Boolean(result),
    ),
    pspMarkers: PSP_DETECTORS.map((detector) => detect(input, detector)).filter(
      (result): result is FingerprintSignal => Boolean(result),
    ),
  };
};

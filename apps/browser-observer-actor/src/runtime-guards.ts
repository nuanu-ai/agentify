import type { BrowserContext } from "playwright";

export const PASSIVE_BROWSER_ARGS = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-domain-reliability",
  "--disable-features=AutofillServerCommunication,MediaRouter,OptimizationHints,Translate,WebTransport,WebTransportDeveloperMode,WebRtcAllowInputVolumeAdjustment",
  "--disable-sync",
  "--disable-webrtc",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--metrics-recording-only",
  "--no-first-run",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
] as const;

export const BLOCKED_ACTIVE_NETWORK_GLOBALS = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "WebTransport",
  "Worker",
  "SharedWorker",
  "WebSocket",
  "EventSource",
] as const;

const passiveRuntimeGuardScript = `(() => {
  const blocked = ${JSON.stringify(BLOCKED_ACTIVE_NETWORK_GLOBALS)};
  for (const name of blocked) {
    try { Reflect.deleteProperty(globalThis, name); } catch {}
    if (typeof globalThis[name] !== "undefined") {
      try {
        Object.defineProperty(globalThis, name, {
          configurable: false,
          enumerable: false,
          get: () => undefined,
          set: () => undefined,
        });
      } catch {}
    }
  }
})();`;

/** Installs before any document or child-frame script in this context. */
export const installPassiveRuntimeGuards = async (
  context: BrowserContext,
): Promise<void> => {
  await context.addInitScript({ content: passiveRuntimeGuardScript });
};

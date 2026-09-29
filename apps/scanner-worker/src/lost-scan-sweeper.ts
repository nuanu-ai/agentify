// A scan must finish within 55 seconds of being queued, and pg-boss gives a
// job whose worker went quiet one more attempt. A scan that shows no sign of
// life for five minutes has lost its worker and its retry both, and the page
// polling it would wait for ever, so each sweep closes such scans as failed.
export function startLostScanSweeper(input: {
  finishLostScans: (now: Date, lostAfterMs: number) => Promise<string[]>;
  onFinished?: (scanIds: string[]) => void;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  lostAfterMs?: number;
}): () => void {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const finished = await input.finishLostScans(new Date(), input.lostAfterMs ?? 300_000);
      if (finished.length) input.onFinished?.(finished);
    } catch (error) {
      input.onError?.(error);
    } finally {
      running = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), input.intervalMs ?? 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

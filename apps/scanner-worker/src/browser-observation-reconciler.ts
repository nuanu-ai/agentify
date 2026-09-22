import type { BrowserObservationJobV1 } from "@agentify/scanner-contracts";

import type { BrowserObservationRepository } from "./browser-observation-job.js";

export async function reconcileBrowserObservationJobs(input: {
  repository: BrowserObservationRepository;
  enqueue: (job: BrowserObservationJobV1) => Promise<void>;
  now?: Date;
  limit?: number;
}): Promise<number> {
  const jobs = await input.repository.listReconciliationCandidates(input.now, input.limit);
  for (const job of jobs) await input.enqueue(job);
  return jobs.length;
}

export function startBrowserObservationReconciler(input: {
  repository: BrowserObservationRepository;
  enqueue: (job: BrowserObservationJobV1) => Promise<void>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileBrowserObservationJobs(input);
    } catch (error) {
      input.onError?.(error);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), input.intervalMs ?? 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

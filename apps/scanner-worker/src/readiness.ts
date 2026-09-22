import type { WorkerHealth } from "./health.js";

export type WorkerReadinessSnapshot = {
  ready: boolean;
  queueConnected: boolean;
  databaseConnected: boolean;
};

export async function refreshWorkerReadiness(input: {
  health: WorkerHealth;
  probeDatabase: () => Promise<boolean>;
  probeQueue: () => Promise<boolean>;
  writeHeartbeat: (snapshot: WorkerReadinessSnapshot) => Promise<void>;
  now?: () => Date;
  onDatabaseError?: (error: unknown) => void;
  onQueueError?: (error: unknown) => void;
}): Promise<WorkerReadinessSnapshot> {
  try {
    input.health.databaseConnected = await input.probeDatabase();
  } catch (error) {
    input.health.databaseConnected = false;
    input.onDatabaseError?.(error);
  }

  try {
    input.health.queueConnected = await input.probeQueue();
  } catch (error) {
    input.health.queueConnected = false;
    input.onQueueError?.(error);
  }

  input.health.ready = input.health.databaseConnected && input.health.queueConnected;
  const snapshot = {
    ready: input.health.ready,
    queueConnected: input.health.queueConnected,
    databaseConnected: input.health.databaseConnected,
  };

  if (!snapshot.databaseConnected) return snapshot;
  try {
    await input.writeHeartbeat(snapshot);
    input.health.lastHeartbeatAt = (input.now ?? (() => new Date()))().toISOString();
  } catch (error) {
    input.health.databaseConnected = false;
    input.health.ready = false;
    input.onDatabaseError?.(error);
    return {
      ready: false,
      queueConnected: input.health.queueConnected,
      databaseConnected: false,
    };
  }
  return snapshot;
}

import { Actor, log } from "apify";

import { resolveActorBuild, runBrowserObservation } from "./runner.js";

const actorBuild = resolveActorBuild(process.env);
let stage: "initialization" | "input" | "observation" | "output" = "initialization";

const safeErrorMetadata = (
  error: unknown,
): { error_name?: string; error_type?: string; status_code?: number } => {
  if (!error || typeof error !== "object") return {};
  const source = error as Record<string, unknown>;
  const safeIdentifier = (value: unknown): string | undefined =>
    typeof value === "string" && /^[a-z][a-z0-9_.:-]{0,99}$/i.test(value) ? value : undefined;
  const errorName = safeIdentifier(source.name);
  const errorType = safeIdentifier(source.type);
  const statusCode = source.statusCode;
  return {
    ...(errorName ? { error_name: errorName } : {}),
    ...(errorType ? { error_type: errorType } : {}),
    ...(typeof statusCode === "number" && Number.isInteger(statusCode)
      ? { status_code: statusCode }
      : {}),
  };
};

await Actor.init();

try {
  stage = "input";
  const input = await Actor.getInput();
  stage = "observation";
  const output = await runBrowserObservation({
    input,
    actorBuild,
    onRuntimeFailure: (code) => log.warning("browser_observation_runtime_failure", { code }),
  });
  stage = "output";
  await Actor.setValue("OUTPUT", output);
  log.info("browser_observation_finished", {
    operationId: output.operation_id,
    status: output.status,
    pagesAssessed: output.pages_assessed,
  });
} catch (error) {
  log.error("browser_observation_failed", {
    code: "invalid_input_or_runtime",
    stage,
    ...safeErrorMetadata(error),
  });
  process.exitCode = 1;
} finally {
  await Actor.exit({ exitCode: Number(process.exitCode ?? 0) });
}

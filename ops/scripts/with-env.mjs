import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("with-env requires a command");

// Node's native parser keeps the scanner .env.scanner workflow dependency-free. Existing
// CI/hosting variables retain precedence over local file values.
if (existsSync(".env.scanner")) loadEnvFile(".env.scanner");

const child = spawn(command, args, {
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  process.stderr.write(`Unable to start ${command}: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

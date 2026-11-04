import { spawn } from "node:child_process";

export interface ProcessRunOptions {
  binary: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  spawnError?: string;
}

export type ProcessRunner = (options: ProcessRunOptions) => Promise<ProcessRunResult>;

function killProcessTree(pid: number | undefined): void {
  if (!pid) {
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.on("error", () => {});
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already gone.
  }
}

export const defaultProcessRunner: ProcessRunner = (options) => {
  return new Promise<ProcessRunResult>((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(options.binary, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const finish = (exitCode: number, spawnError?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      resolve({
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startedAt,
        timedOut,
        ...(spawnError ? { spawnError } : {})
      });
    };

    const deadline = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        killProcessTree(child.pid);
      }
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      // Do not wait forever for a process that ignores termination.
      setTimeout(() => finish(124), 1_000).unref?.();
    }, Math.max(1, options.timeoutMs));

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      stderr += error.message;
      finish(1, error.message);
    });

    child.on("close", (code) => {
      finish(timedOut ? 124 : (code ?? 1));
    });

    if (options.stdin !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
};

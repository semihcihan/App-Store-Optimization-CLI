import { spawn } from "child_process";
import "../services/telemetry/instrument";
import fs from "fs";
import path from "path";
import { reportBugsnagError } from "../services/telemetry/error-reporter";

export type AsoCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function getBundledCliEntryPath(): string | null {
  const candidates = [path.resolve(__dirname, "cli.js")];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function spawnAso(args: string[]) {
  const bundledCliEntry = getBundledCliEntryPath();
  if (bundledCliEntry) {
    return spawn(process.execPath, [bundledCliEntry, ...args], {
      env: process.env,
    });
  }

  return spawn("aso", args, { env: process.env });
}

export function runAsoCommand(args: string[]): Promise<AsoCommandResult> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawnAso>;
    try {
      proc = spawnAso(args);
    } catch (err) {
      reportBugsnagError(err, {
        args,
        message: "Error spawning aso",
      });
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });
}

export function toMcpToolResult(result: AsoCommandResult) {
  if (result.exitCode !== 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${result.stderr || result.stdout}`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: result.stdout }],
  };
}

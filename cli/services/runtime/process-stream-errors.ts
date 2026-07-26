import type { Writable } from "stream";

type ExitProcess = (code: number) => void;

const installedStreams = new WeakSet<object>();

export function isBrokenPipeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EPIPE"
  );
}

export function installProcessStreamErrorHandlers(
  streams: Writable[] = [process.stdout, process.stderr],
  exitProcess: ExitProcess = (code) => {
    process.exit(code);
  }
): void {
  for (const stream of streams) {
    if (installedStreams.has(stream)) continue;
    installedStreams.add(stream);
    stream.on("error", (error) => {
      if (isBrokenPipeError(error)) {
        exitProcess(0);
        return;
      }
      throw error;
    });
  }
}

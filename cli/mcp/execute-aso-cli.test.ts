import { EventEmitter } from "events";
import fs from "fs";
import { spawn } from "child_process";
import { reportBugsnagError } from "../services/telemetry/error-reporter";
import { runAsoCommand, toMcpToolResult } from "./execute-aso-cli";

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

jest.mock("../services/telemetry/error-reporter", () => ({
  reportBugsnagError: jest.fn(),
}));

type MockProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
};

function createMockProc(): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe("execute-aso-cli", () => {
  const mockSpawn = jest.mocked(spawn);
  const mockReportBugsnagError = jest.mocked(reportBugsnagError);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("runs bundled cli entry when available", async () => {
    jest.spyOn(fs, "existsSync").mockReturnValue(true);
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = runAsoCommand(["keywords", "term"]);
    proc.stdout.emit("data", Buffer.from("ok"));
    proc.stderr.emit("data", Buffer.from("warn"));
    proc.emit("close", 0);

    await expect(promise).resolves.toEqual({
      stdout: "ok",
      stderr: "warn",
      exitCode: 0,
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringContaining("cli.js"), "keywords", "term"],
      { env: process.env }
    );
  });

  it("falls back to shell aso command when bundled entry is missing", async () => {
    jest.spyOn(fs, "existsSync").mockReturnValue(false);
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = runAsoCommand(["auth"]);
    proc.emit("close", 2);

    await expect(promise).resolves.toEqual({
      stdout: "",
      stderr: "",
      exitCode: 2,
    });
    expect(mockSpawn).toHaveBeenCalledWith("aso", ["auth"], { env: process.env });
  });

  it("reports spawn-time failures and rejects", async () => {
    jest.spyOn(fs, "existsSync").mockReturnValue(false);
    const error = new Error("spawn failed");
    mockSpawn.mockImplementation(() => {
      throw error;
    });

    await expect(runAsoCommand(["keywords"])).rejects.toThrow("spawn failed");
    expect(mockReportBugsnagError).toHaveBeenCalledWith(error, {
      command: "keywords",
      argCount: 1,
      stage: "spawn",
      surface: "aso-mcp",
      telemetryHint: expect.objectContaining({
        classification: "actionable_bug",
        source: "mcp.execute-aso-cli.spawn",
      }),
    });
  });

  it("maps runtime process errors to exitCode=1 result", async () => {
    jest.spyOn(fs, "existsSync").mockReturnValue(false);
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = runAsoCommand(["keywords"]);
    proc.emit("error", new Error("transport failed"));

    await expect(promise).resolves.toEqual({
      stdout: "",
      stderr: "transport failed",
      exitCode: 1,
    });
    expect(mockReportBugsnagError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "transport failed" }),
      expect.objectContaining({
        command: "keywords",
        argCount: 1,
        stage: "transport",
        surface: "aso-mcp",
      })
    );
  });

  it("formats MCP tool results", () => {
    expect(
      toMcpToolResult({ stdout: "ok", stderr: "", exitCode: 0 })
    ).toEqual({
      content: [{ type: "text", text: "ok" }],
    });

    expect(
      toMcpToolResult({ stdout: "", stderr: "bad", exitCode: 1 })
    ).toEqual({
      content: [{ type: "text", text: "Error: bad" }],
      isError: true,
    });
  });
});

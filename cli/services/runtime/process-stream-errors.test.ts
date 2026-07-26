import { EventEmitter } from "events";
import {
  installProcessStreamErrorHandlers,
  isBrokenPipeError,
} from "./process-stream-errors";

describe("process stream errors", () => {
  it("recognizes broken pipe errors", () => {
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

    expect(isBrokenPipeError(error)).toBe(true);
    expect(isBrokenPipeError(new Error("other"))).toBe(false);
  });

  it("exits cleanly when a process stream closes its pipe", () => {
    const stream = new EventEmitter();
    const exitProcess = jest.fn();
    installProcessStreamErrorHandlers([stream as any], exitProcess);

    stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it("rethrows unexpected stream errors", () => {
    const stream = new EventEmitter();
    const exitProcess = jest.fn();
    installProcessStreamErrorHandlers([stream as any], exitProcess);

    expect(() => stream.emit("error", new Error("unexpected"))).toThrow(
      "unexpected"
    );
    expect(exitProcess).not.toHaveBeenCalled();
  });
});

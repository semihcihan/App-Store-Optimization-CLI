import winston from "winston";
import util from "util";
import { fromError, isZodErrorLike } from "zod-validation-error";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export interface LogOutputConfig {
  mode: "console" | "file" | "json";
  showErrorStack: boolean;
}

export type LogOutputModes = LogOutputConfig[];

export interface Logger {
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  std: (message: any) => any;
  setLevel: (level: LogLevel, minLevel?: LogLevel) => void;
  getLevel: () => LogLevel;
  setOutputModes: (modes: LogOutputModes, filename?: string) => void;
  getOutputModes: () => LogOutputModes;
}

const ANSI = {
  RESET: "\x1b[0m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  RED: "\x1b[31m",
} as const;

type LogLevelPrefixConfig = {
  prefix: string;
  color?: string;
};

const LOG_LEVEL_PREFIXES: Record<string, LogLevelPrefixConfig> = {
  debug: { prefix: "d" },
  info: { prefix: "i", color: ANSI.GREEN },
  warn: { prefix: "warn", color: ANSI.YELLOW },
  error: { prefix: "error", color: ANSI.RED },
};

const getLogPrefix = (
  level: string,
  useColor: boolean
): { visible: string; formatted: string } => {
  const config = LOG_LEVEL_PREFIXES[level];
  if (!config) {
    return { visible: `${level}:`, formatted: `${level}:` };
  }
  const { prefix, color } = config;
  const formatted =
    useColor && color ? `${color}${prefix}${ANSI.RESET}` : prefix;
  return { visible: prefix, formatted };
};

const getSplatMetadata = (meta: any): any[] => {
  return meta[Symbol.for("splat")] || [];
};

const isPlainEmptyObject = (obj: unknown): boolean => {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return false;
  }
  if (Object.getPrototypeOf(obj) !== Object.prototype) {
    return false;
  }
  return Object.keys(obj).length === 0;
};

const processErrorContext = (
  context: any,
  showErrorStack: boolean,
  seen: WeakSet<object>
): any | undefined => {
  if (context === undefined) {
    return undefined;
  }
  const processed = processNestedErrors(context, showErrorStack, seen);
  if (processed === undefined) {
    return undefined;
  }
  if (
    typeof processed === "object" &&
    processed !== null &&
    Object.keys(processed).length === 0
  ) {
    return undefined;
  }
  return processed;
};

const processErrorObject = (
  obj: Error,
  showErrorStack: boolean,
  seen: WeakSet<object>
): any => {
  const errorObj: any = {
    message: isZodErrorLike(obj) ? fromError(obj).message : obj.message,
  };

  if (showErrorStack && obj.stack) {
    errorObj.stack = obj.stack;
  }

  Object.keys(obj).forEach((key) => {
    if (key === "name" || key === "message" || key === "stack") {
      return;
    }
    const value = (obj as any)[key];
    if (value !== undefined) {
      errorObj[key] = processNestedErrors(value, showErrorStack, seen);
    }
  });

  if (errorObj.context !== undefined) {
    const processedContext = processErrorContext(
      errorObj.context,
      showErrorStack,
      seen
    );
    if (processedContext !== undefined) {
      errorObj.context = processedContext;
    } else {
      delete errorObj.context;
    }
  }

  return errorObj;
};

export const processNestedErrors = (
  obj: any,
  showErrorStack: boolean,
  seen: WeakSet<object> = new WeakSet()
): any => {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== "object") {
    return obj;
  }

  if (seen.has(obj)) {
    return "[Circular]";
  }

  seen.add(obj);

  if (obj instanceof Error) {
    return processErrorObject(obj, showErrorStack, seen);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => processNestedErrors(item, showErrorStack, seen));
  }

  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return obj;
  }

  const processed: any = {};
  for (const [key, value] of entries) {
    processed[key] = processNestedErrors(value, showErrorStack, seen);
  }
  return processed;
};

const renderValue = (
  value: unknown,
  showErrorStack: boolean,
  isFirstMeta: boolean
): string => {
  try {
    if (typeof value === "string") {
      return value;
    }

    let processedValue = processNestedErrors(value, showErrorStack);

    if (
      isFirstMeta &&
      typeof processedValue === "object" &&
      processedValue !== null &&
      "message" in processedValue
    ) {
      delete processedValue.message;
      if (isPlainEmptyObject(processedValue)) {
        return "";
      }
    }

    return util.inspect(processedValue, {
      colors: false,
      depth: null,
      compact: false,
      maxArrayLength: null,
      maxStringLength: null,
      customInspect: true,
    });
  } catch {
    return String(value);
  }
};

const formatConsoleOutput = (
  level: string,
  message: string,
  meta: any,
  showErrorStack: boolean,
  isFile: boolean,
  timestamp?: string
): string => {
  const { visible, formatted } = getLogPrefix(level, !isFile);
  const indent = " ".repeat(visible.length + 1);

  const processedMessage = renderValue(message, showErrorStack, false);

  const splat = getSplatMetadata(meta);
  let metaContent = "";
  if (splat.length > 0) {
    const processedMeta = splat
      .map((value: any, index: number) =>
        renderValue(value, showErrorStack, index === 0)
      )
      .join("\n");
    metaContent = `\n${processedMeta}`;
  }

  const fullContent = processedMessage + metaContent;
  const indentedContent = String(fullContent).replace(/\n/g, `\n${indent}`);

  if (isFile && timestamp) {
    return `${timestamp} [${level.toUpperCase()}] ${indentedContent}`;
  }

  return `${formatted} ${indentedContent}\n`;
};

const createFormat = (isFile: boolean, showErrorStack: boolean) => {
  const { combine, printf, timestamp } = winston.format;

  const printfFormat = printf((info) => {
    const { level, message, timestamp: ts, ...meta } = info as any;
    return formatConsoleOutput(
      level,
      message,
      meta,
      showErrorStack,
      isFile,
      ts
    );
  });

  if (isFile) {
    return combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), printfFormat);
  }

  return combine(printfFormat);
};

const createJsonFormat = (showErrorStack: boolean) => {
  return winston.format.printf((info) => {
    const { level, message, timestamp: ts, ...meta } = info as any;

    const processedMessage = processNestedErrors(message, showErrorStack);
    const splat = getSplatMetadata(meta);
    const processedMeta = splat.map((value: any) =>
      processNestedErrors(value, showErrorStack)
    );

    const logObject: any = {
      timestamp: ts || new Date().toISOString(),
      level: level.toUpperCase(),
      message: processedMessage,
    };

    if (processedMeta.length === 1) {
      logObject.meta = processedMeta[0];
    } else if (processedMeta.length > 1) {
      logObject.meta = processedMeta;
    }

    return JSON.stringify(logObject, null, 0);
  });
};

const createConsoleTransport = (showErrorStack: boolean) => {
  return new winston.transports.Console({
    format: createFormat(false, showErrorStack),
  });
};

const createFileTransport = (filename: string, showErrorStack: boolean) => {
  return new winston.transports.File({
    filename,
    format: createFormat(true, showErrorStack),
    maxsize: 10 * 1024 * 1024,
    maxFiles: 5,
    tailable: true,
  });
};

const createJsonTransport = (showErrorStack: boolean) => {
  return new winston.transports.Console({
    format: winston.format.combine(
      winston.format.timestamp(),
      createJsonFormat(showErrorStack)
    ),
  });
};

const createTransports = (
  outputModes: LogOutputModes,
  filename?: string
): winston.transport[] => {
  const transports: winston.transport[] = [];

  for (const config of outputModes) {
    switch (config.mode) {
      case "console":
        transports.push(createConsoleTransport(config.showErrorStack));
        break;
      case "file":
        if (filename) {
          transports.push(createFileTransport(filename, config.showErrorStack));
        } else {
          console.warn(
            "File output mode requested but no filename provided. Skipping file transport."
          );
        }
        break;
      case "json":
        transports.push(createJsonTransport(config.showErrorStack));
        break;
    }
  }

  return transports;
};

const isValidOutputMode = (config: LogOutputConfig): boolean => {
  return (
    config.mode === "console" ||
    config.mode === "file" ||
    config.mode === "json"
  );
};

class WinstonLogger implements Logger {
  private winstonLogger: winston.Logger;
  private currentConfig: LogOutputModes = [];

  constructor() {
    this.currentConfig = [{ mode: "console", showErrorStack: false }];
    this.winstonLogger = this.createWinstonLogger();
  }

  private createWinstonLogger(): winston.Logger {
    return winston.createLogger({
      exitOnError: true,
      level: DEFAULT_LOG_LEVEL,
      transports: createTransports(this.currentConfig),
    });
  }

  debug = (message: any, ...meta: any[]) => {
    this.winstonLogger.debug(message, ...meta);
  };

  info = (message: any, ...meta: any[]) => {
    this.winstonLogger.info(message, ...meta);
  };

  warn = (message: any, ...meta: any[]) => {
    this.winstonLogger.warn(message, ...meta);
  };

  error = (message: any, ...meta: any[]) => {
    this.winstonLogger.error(message, ...meta);
  };

  std = (message: any) => {
    if (typeof message === "object") {
      console.log(JSON.stringify(message, null, 2));
    } else {
      console.log(message);
    }
  };

  setLevel = (level: LogLevel): void => {
    if (LOG_LEVELS.includes(level)) {
      this.winstonLogger.level = level;
    } else {
      this.winstonLogger.warn(
        `Invalid log level: ${level}. Using '${DEFAULT_LOG_LEVEL}' as default.`
      );
      this.winstonLogger.level = DEFAULT_LOG_LEVEL;
    }
  };

  getLevel = (): LogLevel => {
    return this.winstonLogger.level as LogLevel;
  };

  setOutputModes = (modes: LogOutputModes, filename?: string): void => {
    const validModes = modes.filter(isValidOutputMode);

    if (validModes.length === 0) {
      this.winstonLogger.warn("No valid output modes provided.");
    }

    this.currentConfig = validModes;
    this.winstonLogger.clear();

    const transports = createTransports(validModes, filename);
    transports.forEach((transport) => this.winstonLogger.add(transport));
  };

  getOutputModes = (): LogOutputModes => {
    return this.currentConfig;
  };
}

export const logger: Logger = new WinstonLogger();

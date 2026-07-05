import { config } from "./config";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel as Level] ?? LEVELS.info;
const pretty = process.stdout.isTTY === true && config.env !== "production";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function serialize(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }
  return value;
}

function emit(level: Level, bindings: Record<string, unknown>, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const stream = level === "error" ? process.stderr : process.stdout;
  if (pretty) {
    const time = new Date().toISOString().slice(11, 23);
    const extra = { ...bindings, ...fields };
    const extraStr = Object.keys(extra).length > 0 ? " " + JSON.stringify(extra, serialize) : "";
    stream.write(`${time} ${level.toUpperCase().padEnd(5)} ${msg}${extraStr}\n`);
  } else {
    const line = { level, time: new Date().toISOString(), msg, ...bindings, ...fields };
    stream.write(JSON.stringify(line, serialize) + "\n");
  }
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (msg, fields) => emit("debug", bindings, msg, fields),
    info: (msg, fields) => emit("info", bindings, msg, fields),
    warn: (msg, fields) => emit("warn", bindings, msg, fields),
    error: (msg, fields) => emit("error", bindings, msg, fields),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

export const logger = createLogger();

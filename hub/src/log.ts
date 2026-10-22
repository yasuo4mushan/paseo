/**
 * Structured JSON logging: one JSON object per line on stdout.
 *
 * Never log tokens, passwords, or offers. Events carry identity (accountId,
 * deviceId) and request facts (path, status, duration) only.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let minLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  process.stdout.write(`${line}\n`);
}

export const logDebug = (event: string, fields?: Record<string, unknown>) =>
  log("debug", event, fields);
export const logInfo = (event: string, fields?: Record<string, unknown>) =>
  log("info", event, fields);
export const logWarn = (event: string, fields?: Record<string, unknown>) =>
  log("warn", event, fields);
export const logError = (event: string, fields?: Record<string, unknown>) =>
  log("error", event, fields);

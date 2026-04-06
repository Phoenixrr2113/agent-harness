export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
  child(prefix: string): Logger;
}

let globalLevel: LogLevel = 'info';

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[globalLevel];
}

function formatMessage(prefix: string, level: LogLevel, msg: string): string {
  const tag = prefix ? `[${prefix}]` : '';
  if (level === 'debug') return `${tag} ${msg}`.trimStart();
  if (level === 'warn') return `${tag} WARN: ${msg}`.trimStart();
  if (level === 'error') return `${tag} ERROR: ${msg}`.trimStart();
  return `${tag} ${msg}`.trimStart();
}

function createLoggerWithPrefix(prefix: string): Logger {
  return {
    debug(msg: string, ...args: unknown[]) {
      if (shouldLog('debug')) console.error(formatMessage(prefix, 'debug', msg), ...args);
    },
    info(msg: string, ...args: unknown[]) {
      if (shouldLog('info')) console.error(formatMessage(prefix, 'info', msg), ...args);
    },
    warn(msg: string, ...args: unknown[]) {
      if (shouldLog('warn')) console.error(formatMessage(prefix, 'warn', msg), ...args);
    },
    error(msg: string, ...args: unknown[]) {
      if (shouldLog('error')) console.error(formatMessage(prefix, 'error', msg), ...args);
    },
    setLevel(level: LogLevel) {
      globalLevel = level;
    },
    getLevel() {
      return globalLevel;
    },
    child(childPrefix: string) {
      const combined = prefix ? `${prefix}:${childPrefix}` : childPrefix;
      return createLoggerWithPrefix(combined);
    },
  };
}

export function createLogger(prefix: string = ''): Logger {
  return createLoggerWithPrefix(prefix);
}

export function setGlobalLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export function getGlobalLogLevel(): LogLevel {
  return globalLevel;
}

export const log = createLogger('harness');

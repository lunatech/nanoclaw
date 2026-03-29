const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

const threshold =
  LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;
const currentLevel = Object.entries(LEVELS).find(
  ([, value]) => value === threshold,
)?.[0] as Level | undefined;

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{\n      "type": "${err.constructor.name}",\n      "message": "${err.message}",\n      "stack":\n          ${err.stack}\n    }`;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>): string {
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (k === 'err') {
      out += `\n    ${KEY_COLOR}err${RESET}: ${formatErr(v)}`;
    } else {
      out += `\n    ${KEY_COLOR}${k}${RESET}: ${JSON.stringify(v)}`;
    }
  }
  return out;
}

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function log(
  level: Level,
  dataOrMsg: unknown,
  msg?: string,
): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  if (typeof dataOrMsg === 'string') {
    stream.write(
      `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${dataOrMsg}${RESET}\n`,
    );
  } else if (dataOrMsg && typeof dataOrMsg === 'object') {
    stream.write(
      `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${msg}${RESET}${formatData(dataOrMsg as Record<string, unknown>)}\n`,
    );
  } else {
    stream.write(
      `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${msg ?? ''}${RESET} ${JSON.stringify(dataOrMsg)}\n`,
    );
  }
}

type LoggerLike = {
  level: string;
  child(bindings: Record<string, unknown>): LoggerLike;
  trace(dataOrMsg: unknown, msg?: string): void;
  debug(dataOrMsg: unknown, msg?: string): void;
  info(dataOrMsg: unknown, msg?: string): void;
  warn(dataOrMsg: unknown, msg?: string): void;
  error(dataOrMsg: unknown, msg?: string): void;
  fatal(dataOrMsg: unknown, msg?: string): void;
};

function createLogger(bindings: Record<string, unknown> = {}): LoggerLike {
  const withBindings = (dataOrMsg: unknown): unknown => {
    if (bindings && Object.keys(bindings).length > 0) {
      if (dataOrMsg && typeof dataOrMsg === 'object' && !Array.isArray(dataOrMsg)) {
        return { ...bindings, ...(dataOrMsg as Record<string, unknown>) };
      }
      return { ...bindings, value: dataOrMsg };
    }
    return dataOrMsg;
  };

  return {
    level: currentLevel || 'info',
    child(childBindings: Record<string, unknown>) {
      return createLogger({ ...bindings, ...childBindings });
    },
    trace(dataOrMsg: unknown, msg?: string) {
      log('debug', withBindings(dataOrMsg), msg);
    },
    debug(dataOrMsg: unknown, msg?: string) {
      log('debug', withBindings(dataOrMsg), msg);
    },
    info(dataOrMsg: unknown, msg?: string) {
      log('info', withBindings(dataOrMsg), msg);
    },
    warn(dataOrMsg: unknown, msg?: string) {
      log('warn', withBindings(dataOrMsg), msg);
    },
    error(dataOrMsg: unknown, msg?: string) {
      log('error', withBindings(dataOrMsg), msg);
    },
    fatal(dataOrMsg: unknown, msg?: string) {
      log('fatal', withBindings(dataOrMsg), msg);
    },
  };
}

export const logger = createLogger();

// Route uncaught errors through logger so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});

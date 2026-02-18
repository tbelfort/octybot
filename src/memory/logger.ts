/**
 * Minimal structured logger.
 *
 * LOG_LEVEL env var: debug | info | warn | error (default: info)
 * LOG_FORMAT=json switches to JSON lines on stderr
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const currentLevel: Level = (() => {
  const env = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return env in LEVELS ? (env as Level) : "info";
})();

const jsonFormat = process.env.LOG_FORMAT === "json";

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  if (jsonFormat) {
    const entry: Record<string, unknown> = {
      level,
      msg,
      ts: new Date().toISOString(),
      ...fields,
    };
    process.stderr.write(JSON.stringify(entry) + "\n");
  } else {
    const prefix = `[${level.toUpperCase()}]`;
    const suffix = fields && Object.keys(fields).length > 0
      ? " " + JSON.stringify(fields)
      : "";
    process.stderr.write(`${prefix} ${msg}${suffix}\n`);
  }
}

const logger = {
  debug(msg: string, fields?: Record<string, unknown>): void { write("debug", msg, fields); },
  info(msg: string, fields?: Record<string, unknown>): void { write("info", msg, fields); },
  warn(msg: string, fields?: Record<string, unknown>): void { write("warn", msg, fields); },
  error(msg: string, fields?: Record<string, unknown>): void { write("error", msg, fields); },
};

export { logger };

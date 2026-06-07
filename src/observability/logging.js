/**
 * Minimal JSON structured logger (SCP-155) — zero dependencies.
 *
 * Why no dep: the hosted node should stay buildable with only the existing
 * runtime deps, and Fly/Render already capture stdout/stderr line-by-line and
 * parse JSON. One newline-delimited JSON object per log line ("JSON lines") is
 * exactly what platform log shippers and most aggregators (Datadog, Loki,
 * Grafana, CloudWatch) ingest natively.
 *
 * UPGRADE PATH: if you later want sampling, redaction, child-logger ergonomics,
 * or faster serialization, swap this for `pino` (https://getpino.io). The
 * surface here — `log.info(msg, fields)` / `log.error(...)` / `log.child(...)`
 * and the `requestLogger` middleware — is intentionally pino-shaped so the swap
 * is mostly an import change. Add `"pino": "^9"` (and optionally
 * `pino-http`) to dependencies at that point.
 *
 * Output contract (one line per call):
 *   {"level":"info","time":"2026-06-07T...Z","msg":"...", ...fields}
 *
 * Levels and the LOG_LEVEL env gate follow the usual order; anything below the
 * configured threshold is dropped. Set LOG_LEVEL=debug in dev, info in prod.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function thresholdFromEnv() {
  const want = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[want] ?? LEVELS.info;
}

/**
 * Create a logger. `base` fields are merged into every line (e.g. a service
 * name or a request id on a child logger).
 *
 * @param {Record<string, unknown>} [base]
 */
export function createLogger(base = {}) {
  const threshold = thresholdFromEnv();

  function emit(level, msg, fields) {
    if (LEVELS[level] < threshold) return;
    // error/warn → stderr, everything else → stdout, matching platform
    // conventions so warnings/errors can be alerted on separately.
    const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
    const record = {
      level,
      time: new Date().toISOString(),
      ...base,
      ...flattenError(fields),
      msg: typeof msg === 'string' ? msg : String(msg),
    };
    try {
      stream.write(JSON.stringify(record) + '\n');
    } catch {
      // Never let logging throw into a request path; fall back to a safe shape.
      stream.write(JSON.stringify({ level, time: record.time, msg: 'log-serialize-failed' }) + '\n');
    }
  }

  const logger = {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    /** Derive a logger that stamps extra fields on every line. */
    child: (childBase) => createLogger({ ...base, ...childBase }),
  };
  return logger;
}

/**
 * If `fields.err` is an Error, expand it to a serializable shape (Errors
 * stringify to `{}` otherwise). Leaves everything else untouched.
 */
function flattenError(fields) {
  if (!fields || typeof fields !== 'object') return {};
  if (fields.err instanceof Error) {
    const { err, ...rest } = fields;
    return { ...rest, err: { name: err.name, message: err.message, stack: err.stack } };
  }
  return fields;
}

/**
 * Express middleware: assigns/propagates a request id and logs one line per
 * completed request (method, path, status, duration). Mount this EARLY (before
 * routes) so it wraps the whole request lifecycle.
 *
 * Skips /healthz by default so health-check spam doesn't drown real traffic;
 * pass `{ skip: () => false }` to log everything.
 *
 * @param {ReturnType<typeof createLogger>} log
 * @param {{ skip?: (req) => boolean }} [opts]
 */
export function requestLogger(log, opts = {}) {
  const skip = opts.skip || ((req) => req.path === '/healthz');
  return (req, res, next) => {
    if (skip(req)) return next();
    const start = process.hrtime.bigint();
    const reqId = req.get('x-request-id') || randomId();
    req.id = reqId;
    res.setHeader('x-request-id', reqId);
    res.on('finish', () => {
      const durMs = Number(process.hrtime.bigint() - start) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      log[level]('request', {
        reqId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durMs * 100) / 100,
      });
    });
    next();
  };
}

function randomId() {
  // Cheap, collision-resistant-enough request id without a crypto import on the
  // hot path. Good enough to correlate one request's lines.
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** A ready-to-use default logger stamped with the service name. */
export const log = createLogger({ service: 'scope-hub' });

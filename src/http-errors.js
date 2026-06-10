/**
 * Uniform 500 handler (SCP-209). Logs the real error server-side but returns a
 * generic body to the client — Postgres/driver messages leak schema (column,
 * constraint, type) detail that aids a multi-tenant attacker. 400-level
 * validation messages stay specific; only 500s are generalized.
 */
export function serverError(res, e) {
  try { process.stderr.write(`[hub] 500: ${(e && (e.stack || e.message)) || e}\n`); } catch { /* ignore */ }
  return res.status(500).json({ error: 'internal error' });
}

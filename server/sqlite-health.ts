const FATAL_SQLITE_BASE_CODES = new Set([7, 8, 10, 11, 13, 14, 26]);

/** Classify durable SQLite failures without latching ordinary constraints/busy errors. */
export function isFatalSqliteError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errcode?: unknown; message?: unknown };
  const errcode = typeof candidate.errcode === "number" ? candidate.errcode : Number.NaN;
  if (Number.isInteger(errcode) && FATAL_SQLITE_BASE_CODES.has(errcode & 0xff)) return true;
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  if (code !== "ERR_SQLITE_ERROR" && !code.startsWith("SQLITE_")) return false;
  return /(?:database disk image is malformed|database or disk is full|disk i\/o error|attempt to write a readonly database|file is not a database|unable to open database file|out of memory)/iu.test(message);
}

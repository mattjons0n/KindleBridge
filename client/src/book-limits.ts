/**
 * Browser memory guardrails for one active source/derivative pipeline.
 * Conversion is intentionally single-flight, so these limits do not multiply
 * across concurrent books.
 */
export const MAX_BOOK_SOURCE_BYTES = 200 * 1024 * 1024;
export const MAX_KINDLE_ARTIFACT_BYTES = 200 * 1024 * 1024;

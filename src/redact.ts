/** Shared credential redaction for user-derived text crossing a trust boundary. */

const REDACTED = '[REDACTED]'

const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu
const JSON_WEB_TOKEN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/gu
const PREFIXED_SECRET = /(?:sk|key|token)-[A-Za-z0-9._-]{8,}/gu
/**
 * `key: value` / `"key": "value"` / `key=value` for common credential key names.
 * The optional quote capture is reused for both sides of the key so the
 * replacement keeps the original quoting and surrounding JSON or shell text
 * stays parseable.
 */
const KEY_VALUE_PAIR = /(["']?)(api[_-]?key|authorization|token|secret|password|passwd|pwd)\1(\s*[:=]\s*)(["']?)[^\s"',;]+/giu

/**
 * Redact credentials from one string. Order matters: multi-line PEM blocks run
 * first so key-material lines cannot re-match the narrower single-line rules.
 */
export function redactCredentials(value: string): string {
  return value
    .replace(PEM_PRIVATE_KEY, `-----BEGIN PRIVATE KEY----- ${REDACTED} -----END PRIVATE KEY-----`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(JSON_WEB_TOKEN, REDACTED)
    .replace(PREFIXED_SECRET, REDACTED)
    .replace(KEY_VALUE_PAIR, (_match: string, openQuote: string, key: string, separator: string, valueQuote: string) => {
      return `${openQuote}${key}${openQuote}${separator}${valueQuote}${REDACTED}`
    })
}

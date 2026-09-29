/**
 * piiMasker.ts
 *
 * Redaction helpers used by the unified logging interface.
 *
 * Two complementary strategies are applied to everything that reaches a log
 * transport, because sensitive values arrive in two very different shapes:
 *
 *  1. **Key-based redaction** — structured metadata such as
 *     `{ password: 'hunter2' }`. Any key whose name matches a known-sensitive
 *     pattern (password, token, secret, key, authorization, …) has its value
 *     replaced wholesale. This is the strongest guarantee: the value is never
 *     inspected, so a secret is redacted regardless of its format.
 *
 *  2. **Pattern-based masking** — free-text strings such as
 *     `"login failed for alice@example.com"`. Values are scanned for
 *     recognisable PII (emails, JWTs, Stellar keys, card numbers, phone
 *     numbers, bearer tokens) and each match is partially masked.
 *
 * Masking is *partial* wherever it is safe to be. `alice@example.com` becomes
 * `al***@example.com` rather than a flat `[REDACTED]`, because operators still
 * need to correlate log lines during an incident. Anything that is purely a
 * credential (passwords, private keys, tokens) is redacted in full.
 *
 * The module is intentionally dependency-free and side-effect-free so it can
 * be unit-tested in isolation and reused outside the logger.
 */

/** Replacement written in place of a fully redacted value. */
export const REDACTED = '[REDACTED]';

/**
 * Depth limit applied when walking nested objects.
 *
 * Log metadata is occasionally a deep or cyclic graph (a Mongoose document, an
 * Axios error carrying the whole request/response). Bounding the walk keeps a
 * single log call from becoming a performance problem.
 */
const MAX_DEPTH = 8;

/** Upper bound on array elements visited per array. */
const MAX_ARRAY_ITEMS = 100;

/**
 * Object keys whose values are always redacted in full, matched
 * case-insensitively against the key name.
 *
 * The list is deliberately broad: over-redacting a log field is a cosmetic
 * problem, while under-redacting one is a security incident.
 */
const SENSITIVE_KEY_PATTERN =
  /(pass(word|phrase)?|secret|token|api[-_]?key|private[-_]?key|secret[-_]?key|authorization|auth|credential|cookie|session[-_]?id|signature|signed[-_]?xdr|mnemonic|seed|otp|pin|cvv|ssn|refresh|access[-_]?token|client[-_]?secret)/i;

/**
 * Keys that match {@link SENSITIVE_KEY_PATTERN} but are safe to keep, because
 * they carry no secret material and are valuable for debugging.
 *
 * Checked before the sensitive pattern so it always wins.
 */
const SENSITIVE_KEY_ALLOWLIST = /^(tokenType|authProvider|authMethod|hasToken|tokenExpiresAt)$/i;

// ─── Value patterns ───────────────────────────────────────────────────────────

/** RFC-5322-ish email address. */
const EMAIL_PATTERN = /\b([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]*)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

/** JSON Web Token — three base64url segments separated by dots. */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

/** `Authorization: Bearer <token>` style headers embedded in text. */
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * Stellar secret seed (`S...`, 56 chars). Always redacted in full — a secret
 * seed is a spending key.
 */
const STELLAR_SECRET_PATTERN = /\bS[A-Z2-7]{55}\b/g;

/**
 * Stellar public key (`G...`) or contract id (`C...`), 56 chars.
 * Public identifiers, so these are partially masked rather than removed:
 * operators routinely need them to trace a transaction.
 */
const STELLAR_PUBLIC_PATTERN = /\b([GC])([A-Z2-7]{55})\b/g;

/** PEM private key blocks. */
const PEM_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** 13-19 digit payment card numbers, optionally separated by spaces/hyphens. */
const CARD_PATTERN = /\b(?:\d[ -]?){12,18}\d\b/g;

/** E.164-ish phone numbers with an explicit `+` country code. */
const PHONE_PATTERN = /\+\d{7,15}\b/g;

/**
 * MongoDB / Redis connection strings that embed credentials.
 * Captures the scheme and host so the target stays identifiable.
 */
const CONNECTION_STRING_PATTERN = /\b([a-z+]+:\/\/)([^:@\s/]+):([^@\s/]+)@/gi;

// ─── Primitive maskers ────────────────────────────────────────────────────────

/**
 * Mask an email address, preserving the first two local-part characters and
 * the full domain so log lines remain correlatable.
 *
 * `alice@example.com` → `al***@example.com`
 */
function maskEmail(_match: string, first: string, rest: string, domain: string): string {
  const prefix = rest.length > 0 ? first + rest.charAt(0) : first;
  return `${prefix}***@${domain}`;
}

/**
 * Mask a card number, keeping only the last four digits (the maximum PCI-DSS
 * permits to be retained in logs).
 */
function maskCard(match: string): string {
  const digits = match.replace(/[^\d]/g, '');
  // Luhn-check so ordinary long numbers (ledger sequences, ids) survive intact.
  if (!isLuhnValid(digits)) return match;
  return `****-****-****-${digits.slice(-4)}`;
}

/**
 * Validate a digit string with the Luhn algorithm.
 *
 * Used to distinguish real card numbers from other long numeric strings, so
 * that ledger sequences and database ids are not mangled by {@link maskCard}.
 */
function isLuhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }

  return sum % 10 === 0;
}

/** Mask a phone number, keeping the country code and last two digits. */
function maskPhone(match: string): string {
  if (match.length <= 5) return match;
  return `${match.slice(0, 3)}${'*'.repeat(match.length - 5)}${match.slice(-2)}`;
}

/** Mask a Stellar public key / contract id: `GABC…XYZ` → `GABC***XYZ`. */
function maskStellarPublic(match: string): string {
  return `${match.slice(0, 4)}***${match.slice(-4)}`;
}

/**
 * Apply every value-level pattern to a free-text string.
 *
 * Order matters: the most specific and most dangerous patterns run first so a
 * broader pattern cannot partially consume them.
 */
export function maskString(value: string): string {
  if (!value) return value;

  return value
    .replace(PEM_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, (m) => `${m.split(/\s+/)[0]} ${REDACTED}`)
    .replace(STELLAR_SECRET_PATTERN, REDACTED)
    .replace(
      CONNECTION_STRING_PATTERN,
      (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`,
    )
    .replace(EMAIL_PATTERN, maskEmail)
    .replace(CARD_PATTERN, maskCard)
    .replace(PHONE_PATTERN, maskPhone)
    .replace(STELLAR_PUBLIC_PATTERN, maskStellarPublic);
}

/** Whether an object key should have its value redacted in full. */
export function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY_ALLOWLIST.test(key)) return false;
  return SENSITIVE_KEY_PATTERN.test(key);
}

// ─── Recursive walker ─────────────────────────────────────────────────────────

/**
 * Recursively mask an arbitrary value.
 *
 * Behaviour by type:
 *  - `string`      — value patterns applied.
 *  - `object`      — walked; keys matching {@link isSensitiveKey} are redacted.
 *  - `Error`       — `name`/`message`/`stack` preserved (message masked) so
 *                    stack traces survive redaction.
 *  - `Date`/`Buffer`/`RegExp` — passed through or summarised, never walked.
 *  - everything else — returned unchanged.
 *
 * Cycles are tracked with a `WeakSet`, so a self-referential object logs as
 * `'[Circular]'` instead of overflowing the stack.
 *
 * @param value - The value to mask.
 * @param depth - Current recursion depth (internal).
 * @param seen  - Objects already visited on this path (internal).
 * @returns A masked deep copy. The input is never mutated.
 */
export function maskValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return maskString(value);

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Date) return value;
  if (value instanceof RegExp) return value.toString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: maskString(value.message),
      stack: value.stack ? maskString(value.stack) : undefined,
    };
  }

  if (depth >= MAX_DEPTH) return '[MaxDepth]';

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    try {
      if (Array.isArray(value)) {
        const items = value
          .slice(0, MAX_ARRAY_ITEMS)
          .map((item) => maskValue(item, depth + 1, seen));

        if (value.length > MAX_ARRAY_ITEMS) {
          items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
        }
        return items;
      }

      if (value instanceof Map) {
        return maskValue(Object.fromEntries(value), depth + 1, seen);
      }

      if (value instanceof Set) {
        return maskValue(Array.from(value), depth + 1, seen);
      }

      // Mongoose documents and other class instances expose their data through
      // toJSON(); using it avoids walking internal driver state.
      const source =
        typeof (value as { toJSON?: unknown }).toJSON === 'function'
          ? (value as { toJSON: () => unknown }).toJSON()
          : value;

      if (source !== value) return maskValue(source, depth + 1, seen);

      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        result[key] = isSensitiveKey(key) ? REDACTED : maskValue(item, depth + 1, seen);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }

  return value;
}

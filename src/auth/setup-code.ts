/**
 * First-run setup code.
 *
 * The very first `memhub login` on a fresh deployment sets the admin
 * password from the browser. Without an out-of-band secret anyone on the
 * network could complete that flow and take the server over (the pending
 * device grant is self-obtainable). The setup code closes that hole: the
 * daemon writes a one-time code into the MemHub home (next to the token
 * file, 0600), and the first login form requires it. Reading the code
 * requires access to the server itself.
 *
 * The file is deleted once the admin password has been set; deleting it
 * manually while no password exists makes the daemon regenerate a new
 * code on the next start.
 */

import { randomBytes } from 'crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';

/** Crockford base32 — no I/L/O/U to avoid transcription confusion. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Length of the code without the hyphen (12 Crockford chars = 60 bits). */
const CODE_LENGTH = 12;

/** Shape of a canonical setup code: two 6-char groups, hyphen-separated. */
export const SETUP_CODE_PATTERN = /^[0-9A-Z]{6}-[0-9A-Z]{6}$/;

/** Generate a new setup code like "7Q3K2W-M2XW4J". */
export function generateSetupCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  const chars: string[] = [];
  for (let i = 0; i < CODE_LENGTH; i++) {
    // 256 % 32 === 0, so direct indexing is unbiased for this alphabet.
    chars.push(ALPHABET[bytes[i] % 32]);
  }
  return `${chars.slice(0, 6).join('')}-${chars.slice(6).join('')}`;
}

/**
 * Normalize a typed setup code: uppercase, drop non-alphanumerics,
 * re-insert the hyphen. Returns the canonical form or null when the
 * input cannot be 12 Crockford characters.
 */
export function normalizeSetupCode(raw: string): string | null {
  const cleaned = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (cleaned.length !== CODE_LENGTH) return null;
  return `${cleaned.slice(0, 6)}-${cleaned.slice(6)}`;
}

/**
 * Return the setup code for a fresh (uninitialized) deployment, reading
 * the existing file or generating and persisting a new one (mode 0600).
 */
export function ensureSetupCodeFile(path: string): string {
  if (existsSync(path)) {
    const existing = normalizeSetupCode(readFileSync(path, 'utf-8').trim());
    if (existing !== null) return existing;
  }
  const code = generateSetupCode();
  writeFileSync(path, `${code}\n`, { mode: 0o600 });
  // Re-assert the mode: writeFileSync only applies it when creating.
  chmodSync(path, 0o600);
  return code;
}

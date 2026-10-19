import { createHash } from "node:crypto";

/**
 * Derives a session id from an auth credential. The raw credential is never
 * stored or logged, only a short hash of it.
 */
export function deriveSessionId(credential: string | undefined, fallback: string): string {
  if (!credential) return fallback;
  return createHash("sha256").update(credential).digest("hex").slice(0, 12);
}

/**
 * Resolves the session id for a request: an explicit `x-promptpace-session`
 * header always wins, otherwise the id is derived from the auth credential.
 */
export function resolveSessionId(headers: Headers, fallback: string): string {
  const explicit = headers.get("x-promptpace-session")?.trim();
  if (explicit) return explicit;

  const credential = headers.get("x-api-key") ?? headers.get("authorization") ?? undefined;
  return deriveSessionId(credential, fallback);
}

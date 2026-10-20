/** The proxy binds to the loopback interface unless the environment says otherwise. */
export const DEFAULT_BIND_HOST = "127.0.0.1";

/**
 * The address the HTTP server binds to. `PROMPTPACE_BIND_HOST` overrides it,
 * but a wildcard bind is never the default.
 */
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PROMPTPACE_BIND_HOST?.trim();
  if (!raw) return DEFAULT_BIND_HOST;
  return raw;
}

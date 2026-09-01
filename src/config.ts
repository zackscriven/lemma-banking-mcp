/** Environment-driven configuration. Credentials come from env only -- never hardcoded. */

export interface Config {
  apiKey: string | undefined;
  /** Includes the /v0 prefix, e.g. https://api.getlemma.com/v0 */
  baseUrl: string;
  /**
   * Money-movement / write calls are BLOCKED unless this is explicitly
   * "true"/"1"/"yes". Default: safe (read-only). Mirrors the
   * MEDALLION_ENABLE_WRITES / STEDI_ENABLE_WRITES precedent.
   */
  enableWrites: boolean;
  timeoutMs: number;
}

/**
 * Resolve the API key. Supports, in order:
 * 1. LEMMA_API_KEY (this server's native var). NOTE: this is a *platform*
 *    API key issued manually by the Lemma team (email contact@getlemma.com) --
 *    not a personal login. As of 2026-09-01 we do not have one yet; the server
 *    starts fine without it and every tool returns a clear "not set" error.
 * 2. HD_LEMMA_API_KEY (HD-ecosystem secrets.env convention, matching the
 *    HD_GHL_API_KEY / HD_MEDALLION_API_KEY precedent).
 */
function resolveApiKey(): string | undefined {
  return process.env.LEMMA_API_KEY ?? process.env.HD_LEMMA_API_KEY;
}

export function loadConfig(): Config {
  const truthy = (v: string | undefined) => v === "true" || v === "1" || v === "yes";
  return {
    apiKey: resolveApiKey(),
    baseUrl: (process.env.LEMMA_BASE_URL ?? "https://api.getlemma.com/v0").replace(/\/+$/, ""),
    enableWrites: truthy(process.env.LEMMA_ENABLE_WRITES ?? process.env.HD_LEMMA_ENABLE_WRITES),
    timeoutMs: Number(process.env.LEMMA_TIMEOUT_MS ?? 30000),
  };
}

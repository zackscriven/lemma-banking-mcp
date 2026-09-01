/**
 * Shared authenticated request helper for the live Lemma API.
 *
 * Key design points:
 * - Auth is `Authorization: Bearer <LEMMA_API_KEY>` on every request
 *   (per https://getlemma.com/docs/api-reference/authentication).
 * - Every POST requires BOTH `Content-Type: application/json` and an
 *   `Idempotency-Key` header (10-256 chars, [A-Za-z0-9-_:] only). This
 *   helper enforces that client-side: a POST without an idempotency key is
 *   rejected before any network call. Keys must be deterministic across
 *   retries -- see makeIdempotencyKey() below.
 * - All monetary amounts are integers in CENTS on the wire. Tool schemas
 *   accept dollars and convert via dollarsToCents(); responses get
 *   *_dollars annotations via annotateDollars() so the caller never does
 *   cents math.
 * - Standard error body: { message, error, statusCode }. Real HTTP status +
 *   body are surfaced so an agent can act.
 * - Rate limit is 500 req/min. On 429 this helper retries GETs up to 3
 *   times honoring Retry-After; POST/DELETE are NEVER auto-retried by the
 *   HTTP layer (money movement -- the idempotency key makes a deliberate
 *   agent-level retry safe instead).
 * - Idempotency replay semantics (409 = original still in flight,
 *   Idempotency-Replayed: true = you got the latest state of the earlier
 *   resource) are surfaced in the response object.
 */
import { createHash } from "node:crypto";
import type { Config } from "./config.js";

export interface LemmaResponse {
  ok: boolean;
  status: number;
  data: unknown;
  requestUrl: string;
  idempotencyReplayed: boolean;
  retryAfter: string | null;
}

export class LemmaError extends Error {
  constructor(message: string, public status?: number, public body?: unknown) {
    super(message);
  }
}

export function requireApiKey(config: Config): void {
  if (!config.apiKey) {
    throw new LemmaError(
      "LEMMA_API_KEY not set. This server needs a Lemma *platform* API key in the environment " +
        "(env block of claude_desktop_config.json). Platform keys are issued manually by the Lemma " +
        "team -- email contact@getlemma.com to request one. No live call was attempted."
    );
  }
}

const IDEMPOTENCY_RE = /^[A-Za-z0-9\-_:]{10,256}$/;

/**
 * Build a valid, DETERMINISTIC Idempotency-Key from a caller-supplied
 * reference. Same (prefix, reference) in -> same key out, always, so a
 * retried tool call reuses the key and Lemma replays instead of
 * double-executing. Invalid characters are replaced, and a short sha256
 * suffix of the ORIGINAL reference preserves uniqueness through
 * sanitization/truncation and guarantees the >=10 char minimum.
 */
export function makeIdempotencyKey(prefix: string, reference: string): string {
  const digest = createHash("sha256").update(`${prefix}:${reference}`).digest("hex").slice(0, 12);
  const sanitized = `${prefix}:${reference}`.replace(/[^A-Za-z0-9\-_:]/g, "-").slice(0, 240);
  const key = `${sanitized}:${digest}`;
  if (!IDEMPOTENCY_RE.test(key)) {
    // Cannot happen given construction above, but fail loudly rather than send a bad header.
    throw new LemmaError(`Internal error: generated idempotency key is invalid: ${key}`);
  }
  return key;
}

/** Convert caller-facing dollars to wire-format integer cents. */
export function dollarsToCents(amountDollars: number, field = "amount_dollars"): number {
  if (typeof amountDollars !== "number" || !Number.isFinite(amountDollars)) {
    throw new LemmaError(`${field} must be a finite number of dollars (e.g. 1250.50).`);
  }
  const cents = Math.round(amountDollars * 100);
  if (Math.abs(amountDollars * 100 - cents) > 1e-6) {
    throw new LemmaError(`${field} has sub-cent precision (${amountDollars}). Use at most 2 decimal places.`);
  }
  if (cents <= 0) {
    throw new LemmaError(`${field} must be greater than zero.`);
  }
  return cents;
}

const CENT_KEYS = /(^|_)(amount|balance|total_balance|available_balance)$/;

/** Recursively annotate integer cent fields with a sibling *_dollars value. */
export function annotateDollars(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(annotateDollars);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = annotateDollars(v);
      if (CENT_KEYS.test(k) && typeof v === "number" && Number.isInteger(v)) {
        out[`${k}_dollars`] = v / 100;
      }
    }
    return out;
  }
  return value;
}

export interface CallOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Required for POST -- pass the value from makeIdempotencyKey(). */
  idempotencyKey?: string;
  /** Return raw bytes instead of parsing JSON (PDF / X12 downloads). */
  binary?: boolean;
}

export async function callLemma(
  config: Config,
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: CallOptions = {}
): Promise<LemmaResponse & { bytes?: Buffer }> {
  requireApiKey(config);

  if (method === "POST" && !opts.idempotencyKey) {
    throw new LemmaError(
      `Refusing to POST ${path} without an Idempotency-Key. This is a client-side guard: ` +
        "Lemma rejects POSTs without one, and a deterministic key is what makes retries safe."
    );
  }
  if (opts.idempotencyKey && !IDEMPOTENCY_RE.test(opts.idempotencyKey)) {
    throw new LemmaError(
      `Idempotency key is invalid (must be 10-256 chars of [A-Za-z0-9-_:]): ${opts.idempotencyKey}`
    );
  }

  const url = new URL(config.baseUrl + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: opts.binary ? "*/*" : "application/json",
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  const init: RequestInit = { method, headers };
  if (opts.body !== undefined && method === "POST") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  const maxAttempts = method === "GET" ? 3 : 1; // never auto-retry money movement
  let attempt = 0;
  for (;;) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    init.signal = controller.signal;
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      clearTimeout(timer);
      const msg =
        e instanceof Error && e.name === "AbortError"
          ? `Request timed out after ${config.timeoutMs}ms`
          : String(e);
      throw new LemmaError(`Lemma request failed (${method} ${url}): ${msg}`);
    }
    clearTimeout(timer);

    if (res.status === 429 && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "2");
      await new Promise((r) => setTimeout(r, Math.min(Math.max(retryAfter, 1), 30) * 1000));
      continue;
    }

    const replayed = res.headers.get("idempotency-replayed") === "true";
    if (opts.binary && res.ok) {
      const bytes = Buffer.from(await res.arrayBuffer());
      return {
        ok: true,
        status: res.status,
        data: null,
        bytes,
        requestUrl: url.toString(),
        idempotencyReplayed: replayed,
        retryAfter: null,
      };
    }

    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    return {
      ok: res.ok,
      status: res.status,
      data,
      requestUrl: url.toString(),
      idempotencyReplayed: replayed,
      retryAfter: res.headers.get("retry-after"),
    };
  }
}

/** Turn a non-2xx Lemma response into a clear, actionable error string. */
export function explainError(res: LemmaResponse): string {
  const body = res.data as { message?: unknown; error?: unknown; statusCode?: unknown } | null;
  const msg = body && typeof body === "object" ? String(body.message ?? "") : String(res.data ?? "");
  const hints: Record<number, string> = {
    401: "Unauthorized -- the LEMMA_API_KEY is missing, wrong, or revoked. Platform keys come from the Lemma team (contact@getlemma.com).",
    404: "Not found -- the ID does not exist or this platform key has not been granted access to that entity.",
    409: "Idempotency conflict -- the original request with this key is still in flight. Wait a moment and retry with the SAME key.",
    415: "Unsupported media type -- Content-Type application/json was expected.",
    422: "Unprocessable -- validation failed, or an idempotency key was reused on a different endpoint.",
    429: "Rate limited (500 req/min). Retried with backoff where safe; slow down.",
    500: "Lemma server error. If this was a retried POST, the key is spent -- a fresh attempt needs a NEW reference.",
  };
  return `Lemma API error ${res.status} on ${res.requestUrl}: ${msg || JSON.stringify(res.data)}${
    hints[res.status] ? ` -- ${hints[res.status]}` : ""
  }`;
}

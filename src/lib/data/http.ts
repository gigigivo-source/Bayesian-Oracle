// ĞIGI GIVØ — Fail-soft HTTP layer for the stats data sources.
//
// Every external call made by the stats aggregator goes through here. The
// contract is simple and absolute:
//   · never throws — a failed source returns null (the aggregator falls
//     through to the next source);
//   · every request has a hard deadline (AbortController), so a hung source
//     cannot stall match processing;
//   · 429 / 5xx are reported distinctly so the aggregator can arm a cooldown.

export type HttpResult =
  | { status: "ok"; data: unknown; httpStatus: number }
  | { status: "timeout"; httpStatus: number | null }
  | { status: "rate-limited"; httpStatus: number }
  | { status: "not-found"; httpStatus: number }
  | { status: "server-error"; httpStatus: number }
  | { status: "http-error"; httpStatus: number }
  | { status: "network-error"; httpStatus: number | null }
  | { status: "invalid-json"; httpStatus: number | null }
  | { status: "empty"; httpStatus: number | null };

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Return the raw text instead of parsed JSON. */
  text?: boolean;
  /** Optional per-call user agent override. */
  userAgent?: string;
}

const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; GigiGivo/1.0)";
const DEFAULT_TIMEOUT_MS = 12_000;

/** Fetch JSON or text with a hard deadline, returning a typed outcome. */
export async function fetchWithTimeout(
  url: string,
  opts: HttpRequestOptions = {},
): Promise<HttpResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": opts.userAgent ?? DEFAULT_USER_AGENT,
        Accept: opts.text ? "text/html,application/xhtml+xml,text/plain,*/*" : "application/json",
        ...(opts.headers ?? {}),
      },
      signal: controller.signal,
      cache: "no-store",
    });

    if (res.status === 429) return { status: "rate-limited", httpStatus: res.status };
    if (res.status === 404) return { status: "not-found", httpStatus: res.status };
    if (res.status >= 500) return { status: "server-error", httpStatus: res.status };
    if (!res.ok) return { status: "http-error", httpStatus: res.status };

    const body = opts.text ? await res.text() : await res.json();
    if (body === null || body === undefined || (typeof body === "string" && body.length === 0)) {
      return { status: "empty", httpStatus: res.status };
    }
    return { status: "ok", data: body, httpStatus: res.status };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "timeout", httpStatus: null };
    }
    return { status: "network-error", httpStatus: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convenience wrapper that reduces a typed outcome to parsed JSON or null.
 * Preferred by sources that do not need to distinguish timeout vs 404.
 */
export async function fetchJson<T>(
  url: string,
  opts: HttpRequestOptions = {},
): Promise<T | null> {
  const res = await fetchWithTimeout(url, opts);
  return res.status === "ok" ? (res.data as T) : null;
}

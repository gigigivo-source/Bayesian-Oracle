// ĞIGI GIVØ — Shared resilient HTTP client.
// Protects external providers (ESPN, mesh) from 429s via:
//   • a global concurrency limiter (max N in-flight requests)
//   • retry with exponential backoff on 429 / 5xx
//   • honoring Retry-After when the provider sends it
//   • a hard per-attempt timeout so a hung upstream can never pin a slot
//   • single-flight coalescing of identical concurrent GETs
//   • a small in-memory response cache (positive *and* negative) to collapse
//     duplicate bursts and stop failure-retry storms from repeating

const MAX_CONCURRENT = Number(process.env.HTTP_MAX_CONCURRENT ?? 12);

// Hard ceiling on a single network attempt. Without this a hung upstream holds
// a concurrency slot forever and starves every other request in the process.
const ATTEMPT_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS ?? 6000);

// Ceiling on the whole call (all attempts + backoff). Guarantees a caller that
// fans out N requests can bound its own latency.
const TOTAL_TIMEOUT_MS = Number(process.env.HTTP_TOTAL_TIMEOUT_MS ?? 12000);

let inFlight = 0;
const queue: Array<() => void> = [];

function acquire(): Promise<void> {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release(): void {
  inFlight--;
  const next = queue.shift();
  if (next) {
    inFlight++;
    next();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Short in-memory cache (per server instance) — dedupes identical GETs in a burst.
interface CacheEntry {
  at:   number;
  data: unknown;
  /** Failures are cached too, for a shorter window, to avoid retry storms. */
  ok:   boolean;
}
const memCache = new Map<string, CacheEntry>();
const MEM_TTL_MS = 60 * 1000; // 60 s for successful responses

// Negative cache: a provider that just failed 4 times will almost certainly
// fail again a second later. Remembering that for a short while turns a
// 40-second retry storm into an instant `null`.
const NEG_TTL_MS = Number(process.env.HTTP_NEGATIVE_TTL_MS ?? 20_000);

// Single-flight: identical concurrent GETs share one network round trip.
const inFlightByUrl = new Map<string, Promise<unknown>>();

interface FetchOpts {
  headers?:       Record<string, string>;
  revalidate?:    number;
  retries?:       number;
  cacheTtlMs?:    number;
  /** Per-attempt network timeout override (ms). */
  timeoutMs?:     number;
  /** Whole-call timeout override (ms). */
  totalTimeoutMs?: number;
}

function pruneCache(): void {
  if (memCache.size <= 500) return;
  const now = Date.now();
  for (const [k, v] of memCache) {
    if (now - v.at > (v.ok ? MEM_TTL_MS : NEG_TTL_MS)) memCache.delete(k);
  }
  // Still oversized (lots of fresh entries) — drop oldest insertions.
  if (memCache.size > 500) {
    const excess = memCache.size - 500;
    let i = 0;
    for (const k of memCache.keys()) {
      if (i++ >= excess) break;
      memCache.delete(k);
    }
  }
}

async function performRequest<T>(url: string, opts: FetchOpts): Promise<T | null> {
  const retries      = opts.retries ?? 2;
  const attemptMs    = opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const totalMs      = opts.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  const deadline     = Date.now() + totalMs;

  await acquire();
  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (Date.now() >= deadline) return null;

      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; GigiGivo/1.0)",
            Accept:       "application/json",
            ...(opts.headers ?? {}),
          },
          // Bounded attempt — also bounded by the remaining total budget.
          signal: AbortSignal.timeout(Math.max(1, Math.min(attemptMs, deadline - Date.now()))),
          next: opts.revalidate !== undefined ? { revalidate: opts.revalidate } : undefined,
        });

        // Rate-limited or transient server error → back off and retry.
        if (res.status === 429 || res.status >= 500) {
          if (attempt < retries) {
            const retryAfter = Number(res.headers.get("retry-after"));
            const backoff =
              !isNaN(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : Math.min(2000, 250 * 2 ** attempt) + Math.random() * 150;
            if (Date.now() + backoff >= deadline) return null;
            await sleep(backoff);
            continue;
          }
          return null;
        }

        // 4xx (other than 429) is a permanent answer — retrying wastes budget.
        if (!res.ok) return null;

        const data = (await res.json()) as T;
        memCache.set(url, { at: Date.now(), data, ok: true });
        pruneCache();
        return data;
      } catch {
        if (attempt < retries) {
          const backoff = Math.min(2000, 250 * 2 ** attempt) + Math.random() * 150;
          if (Date.now() + backoff >= deadline) return null;
          await sleep(backoff);
          continue;
        }
        return null;
      }
    }
    return null;
  } finally {
    release();
  }
}

/**
 * Resilient JSON GET. Returns parsed JSON or null (never throws).
 * Concurrency-limited, timeout-bounded, retries on 429/5xx with exponential
 * backoff, coalesces identical concurrent calls, and memoizes both successes
 * and failures for a short window.
 */
export async function resilientJson<T>(
  url:  string,
  opts: FetchOpts = {},
): Promise<T | null> {
  const ttl    = opts.cacheTtlMs ?? MEM_TTL_MS;
  const cached = memCache.get(url);
  if (cached) {
    const age = Date.now() - cached.at;
    if (cached.ok && age < ttl) return cached.data as T;
    // Negative cache hit — the upstream just failed; don't re-run the storm.
    if (!cached.ok && age < NEG_TTL_MS) return null;
  }

  // Single-flight: if the same URL is already being fetched, await that one.
  const existing = inFlightByUrl.get(url);
  if (existing) return (await existing) as T | null;

  const promise = performRequest<T>(url, opts)
    .then((data) => {
      if (data === null) {
        memCache.set(url, { at: Date.now(), data: null, ok: false });
        pruneCache();
      }
      return data;
    })
    .finally(() => {
      inFlightByUrl.delete(url);
    });

  inFlightByUrl.set(url, promise);
  return promise;
}

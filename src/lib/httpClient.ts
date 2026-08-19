// ĞIGI GIVØ — Shared resilient HTTP client.
// Protects external providers (ESPN, mesh) from 429s via:
//   • a global concurrency limiter (max N in-flight requests)
//   • retry with exponential backoff on 429 / 5xx
//   • honoring Retry-After when the provider sends it
//   • a tiny in-memory response cache to collapse duplicate bursts

const MAX_CONCURRENT = 6;
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
}
const memCache = new Map<string, CacheEntry>();
const MEM_TTL_MS = 60 * 1000; // 60 s

interface FetchOpts {
  headers?:    Record<string, string>;
  revalidate?: number;
  retries?:    number;
  cacheTtlMs?: number;
}

/**
 * Resilient JSON GET. Returns parsed JSON or null (never throws).
 * Concurrency-limited, retries on 429/5xx with exponential backoff,
 * and memoizes burst-duplicate requests.
 */
export async function resilientJson<T>(
  url:  string,
  opts: FetchOpts = {},
): Promise<T | null> {
  const ttl    = opts.cacheTtlMs ?? MEM_TTL_MS;
  const cached = memCache.get(url);
  if (cached && Date.now() - cached.at < ttl) {
    return cached.data as T;
  }

  const retries = opts.retries ?? 3;
  await acquire();
  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; GigiGivo/1.0)",
            Accept:       "application/json",
            ...(opts.headers ?? {}),
          },
          next: opts.revalidate !== undefined ? { revalidate: opts.revalidate } : undefined,
        });

        // Rate-limited or transient server error → back off and retry.
        if (res.status === 429 || res.status >= 500) {
          if (attempt < retries) {
            const retryAfter = Number(res.headers.get("retry-after"));
            const backoff =
              !isNaN(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : Math.min(4000, 300 * 2 ** attempt) + Math.random() * 200;
            await sleep(backoff);
            continue;
          }
          return null;
        }

        if (!res.ok) return null;

        const data = (await res.json()) as T;
        memCache.set(url, { at: Date.now(), data });

        // Opportunistic cache cleanup — keep map bounded.
        if (memCache.size > 500) {
          const cutoff = Date.now() - ttl;
          for (const [k, v] of memCache) if (v.at < cutoff) memCache.delete(k);
        }

        return data;
      } catch {
        if (attempt < retries) {
          await sleep(Math.min(4000, 300 * 2 ** attempt) + Math.random() * 200);
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

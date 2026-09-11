// ĞIGI GIVØ — Shared helpers for the per-source normalisers.
//
// Defensive parsing only: `unknown` in, typed primitives out. Every helper
// returns null (or an empty collection) instead of throwing, so a malformed
// payload from one source can never crash match processing.

// ─── Record / array narrowing ─────────────────────────────────────────────────

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ─── Primitive coercion ───────────────────────────────────────────────────────

export function asString(v: unknown): string | null {
  if (typeof v === "string") {
    const s = v.trim();
    return s.length ? s : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.trim().replace(",", ".").replace("%", "").trim();
    if (cleaned === "") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Extract a number from a messy string like "55%", "1,234", "12.5 km". */
export function asNumberLoose(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const m = v.replace(",", ".").match(/-?\d+(?:\.\d+)?/);
    return m ? (Number.isFinite(Number(m[0])) ? Number(m[0]) : null) : null;
  }
  return null;
}

export function asBoolean(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "1", "y"].includes(s)) return true;
    if (["false", "no", "0", "n"].includes(s)) return false;
  }
  return null;
}

/** Safely walk a dotted path ("teams.home.name") through arbitrary JSON. */
export function getPath(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const key of path.split(".")) {
    const rec = asRecord(node);
    if (!rec) return null;
    node = rec[key];
  }
  return node ?? null;
}

// ─── Team-name matching ───────────────────────────────────────────────────────

const NAME_STOPWORDS = new Set([
  "fc", "cf", "afc", "sc", "ac", "as", "sv", "vfl", "vfb", "tsg", "club",
  "de", "the", "and", "1", "04", "05", "1846", "1899", "calcio", "football",
  "soccer", "united", "city", "town", "wanderers", "athletic", "rangers",
]);

/** Normalise a team name (lowercase, accents stripped, alphanumerics only). */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function significantWords(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !NAME_STOPWORDS.has(w));
}

/** Loose team-name equality across providers ("Bayern München" ≈ "FC Bayern Munich"). */
export function namesMatch(a: unknown, b: unknown): boolean {
  const sa = asString(a);
  const sb = asString(b);
  if (!sa || !sb) return false;
  const A = normalizeName(sa);
  const B = normalizeName(sb);
  if (!A || !B) return false;
  if (A === B || A.includes(B) || B.includes(A)) return true;
  const wa = significantWords(sa);
  const wb = significantWords(sb);
  return wa.length > 0 && wb.length > 0 && wa.some((w) => wb.includes(w));
}

/** Round a value to `dp` decimals without floating-point noise. */
export function roundTo(v: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Percent-safe division that returns null instead of NaN/Infinity. */
export function pct(numerator: number, denominator: number, dp = 2): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return roundTo((numerator / denominator) * 100, dp);
}

// ─── Error diagnostics ────────────────────────────────────────────────────────

/**
 * Fetch the raw response body of an already-failed request, for error
 * diagnostics ONLY (e.g. printing the exact API-Football 403 body so an
 * operator can tell expired key / plan restriction / rate limit apart).
 *
 * Called on error paths only — it never adds latency to successful fetches.
 * Returns the (truncated) body text, or null when the host cannot be reached
 * at all (in which case the network error is the more useful log line).
 */
export async function fetchErrorBody(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 8_000,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; GigiGivo/1.0)", ...headers },
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    return text.slice(0, 1_000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

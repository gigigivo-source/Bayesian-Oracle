// ĞIGI GIVØ — Statistical primitives
// Poisson, Negative Binomial, Beta-Binomial, Wilson Score CI, seeded RNG.

// ─── Hashing & RNG ────────────────────────────────────────────────────────────

/** Deterministic string → 32-bit hash (FNV-1a). */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 seeded PRNG factory. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Special functions ────────────────────────────────────────────────────────

/** log-gamma via Lanczos approximation (accurate to ~15 significant figures). */
export function logGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851,  -1259.1392167224028,
    771.32342877765313,  -176.61502916214059,  12.507343278686905,
    -0.13857109526572012,  9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

export function factorialLog(n: number): number {
  return logGamma(n + 1);
}

// ─── Poisson ──────────────────────────────────────────────────────────────────

/** Poisson PMF P(X = k). */
export function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(k * Math.log(lambda) - lambda - factorialLog(k));
}

/** Poisson P(X ≥ k) — survival function. */
export function poissonSf(k: number, lambda: number): number {
  if (k <= 0) return 1;
  let cdf = 0;
  for (let i = 0; i < k; i++) cdf += poissonPmf(i, lambda);
  return Math.max(0, Math.min(1, 1 - cdf));
}

/** Poisson P(X ≤ k) — CDF. */
export function poissonCdf(k: number, lambda: number): number {
  let cdf = 0;
  for (let i = 0; i <= k; i++) cdf += poissonPmf(i, lambda);
  return Math.max(0, Math.min(1, cdf));
}

/** P(X > line) for a .5 line: P(X ≥ ceil(line)). */
export function poissonOver(line: number, lambda: number): number {
  return poissonSf(Math.ceil(line), lambda);
}

/** Alias: P(X ≥ k) for callers using the old poissonGe name. */
export const poissonGe = poissonSf;

// ─── Negative Binomial ────────────────────────────────────────────────────────

/**
 * Negative Binomial PMF (over-dispersed count distribution).
 * Parameterised by mean + size (dispersion). Used for cards & fouls.
 */
export function negBinomPmf(k: number, mean: number, size: number): number {
  if (mean <= 0) return k === 0 ? 1 : 0;
  const p = size / (size + mean);
  return Math.exp(
    logGamma(k + size) - logGamma(size) - factorialLog(k) +
    size * Math.log(p) + k * Math.log(1 - p),
  );
}

/** P(X > line) for Negative Binomial(mean, size). */
export function negBinomOver(line: number, mean: number, size = 6): number {
  const target = Math.ceil(line);
  let cdf = 0;
  for (let i = 0; i < target; i++) cdf += negBinomPmf(i, mean, size);
  return Math.max(0, Math.min(1, 1 - cdf));
}

// ─── Beta-Binomial ────────────────────────────────────────────────────────────

/**
 * Beta-Binomial P(X > line) for bounded counts (corners, throw-ins).
 * n = number of trials, conc = concentration (precision of Beta prior).
 * Computed in log-space for numerical stability.
 */
export function betaBinomOver(
  line: number,
  mean: number,
  n:    number,
  conc = 8,
): number {
  const pMean = Math.min(0.98, Math.max(0.02, mean / n));
  const alpha = pMean * conc;
  const beta  = (1 - pMean) * conc;
  const target = Math.ceil(line);
  let cdf = 0;
  for (let i = 0; i < target && i <= n; i++) {
    const logPmf =
      logGamma(n + 1) - logGamma(i + 1) - logGamma(n - i + 1) +
      logGamma(i + alpha) + logGamma(n - i + beta) - logGamma(n + alpha + beta) +
      logGamma(alpha + beta) - logGamma(alpha) - logGamma(beta);
    cdf += Math.exp(logPmf);
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}

// ─── Wilson Score CI ──────────────────────────────────────────────────────────

/** Wilson score confidence interval for a proportion given effective sample n. */
export function wilsonInterval(
  p: number,
  n: number,
  z = 1.645, // 90% CI
): { lower: number; upper: number } {
  if (n <= 0) return { lower: p, upper: p };
  const denom  = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

/** Tuple-return alias for callers that destructure [lower, upper]. */
export function wilsonCI(p: number, n: number, z = 1.645): [number, number] {
  const { lower, upper } = wilsonInterval(p, n, z);
  return [lower, upper];
}

// ─── Ensemble statistics ──────────────────────────────────────────────────────

/** Coefficient of variation of an array (StdDev / Mean). */
export function coefficientOfVariation(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/** Trimmed mean — removes top & bottom `trim` fraction. */
export function trimmedMean(values: number[], trim = 0.1): number {
  const sorted = [...values].sort((a, b) => a - b);
  const k      = Math.floor(sorted.length * trim);
  const kept   = sorted.slice(k, sorted.length - k);
  if (kept.length === 0) return sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

/** Shannon entropy (normalised 0..1) for a binary probability. */
export function binaryEntropy(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function round(x: number, d = 4): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

/** Round a number to `dp` decimal places — alias kept for compat. */
export { round as roundTo };

// ─── Positional xG (kept here for convenience — also in xg.ts) ───────────────

/**
 * Simple logistic xG from shot coordinates (StatsBomb 120×80 pitch).
 * Goal centre = (120, 40). Used by realLambdas for finishing-quality calibration.
 */
export function calculateXg(
  location:  [number, number],
  bodyPart:  string,
  technique: string,
): number {
  const [x, y] = location;
  const dist   = Math.sqrt((120 - x) ** 2 + (40 - y) ** 2);
  const angle  = Math.atan2(7.32 * (120 - x), (120 - x) ** 2 + (40 - y) ** 2 - (7.32 / 2) ** 2);
  const angleDeg = Math.abs(angle * 180 / Math.PI);
  const logit  = -3.19 + (-0.095 * dist) + (0.030 * angleDeg);
  let xg       = 1 / (1 + Math.exp(-logit));
  if (bodyPart === "Head")    xg *= 0.55;
  if (bodyPart === "Other")   xg *= 0.40;
  if (technique === "Volley")          xg *= 0.75;
  if (technique === "Overhead Kick")   xg *= 0.50;
  if (technique === "Backheel")        xg *= 0.60;
  if (technique === "Diving Header")   xg *= 0.65;
  return Math.max(0.01, Math.min(0.99, xg));
}

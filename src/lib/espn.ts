// ĞIGI GIVØ — Real football data layer (ESPN public API, no key required).
import { LEAGUE_MAP } from "./leagues";
import { resilientJson } from "./httpClient";
import {
  OPENFOOTBALL_CODES,
  fullTimeScore,
  seasonCodes,
  teamsMatch,
} from "./data/historical";

const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const OPENFOOTBALL_REPO = "openfootball/football.json";
const OPENFOOTBALL_TTL_MS = 30 * 60_000;

async function espnFetch<T>(
  url: string,
  cacheTtlMs = 60_000,
  opts?: { retries?: number; timeoutMs?: number; totalTimeoutMs?: number },
): Promise<T | null> {
  return resilientJson<T>(url, {
    revalidate: Math.max(1, Math.ceil(cacheTtlMs / 1000)),
    cacheTtlMs,
    ...opts,
  });
}

// ─── Core types ───────────────────────────────────────────────────────────────

export interface TeamLite {
  id:        string;
  name:      string;
  shortName: string;
  abbrev:    string;
  logo:      string | null;
  color:     string | null;
  score:     string | null;
  homeAway:  "home" | "away";
  record?:   string | null;
  form?:     string | null;
}

/** Legacy alias — keeps oracle/engine code that accesses TeamInfo fields working */
export type TeamInfo = TeamLite;

export interface OddsInfo {
  details?:   string;
  overUnder?: number;
  homeML?:    number | null;
  awayML?:    number | null;
  drawML?:    number | null;
  provider?:  string;
}

export interface FixtureLite {
  id:           string;
  leagueSlug:   string;
  leagueName:   string;
  date:         string;         // ISO
  state:        "pre" | "in" | "post";
  statusDetail: string;
  clock?:       string;
  venue:        string | null;
  home:         TeamLite;
  away:         TeamLite;
  neutralSite:  boolean;
  odds?:        OddsInfo | null;
  matchweek?:   number;
}

// ─── ESPN raw shapes ──────────────────────────────────────────────────────────

interface EspnScoreboard {
  leagues?: Array<{ name?: string; slug?: string; calendar?: string[] }>;
  week?:    { number?: number };
  events?:  EspnEvent[];
}

interface EspnEvent {
  id:           string;
  date:         string;
  name:         string;
  season?:      { slug?: string };
  week?:        { number?: number } | number;
  matchweek?:   number;
  status?:      EspnStatus;
  competitions?: EspnCompetition[];
}

interface EspnStatus {
  type?:         { state?: string; detail?: string; shortDetail?: string };
  displayClock?: string;
}

interface EspnCompetition {
  venue?:       { fullName?: string; address?: { city?: string; country?: string } };
  neutralSite?: boolean;
  competitors?: EspnCompetitor[];
  odds?:        EspnOdds[];
  status?:      EspnStatus;
  /** Competition display name supplied per event by the `soccer/all` feed. */
  altGameNote?: string;
}

interface EspnCompetitor {
  homeAway: "home" | "away";
  score?:   string;
  records?: Array<{ summary?: string; type?: string }>;
  form?:    string;
  team?:    {
    id?:              string;
    displayName?:     string;
    shortDisplayName?: string;
    abbreviation?:    string;
    logo?:            string;
    logos?:           Array<{ href?: string }>;
    color?:           string;
  };
}

interface EspnOdds {
  provider?:      { name?: string };
  details?:       string;
  overUnder?:     number;
  homeTeamOdds?:  { moneyLine?: number };
  awayTeamOdds?:  { moneyLine?: number };
  drawOdds?:      { moneyLine?: number };
}

// ─── Normalisation ────────────────────────────────────────────────────────────

function normalizeTeam(c: EspnCompetitor): TeamLite {
  const t   = c.team ?? {};
  const logo = t.logo ?? t.logos?.[0]?.href ?? null;
  const rec  = c.records?.find((r) => r.type === "total") ?? c.records?.[0];
  return {
    id:        t.id          ?? "",
    name:      t.displayName ?? "Unknown",
    shortName: t.shortDisplayName ?? t.displayName ?? "Unknown",
    abbrev:    t.abbreviation ?? "",
    logo,
    color:  t.color ? `#${t.color}` : null,
    score:  c.score ?? null,
    homeAway: c.homeAway,
    record: rec?.summary ?? null,
    form:   c.form ?? null,
  };
}

function normalizeOdds(o: EspnOdds): OddsInfo {
  return {
    details:   o.details,
    overUnder: o.overUnder,
    homeML:    o.homeTeamOdds?.moneyLine ?? null,
    awayML:    o.awayTeamOdds?.moneyLine ?? null,
    drawML:    o.drawOdds?.moneyLine     ?? null,
    provider:  o.provider?.name,
  };
}

function seasonCompetitionName(seasonSlug: string | undefined): string {
  if (!seasonSlug) return "Other Competition";
  return seasonSlug
    .replace(/^\d{4}(?:-\d{2,4})?-/, "")
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || "Other Competition";
}

function extractEventWeek(ev: EspnEvent): number | undefined {
  const raw = typeof ev.matchweek === "number"
    ? ev.matchweek
    : typeof ev.week === "number"
      ? ev.week
      : typeof ev.week?.number === "number"
        ? ev.week.number
        : undefined;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

function normalizeEvent(ev: EspnEvent, slug: string, leagueName: string): FixtureLite | null {
  const comp = ev.competitions?.[0];
  if (!comp?.competitors || comp.competitors.length < 2) return null;
  const home = comp.competitors.find((c) => c.homeAway === "home");
  const away = comp.competitors.find((c) => c.homeAway === "away");
  if (!home || !away) return null;

  const o           = comp.odds?.[0];
  const venueCity   = comp.venue?.address?.city;
  const venue       = comp.venue?.fullName
    ? `${comp.venue.fullName}${venueCity ? `, ${venueCity}` : ""}`
    : null;
  // The global scoreboard has no top-level league name. It supplies the real
  // competition name on each event instead, while the special `all` slug
  // remains valid for ESPN summary/boxscore requests for that event.
  const eventLeagueName = slug === "all"
    ? comp.altGameNote?.trim() || seasonCompetitionName(ev.season?.slug)
    : leagueName;
  // Some global-scoreboard payloads only put the current status on the first
  // competition. Prefer the event status, but use that competition status as
  // a fallback so in-play scores are never normalised as pre-match.
  const status = ev.status ?? comp.status;
  const matchweek = extractEventWeek(ev);

  return {
    id:          ev.id,
    leagueSlug:  slug,
    leagueName:  eventLeagueName,
    date:        ev.date,
    state:       (status?.type?.state as FixtureLite["state"]) ?? "pre",
    statusDetail: status?.type?.shortDetail ?? status?.type?.detail ?? "",
    clock:       status?.displayClock,
    venue,
    neutralSite: comp.neutralSite ?? false,
    home:        normalizeTeam(home),
    away:        normalizeTeam(away),
    odds:        o ? normalizeOdds(o) : null,
    ...(matchweek !== undefined ? { matchweek } : {}),
  };
}

// ─── Public: scoreboard ───────────────────────────────────────────────────────

function normalizeScoreboard(
  data: EspnScoreboard,
  slug: string,
  fallbackLeagueName: string,
): FixtureLite[] {
  const name = data.leagues?.[0]?.name ?? fallbackLeagueName;
  const seen = new Set<string>();
  return (data.events ?? [])
    .map((event) => normalizeEvent(event, slug, name))
    .filter((fixture): fixture is FixtureLite => {
      if (!fixture || seen.has(fixture.id)) return false;
      seen.add(fixture.id);
      return true;
    });
}

/**
 * Fetch ESPN's global soccer scoreboard in one request. Unlike the curated
 * home feed, this endpoint contains every competition ESPN is covering on the
 * requested day, so the Live tab cannot silently omit a match just because its
 * league is absent from one of our local lists.
 *
 * `null` means the upstream feed was unavailable; an empty array is a valid
 * successful scoreboard with no events. The shorter internal cache keeps live
 * clocks and scores fresh without restoring the old 70-request polling fanout.
 */
export async function fetchAllScoreboard(dates: string): Promise<FixtureLite[] | null> {
  const url = `${BASE}/all/scoreboard?dates=${dates}&limit=1000`;
  const data = await espnFetch<EspnScoreboard>(url, 12_000);
  if (!data?.events) return null;
  return normalizeScoreboard(data, "all", "Other Competition");
}

// ─── Day helpers ──────────────────────────────────────────────────────────────

/** Parse a strict "YYYYMMDD" day key as UTC midnight. `null` when invalid. */
function parseDayKey(value: string): Date | null {
  if (!/^\d{8}$/.test(value)) return null;
  const year  = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day   = Number(value.slice(6, 8));
  const date  = new Date(Date.UTC(year, month - 1, day));
  const valid = date.getUTCFullYear() === year
    && date.getUTCMonth()    === month - 1
    && date.getUTCDate()     === day;
  return valid ? date : null;
}

/**
 * Expand a "YYYYMMDD" range into an inclusive list of "YYYYMMDD" days, walking
 * UTC in 1-day steps. A same-day or reversed range collapses to the start day;
 * a start value that is not a day key yields an empty list so the caller can
 * pass the original value through untouched.
 */
function enumerateDays(from: string, to: string): string[] {
  const start = parseDayKey(from);
  if (!start) return [];
  const end = parseDayKey(to);
  if (!end || end.getTime() <= start.getTime()) return [from];

  const days: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 24 * 60 * 60 * 1000) {
    days.push(new Date(t).toISOString().slice(0, 10).replace(/-/g, ""));
  }
  return days;
}

// ─── Matchweek helpers ────────────────────────────────────────────────────────

export interface OpenfootballScheduleRow {
  round?:  string;
  date?:   string;
  time?:   string;
  team1?:  string;
  team2?:  string;
  score?:  { ht?: number[]; ft?: number[] } | number[] | null;
  status?: string;
}

function parseRoundNumber(round: string | undefined): number | null {
  if (!round) return null;
  const match = round.match(
    /(?:matchday|matchweek|round|md|mday|jornada|journ[ée]e|spieltag)\s*(\d+)/i,
  );
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function fetchOpenfootballSeasonRows(
  slug: string,
  now = new Date(),
): Promise<OpenfootballScheduleRow[] | null> {
  const code = OPENFOOTBALL_CODES[slug];
  if (!code) return null;
  const repo = (process.env.HISTORICAL_OPENFOOTBALL_REPO ?? OPENFOOTBALL_REPO).replace(
    /^\/+|\/+$/g,
    "",
  );
  const season = seasonCodes(now, 1)[0];
  const url = `https://api.github.com/repos/${repo}/contents/${season}/${code}.json`;
  const data = await resilientJson<
    { matches?: OpenfootballScheduleRow[] } | OpenfootballScheduleRow[]
  >(url, {
    headers: { Accept: "application/vnd.github.raw+json" },
    revalidate: 1800,
    cacheTtlMs: OPENFOOTBALL_TTL_MS,
  });
  if (!data) return null;
  return Array.isArray(data) ? data : (data.matches ?? []);
}

function openfootballRowToFixture(
  row: OpenfootballScheduleRow,
  slug: string,
  leagueName: string,
  week: number,
): FixtureLite | null {
  const home = row.team1?.trim();
  const away = row.team2?.trim();
  const date = row.date?.trim();
  if (!home || !away || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const rawTime = row.time?.trim() ?? "";
  const time = /^\d{1,2}:\d{2}/.test(rawTime) ? rawTime : "15:00";
  const [hours, minutes] = time.split(":");
  const isoDate = `${date}T${hours.padStart(2, "0")}:${minutes}:00Z`;
  const ft = fullTimeScore(row.score);
  const statusText = row.status?.trim();

  return {
    id:           `openfootball:${slug}:mw${week}:${date}:${home}-${away}`,
    leagueSlug:   slug,
    leagueName,
    date:         isoDate,
    state:        ft ? "post" : "pre",
    statusDetail: ft ? statusText || "Full Time" : statusText || row.round?.trim() || `Matchweek ${week}`,
    venue:        null,
    neutralSite:  false,
    home: {
      id:        "",
      name:      home,
      shortName: home,
      abbrev:    home.slice(0, 3).toUpperCase(),
      logo:      null,
      color:     null,
      score:     ft ? String(ft[0]) : null,
      homeAway:  "home",
    },
    away: {
      id:        "",
      name:      away,
      shortName: away,
      abbrev:    away.slice(0, 3).toUpperCase(),
      logo:      null,
      color:     null,
      score:     ft ? String(ft[1]) : null,
      homeAway:  "away",
    },
    odds:      null,
    matchweek: week,
  };
}

function addUtcDays(dayKey: string, deltaDays: number): string {
  const d = parseDayKey(dayKey);
  if (!d) return dayKey;
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function buildMatchweekWindowDays(fixtures: FixtureLite[]): string[] {
  const uniqueDays = [...new Set(fixtures.map((f) => f.date.slice(0, 10).replace(/-/g, "")))]
    .filter((d) => parseDayKey(d) !== null)
    .sort();
  if (uniqueDays.length === 0) return [];

  // Cluster dates within 5 days so postponed outlier fixtures don't expand into
  // a multi-month loop, then pad each cluster [-2d, +3d] to catch Fri/Mon TV shifts.
  const clusters: string[][] = [];
  for (const day of uniqueDays) {
    const last = clusters[clusters.length - 1];
    if (!last) {
      clusters.push([day]);
      continue;
    }
    const prevMs = parseDayKey(last[last.length - 1])!.getTime();
    const curMs = parseDayKey(day)!.getTime();
    if (curMs - prevMs <= 5 * 86_400_000) {
      last.push(day);
    } else {
      clusters.push([day]);
    }
  }

  const out = new Set<string>();
  for (const cluster of clusters) {
    const start = addUtcDays(cluster[0], -2);
    const end = addUtcDays(cluster[cluster.length - 1], 3);
    for (const d of enumerateDays(start, end)) {
      out.add(d);
      if (out.size >= 14) break;
    }
    if (out.size >= 14) break;
  }
  return [...out].sort();
}

function clusterCalendarDays(calendar: string[], week: number): string[] {
  const dayKeys = [
    ...new Set(
      calendar
        .map((iso) => {
          const parsed = new Date(iso);
          return Number.isNaN(parsed.getTime())
            ? null
            : parsed.toISOString().slice(0, 10).replace(/-/g, "");
        })
        .filter((d): d is string => d !== null && parseDayKey(d) !== null),
    ),
  ].sort();

  const clusters: string[][] = [];
  for (const day of dayKeys) {
    const last = clusters[clusters.length - 1];
    if (!last) {
      clusters.push([day]);
      continue;
    }
    const prevMs = parseDayKey(last[last.length - 1])!.getTime();
    const curMs = parseDayKey(day)!.getTime();
    if (curMs - prevMs >= 3 * 86_400_000) {
      clusters.push([day]);
    } else {
      last.push(day);
    }
  }
  return clusters[week - 1] ?? [];
}

/** Optional archived schedule for deterministic replays. mergeEspn=false
 * keeps the reader entirely offline; production callers retain ESPN merging. */
export interface ScoreboardScheduleSnapshot {
  rows: readonly OpenfootballScheduleRow[];
  mergeEspn?: boolean;
}

async function fetchMatchweekFixtures(
  slug: string,
  leagueName: string,
  week: number,
  probeData: EspnScoreboard | null,
  snapshot?: ScoreboardScheduleSnapshot,
): Promise<FixtureLite[]> {
  const rows = snapshot?.rows ?? await fetchOpenfootballSeasonRows(slug);
  const weekRows = (rows ?? []).filter((r) => parseRoundNumber(r.round) === week);
  const ofFixtures = weekRows
    .map((r) => openfootballRowToFixture(r, slug, leagueName, week))
    .filter((f): f is FixtureLite => f !== null);

  if (ofFixtures.length > 0 && snapshot?.mergeEspn === false) {
    return ofFixtures.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  }

  let espnData = probeData;
  if (!espnData) {
    // ESPN soccer may answer HTTP 400 to ?week=X; verify base scoreboard once
    // (negative-cached in httpClient) before concluding ESPN is unreachable.
    espnData = await espnFetch<EspnScoreboard>(`${BASE}/${slug}/scoreboard?limit=1`, 60_000, {
      retries: 0,
      timeoutMs: 3000,
      totalTimeoutMs: 3500,
    });
  }

  if (ofFixtures.length > 0) {
    if (espnData !== null) {
      const days = buildMatchweekWindowDays(ofFixtures);
      if (days.length > 0) {
        const boards = await Promise.all(
          days.map((day) =>
            espnFetch<EspnScoreboard>(`${BASE}/${slug}/scoreboard?dates=${day}&limit=50`),
          ),
        );
        const espnPool: FixtureLite[] = [];
        const seen = new Set<string>();
        for (const board of boards) {
          if (!board?.events) continue;
          for (const fx of normalizeScoreboard(board, slug, leagueName)) {
            if (seen.has(fx.id)) continue;
            seen.add(fx.id);
            espnPool.push(fx);
          }
        }
        if (espnPool.length > 0) {
          return ofFixtures
            .map((ofFx) => {
              const match = espnPool.find(
                (ef) =>
                  teamsMatch(ofFx.home.name, ef.home.name) &&
                  teamsMatch(ofFx.away.name, ef.away.name),
              );
              return match ? { ...match, matchweek: week } : ofFx;
            })
            .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        }
      }
    }
    return ofFixtures.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }

  // Fallback for leagues without an openfootball schedule: cluster ESPN's
  // season calendar dates into matchweeks when available.
  const calendar = espnData?.leagues?.[0]?.calendar;
  if (calendar?.length) {
    const days = clusterCalendarDays(calendar, week);
    if (days.length > 0) {
      const boards = await Promise.all(
        days.map((day) =>
          espnFetch<EspnScoreboard>(`${BASE}/${slug}/scoreboard?dates=${day}&limit=50`),
        ),
      );
      const seen = new Set<string>();
      const out: FixtureLite[] = [];
      for (const board of boards) {
        if (!board?.events) continue;
        for (const fx of normalizeScoreboard(board, slug, leagueName)) {
          if (seen.has(fx.id)) continue;
          seen.add(fx.id);
          out.push({ ...fx, matchweek: week });
        }
      }
      return out.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    }
  }

  return [];
}

/**
 * Determine the current (active or next upcoming) matchweek for a league slug,
 * defaulting to 11 when the season schedule is unavailable.
 */
export async function getCurrentMatchweek(
  slug: string,
  now = new Date(),
): Promise<number> {
  const rows = await fetchOpenfootballSeasonRows(slug, now);
  if (!rows || rows.length === 0) return 11;

  const byWeek = new Map<number, { minDate: string; maxDate: string }>();
  for (const row of rows) {
    const w = parseRoundNumber(row.round);
    const d = row.date?.trim();
    if (!w || !d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const cur = byWeek.get(w);
    if (!cur) {
      byWeek.set(w, { minDate: d, maxDate: d });
    } else {
      if (d < cur.minDate) cur.minDate = d;
      if (d > cur.maxDate) cur.maxDate = d;
    }
  }
  if (byWeek.size === 0) return 11;

  const weeks = [...byWeek.entries()].sort((a, b) => a[0] - b[0]);
  const graceDate = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
  for (const [w, span] of weeks) {
    if (span.maxDate >= graceDate) return w;
  }
  return weeks[weeks.length - 1][0];
}

/**
 * Fetch fixtures for a league slug.
 * @param slug    ESPN league slug e.g. "eng.1"
 * @param dates   Optional date string "YYYYMMDD" or range "YYYYMMDD-YYYYMMDD".
 *                A range is fetched day-by-day (ESPN answers HTTP 400 to
 *                multi-day ranges) and merged, deduplicated by event id.
 *                When omitted (and no `week` provided), fetches a 3-day window
 *                (yesterday → tomorrow) to catch all live, upcoming and very
 *                recently finished matches.
 * @param week    Optional matchweek number (1–38). Probes ESPN `?week=X` first;
 * @param scheduleSnapshot Optional archived rows; set mergeEspn=false for no network.
 *                if ESPN soccer omits week metadata (or is unreachable), resolves
 *                the exact matchweek fixtures from the season schedule and merges
 *                ESPN scores/states for those match dates.
 */
export async function fetchScoreboard(
  slug:   string,
  dates?: string | null,
  week?:  number,
  scheduleSnapshot?: ScoreboardScheduleSnapshot,
): Promise<FixtureLite[]> {
  const leagueName = LEAGUE_MAP[slug]?.name ?? slug;

  if (typeof week === "number" && Number.isInteger(week) && week > 0 && !dates) {
    if (slug === "all") return [];

    const probeUrl = `${BASE}/${slug}/scoreboard?week=${week}&limit=50`;
    const probeData = scheduleSnapshot ? null : await espnFetch<EspnScoreboard>(probeUrl, 60_000, {
      retries: 1,
      timeoutMs: 4000,
      totalTimeoutMs: 6000,
    });

    const hasExplicitWeek =
      probeData?.week?.number === week ||
      (probeData?.events ?? []).some((ev) => extractEventWeek(ev) === week);

    if (probeData && hasExplicitWeek) {
      const normalized = normalizeScoreboard(probeData, slug, leagueName);
      const hasEventWeeks = normalized.some((f) => f.matchweek !== undefined);
      const matched = hasEventWeeks
        ? normalized.filter((f) => f.matchweek === week)
        : normalized.map((f) => ({ ...f, matchweek: week }));
      if (matched.length > 0) return matched;
    }

    return fetchMatchweekFixtures(slug, leagueName, week, probeData, scheduleSnapshot);
  }

  // When no date supplied, fetch a 3-day window: yesterday, today, tomorrow.
  // This guarantees today's matches always appear regardless of ESPN's default
  // scoreboard window, and catches live matches that started yesterday UTC.
  if (!dates) {
    const now       = new Date();
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    const tomorrow  = new Date(now); tomorrow.setDate(now.getDate() + 1);
    const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
    dates = `${fmt(yesterday)}-${fmt(tomorrow)}`;
  }

  // ESPN rejects multi-day ranges with HTTP 400, so a range is expanded into
  // one single-day request per day and the events are merged (deduplicated by
  // id). Single-day values skip this and keep the one-request path below.
  if (dates.includes("-")) {
    const [from, to] = dates.split("-");
    const days = enumerateDays(from, to);
    if (days.length > 0) {
      const seen   = new Set<string>();
      const merged: FixtureLite[] = [];
      for (const day of days) {
        const partial = await fetchScoreboard(slug, day);
        for (const fixture of partial) {
          if (seen.has(fixture.id)) continue;
          seen.add(fixture.id);
          merged.push(fixture);
        }
      }
      if (typeof week === "number" && Number.isInteger(week) && week > 0) {
        return merged.filter((f) => f.matchweek === week);
      }
      return merged;
    }
  }

  if (slug === "all") return (await fetchAllScoreboard(dates)) ?? [];

  const url  = `${BASE}/${slug}/scoreboard?dates=${dates}&limit=50`;
  const data = await espnFetch<EspnScoreboard>(url);
  if (!data?.events) return [];
  const normalized = normalizeScoreboard(data, slug, leagueName);
  if (typeof week === "number" && Number.isInteger(week) && week > 0) {
    return normalized.filter((f) => f.matchweek === week);
  }
  return normalized;
}

// ─── Match summary ────────────────────────────────────────────────────────────

export interface FormGame {
  date:         string;
  opponent:     string;
  opponentLogo: string | null;
  result:       "W" | "L" | "D" | string;
  scoreFor:     number;
  scoreAgainst: number;
  atVs:         string;
  competition:  string;
}

export interface TeamForm {
  teamId:   string;
  teamName: string;
  games:    FormGame[];
  gfAvg:    number;
  gaAvg:    number;
  points:   number;
}

export interface LineupPlayer {
  name:      string;
  jersey?:   string;
  position?: string;
  starter:   boolean;
}

export interface MatchSummary {
  odds:            OddsInfo | null;
  homeForm:        TeamForm | null;
  awayForm:        TeamForm | null;
  h2h:             Array<{ date: string; home: string; away: string; score: string }>;
  homeLineup:      LineupPlayer[];
  awayLineup:      LineupPlayer[];
  lineupAvailable: boolean;
  homeFormation:   string | null;
  awayFormation:   string | null;
  venue:           string | null;
  boxscore:        EspnBoxscoreStats | null;
}

/**
 * Per-team set-piece/discipline counts from the ESPN summary boxscore.
 * Every field is null when the boxscore omits that stat — null means "no
 * data", never zero, so settlement can tell 0 cards apart from a missing feed.
 */
export interface EspnBoxscoreStats {
  homeCorners:     number | null;
  awayCorners:     number | null;
  homeYellowCards: number | null;
  awayYellowCards: number | null;
  homeRedCards:    number | null;
  awayRedCards:    number | null;
}

// ─── ESPN Summary API shapes ──────────────────────────────────────────────────

interface EspnFormEvent {
  gameDate?:       string;
  opponent?:       { displayName?: string };
  opponentLogo?:   string;
  gameResult?:     string;
  homeTeamId?:     string;
  awayTeamId?:     string;
  homeTeamScore?:  string;
  awayTeamScore?:  string;
  atVs?:           string;
  leagueName?:     string;
}

interface EspnFormEntry {
  team?:   { id?: string; displayName?: string };
  events?: EspnFormEvent[];
}

interface EspnSummary {
  pickcenter?:      EspnOdds[];
  lastFiveGames?:   EspnFormEntry[];
  headToHeadGames?: Array<{
    events?: Array<{
      gameDate?:      string;
      homeTeam?:      { displayName?: string };
      awayTeam?:      { displayName?: string };
      homeTeamScore?: string;
      awayTeamScore?: string;
    }>;
  }>;
  rosters?: Array<{
    homeAway?:  string;
    formation?: string;
    team?:      { id?: string };
    roster?:    Array<{
      starter?:  boolean;
      jersey?:   string;
      position?: { abbreviation?: string };
      athlete?:  { displayName?: string };
    }>;
  }>;
  gameInfo?: { venue?: { fullName?: string } };
  boxscore?: {
    teams?: Array<{
      homeAway?:   string;
      team?:       { displayName?: string };
      statistics?: Array<{ name?: string; displayValue?: string }>;
    }>;
  };
}

// ─── Form builder ────────────────────────────────────────────────────────────

function buildForm(entry: EspnFormEntry): TeamForm | null {
  if (!entry?.team?.id) return null;
  const teamId = entry.team.id;
  const games: FormGame[] = [];
  let gf = 0, ga = 0, pts = 0;

  for (const ev of entry.events ?? []) {
    const isHome     = ev.homeTeamId === teamId;
    const scoreFor   = Number(isHome ? ev.homeTeamScore : ev.awayTeamScore) || 0;
    const scoreAgainst = Number(isHome ? ev.awayTeamScore : ev.homeTeamScore) || 0;
    gf += scoreFor; ga += scoreAgainst;
    const result = ev.gameResult ?? (scoreFor > scoreAgainst ? "W" : scoreFor < scoreAgainst ? "L" : "D");
    if (result === "W") pts += 3; else if (result === "D") pts += 1;
    games.push({
      date:         ev.gameDate       ?? "",
      opponent:     ev.opponent?.displayName ?? "?",
      opponentLogo: ev.opponentLogo   ?? null,
      result,
      scoreFor,
      scoreAgainst,
      atVs:         ev.atVs           ?? "",
      competition:  ev.leagueName     ?? "",
    });
  }

  const n = games.length || 1;
  return { teamId, teamName: entry.team.displayName ?? "", games, gfAvg: gf / n, gaAvg: ga / n, points: pts };
}

// ─── Boxscore builder ────────────────────────────────────────────────────────

function parseBoxscoreStat(
  stats: Array<{ name?: string; displayValue?: string }> | undefined,
  statName: string,
): number | null {
  const entry = stats?.find((s) => s.name === statName);
  if (!entry) return null;
  const value = Number(entry.displayValue);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Read the corners/cards counts out of an ESPN summary payload's boxscore.
 * Sides resolve by `homeAway` with an index fallback (home first), mirroring
 * the settlement boxscore reader. Null when the payload carries no boxscore
 * or none of the stats we read — callers treat that as "no data".
 */
function parseSummaryBoxscore(data: EspnSummary): EspnBoxscoreStats | null {
  const teams = data.boxscore?.teams;
  if (!teams || teams.length < 2) return null;
  const home = teams.find((t) => t.homeAway === "home") ?? teams[0];
  const away = teams.find((t) => t.homeAway === "away") ?? teams[1];
  const stats: EspnBoxscoreStats = {
    homeCorners:     parseBoxscoreStat(home.statistics, "wonCorners"),
    awayCorners:     parseBoxscoreStat(away.statistics, "wonCorners"),
    homeYellowCards: parseBoxscoreStat(home.statistics, "yellowCards"),
    awayYellowCards: parseBoxscoreStat(away.statistics, "yellowCards"),
    homeRedCards:    parseBoxscoreStat(home.statistics, "redCards"),
    awayRedCards:    parseBoxscoreStat(away.statistics, "redCards"),
  };
  const hasAny = Object.values(stats).some((v) => v !== null);
  return hasAny ? stats : null;
}

// ─── Public: match summary ────────────────────────────────────────────────────

export async function fetchSummary(slug: string, eventId: string): Promise<MatchSummary | null> {
  const data = await espnFetch<EspnSummary>(`${BASE}/${slug}/summary?event=${eventId}`);
  if (!data) return null;

  const homeEntry = data.lastFiveGames?.[0];
  const awayEntry = data.lastFiveGames?.[1];

  const h2h: MatchSummary["h2h"] = [];
  for (const block of data.headToHeadGames ?? []) {
    for (const ev of block.events ?? []) {
      h2h.push({
        date:  ev.gameDate                   ?? "",
        home:  ev.homeTeam?.displayName      ?? "?",
        away:  ev.awayTeam?.displayName      ?? "?",
        score: `${ev.homeTeamScore ?? "-"} - ${ev.awayTeamScore ?? "-"}`,
      });
    }
  }

  const parseRoster = (side: "home" | "away"): LineupPlayer[] => {
    const r = data.rosters?.find((x) => x.homeAway === side);
    if (!r?.roster) return [];
    return r.roster.map((p) => ({
      name:     p.athlete?.displayName ?? "?",
      jersey:   p.jersey,
      position: p.position?.abbreviation,
      starter:  !!p.starter,
    }));
  };

  const homeLineup    = parseRoster("home");
  const awayLineup    = parseRoster("away");
  const homeFormation = data.rosters?.find((x) => x.homeAway === "home")?.formation ?? null;
  const awayFormation = data.rosters?.find((x) => x.homeAway === "away")?.formation ?? null;
  const o             = data.pickcenter?.[0];

  return {
    odds:            o ? normalizeOdds(o) : null,
    homeForm:        homeEntry ? buildForm(homeEntry) : null,
    awayForm:        awayEntry ? buildForm(awayEntry) : null,
    h2h:             h2h.slice(0, 8),
    homeLineup,
    awayLineup,
    lineupAvailable: homeLineup.length > 0 && awayLineup.length > 0,
    homeFormation,
    awayFormation,
    venue:           data.gameInfo?.venue?.fullName ?? null,
    boxscore:        parseSummaryBoxscore(data),
  };
}

// ─── Legacy exports kept for backward compatibility ───────────────────────────

/** @deprecated Use fetchScoreboard */
export async function fetchLeagueFixtures(
  leagueSlug: string,
  _leagueName: string,
  dates?: string,
): Promise<FixtureLite[]> {
  return fetchScoreboard(leagueSlug, dates);
}

/** @deprecated Use fetchSummary */
export const fetchMatchSummary = fetchSummary;

// ĞIGI GIVØ — Real football data layer (ESPN public API, no key required).
import { LEAGUE_MAP } from "./leagues";
import { resilientJson } from "./httpClient";

const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

async function espnFetch<T>(url: string, cacheTtlMs = 60_000): Promise<T | null> {
  return resilientJson<T>(url, {
    revalidate: Math.max(1, Math.ceil(cacheTtlMs / 1000)),
    cacheTtlMs,
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
}

// ─── ESPN raw shapes ──────────────────────────────────────────────────────────

interface EspnScoreboard {
  leagues?: Array<{ name?: string; slug?: string }>;
  events?:  EspnEvent[];
}

interface EspnEvent {
  id:           string;
  date:         string;
  name:         string;
  season?:      { slug?: string };
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

/**
 * Fetch fixtures for a league slug.
 * @param slug    ESPN league slug e.g. "eng.1"
 * @param dates   Optional date string "YYYYMMDD" or range "YYYYMMDD-YYYYMMDD".
 *                When omitted, fetches a 3-day window (yesterday → tomorrow)
 *                to catch all live, upcoming and very recently finished matches.
 */
export async function fetchScoreboard(
  slug:   string,
  dates?: string,
): Promise<FixtureLite[]> {
  const leagueName = LEAGUE_MAP[slug]?.name ?? slug;

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

  if (slug === "all") return (await fetchAllScoreboard(dates)) ?? [];

  const url  = `${BASE}/${slug}/scoreboard?dates=${dates}&limit=50`;
  const data = await espnFetch<EspnScoreboard>(url);
  if (!data?.events) return [];
  return normalizeScoreboard(data, slug, leagueName);
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

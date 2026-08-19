import { LEAGUE_MAP } from "@/lib/leagues";

export const dynamic = "force-dynamic";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

interface KeyEvent {
  minute: string;
  type: string;
  icon: string;
  text: string;
  team?: string;
}

interface LiveStat {
  name: string;
  home: string;
  away: string;
}

// ─── ESPN response shapes ─────────────────────────────────────────────────────

interface EspnStatEntry {
  name: string;
  displayValue?: string;
}

interface EspnTeamEntry {
  team?: { displayName?: string };
  statistics?: EspnStatEntry[];
}

interface EspnKeyEvent {
  type?:      { type?: string; text?: string };
  clock?:     { displayValue?: string };
  team?:      { displayName?: string };
  shortText?: string;
  text?:      string;
}

interface EspnCommentaryEntry {
  time?: { displayValue?: string };
  text?: string;
}

interface EspnRosterPlayer {
  athlete?:  { displayName?: string };
  jersey?:   string;
  starter?:  boolean;
  position?: { abbreviation?: string };
}

interface EspnRoster {
  homeAway?: string;
  roster?:   EspnRosterPlayer[];
}

interface EspnSummaryResponse {
  keyEvents?:  EspnKeyEvent[];
  commentary?: EspnCommentaryEntry[];
  boxscore?:   { teams?: EspnTeamEntry[] };
  rosters?:    EspnRoster[];
}

// ─── Stat display map ─────────────────────────────────────────────────────────

const STAT_KEYS: Array<{ key: string; label: string }> = [
  { key: "possessionPct", label: "Possession %" },
  { key: "totalShots",    label: "Shots" },
  { key: "shotsOnTarget", label: "Shots on Target" },
  { key: "wonCorners",    label: "Corners" },
  { key: "yellowCards",   label: "Yellow Cards" },
  { key: "redCards",      label: "Red Cards" },
  { key: "foulsCommitted",label: "Fouls" },
  { key: "offsides",      label: "Offsides" },
  { key: "saves",         label: "Saves" },
  { key: "totalPasses",   label: "Passes" },
  { key: "passPct",       label: "Pass Accuracy" },
];

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const league  = searchParams.get("league");
  const eventId = searchParams.get("event");

  if (!league || !eventId) {
    return Response.json({ error: "Missing league or event." }, { status: 400 });
  }

  try {
    const res = await fetch(`${ESPN_BASE}/${league}/summary?event=${eventId}`, {
      next: { revalidate: 30 },
    });
    if (!res.ok) return Response.json({ error: "Feed unavailable" }, { status: 502 });

    const data = await res.json() as EspnSummaryResponse;

    // ── Key events (goals, cards, subs) ────────────────────────────────────────
    const keyEvents: KeyEvent[] = (data.keyEvents ?? []).map((e) => {
      const typeStr = e.type?.type ?? e.type?.text ?? "event";
      return {
        minute: e.clock?.displayValue ?? "",
        type:   typeStr,
        icon:   typeStr,
        text:   e.shortText ?? e.text ?? "",
        team:   e.team?.displayName,
      };
    });

    // ── Commentary feed ─────────────────────────────────────────────────────────
    const commentary: Array<{ minute: string; text: string }> = (data.commentary ?? [])
      .map((c) => ({
        minute: c.time?.displayValue ?? "",
        text:   c.text ?? "",
      }))
      .slice(0, 30);

    // ── Live boxscore stats ─────────────────────────────────────────────────────
    const teams  = data.boxscore?.teams ?? [];
    const stats: LiveStat[] = [];

    if (teams.length >= 2) {
      const toMap = (entries: EspnStatEntry[] = []): Record<string, string> => {
        const m: Record<string, string> = {};
        for (const s of entries) m[s.name] = s.displayValue ?? "";
        return m;
      };
      const homeStats = toMap(teams[0]?.statistics);
      const awayStats = toMap(teams[1]?.statistics);

      for (const s of STAT_KEYS) {
        if (homeStats[s.key] !== undefined || awayStats[s.key] !== undefined) {
          stats.push({
            name: s.label,
            home: homeStats[s.key] ?? "0",
            away: awayStats[s.key] ?? "0",
          });
        }
      }
    }

    const homeTeam = teams[0]?.team?.displayName ?? "Home";
    const awayTeam = teams[1]?.team?.displayName ?? "Away";

    // ── Lineups ─────────────────────────────────────────────────────────────────
    const lineups = (data.rosters ?? []).map((r) => ({
      side: r.homeAway ?? "",
      players: (r.roster ?? []).map((p) => ({
        name:     p.athlete?.displayName ?? "?",
        jersey:   p.jersey ?? "",
        starter:  !!p.starter,
        position: p.position?.abbreviation ?? "",
      })),
    }));

    return Response.json({
      homeTeam,
      awayTeam,
      keyEvents,
      commentary,
      stats,
      lineups,
      leagueName: LEAGUE_MAP[league]?.name ?? league,
    });
  } catch {
    return Response.json({ error: "Failed to fetch live data" }, { status: 502 });
  }
}

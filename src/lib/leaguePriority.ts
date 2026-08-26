// ĞIGI GIVØ — League importance priority for UI ordering.
//
// This module maps ESPN competition slugs (and, as a fallback, competition
// display names) to a numeric priority tier. It is used purely to ORDER the
// fixtures shown in the UI (All Matches / Live tabs) from the biggest
// competitions at the top down to the smallest at the bottom.
//
// It does NOT influence how matches are generated, predicted, or priced —
// only their display order.
//
// Tier scale (lower number = higher up the list):
//   1 — Elite (UEFA club competitions, World Cup, Euros, Copa América …)
//   2 — Top 5 European leagues
//   3 — Second-tier European leagues
//   4 — Major non-European leagues (Americas)
//   5 — Asian & African top leagues
//   6 — Everything else (lower divisions, regional, youth, etc.)

export const LOWEST_TIER = 6;

/**
 * Exact slug → tier map. Slugs use ESPN soccer competition slugs, which is
 * what `FixtureLite.leagueSlug` carries throughout the app.
 *
 * Only competitions we want to promote above the "everything else" baseline
 * (tier 6) need an entry here.
 */
export const LEAGUE_TIER: Record<string, number> = {
  // ── Tier 1 — Elite ────────────────────────────────────────────────────────
  "uefa.champions": 1, // UEFA Champions League
  "uefa.europa": 1, // UEFA Europa League
  "uefa.europa.conf": 1, // UEFA Conference League
  "fifa.world": 1, // FIFA World Cup
  "uefa.euro": 1, // UEFA European Championship
  "conmebol.america": 1, // Copa América
  "uefa.nations": 1, // UEFA Nations League
  "fifa.cwc": 1, // FIFA Club World Cup
  "conmebol.libertadores": 1, // Copa Libertadores
  "conmebol.sudamericana": 1, // Copa Sudamericana

  // ── Tier 3 — Major domestic cups ───────────────────────────────────────────
  // These sit alongside second-tier European leagues: they regularly feature
  // top-flight clubs, so they must not fall through to the tier-6 baseline.
  "eng.fa": 3, // FA Cup (England)
  "eng.league_cup": 3, // EFL Cup / Carabao Cup (England)
  "esp.copa_del_rey": 3, // Copa del Rey (Spain)
  "ger.dfb_pokal": 3, // DFB-Pokal (Germany)
  "ita.coppa_italia": 3, // Coppa Italia (Italy)
  "fra.coupe_de_france": 3, // Coupe de France (France)

  // ── Tier 2 — Top 5 leagues ──────────────────────────────────────────────────
  "eng.1": 2, // Premier League (England)
  "esp.1": 2, // La Liga (Spain)
  "ger.1": 2, // Bundesliga (Germany)
  "ita.1": 2, // Serie A (Italy)
  "fra.1": 2, // Ligue 1 (France)

  // ── Tier 3 — Second-tier European leagues ──────────────────────────────────
  "eng.2": 3, // Championship (England)
  "ger.2": 3, // 2. Bundesliga (Germany)
  "ita.2": 3, // Serie B (Italy)
  "esp.2": 3, // La Liga 2 (Spain)
  "fra.2": 3, // Ligue 2 (France)
  "ned.1": 3, // Eredivisie (Netherlands)
  "por.1": 3, // Primeira Liga (Portugal)
  "bel.1": 3, // Belgian Pro League
  "sco.1": 3, // Scottish Premiership
  "tur.1": 3, // Süper Lig (Turkey)
  "gre.1": 3, // Greek Super League
  "aut.1": 3, // Austrian Bundesliga
  "sui.1": 3, // Swiss Super League

  // ── Tier 4 — Major non-European leagues ─────────────────────────────────────
  "usa.1": 4, // MLS (USA)
  "mex.1": 4, // Liga MX (Mexico)
  "bra.1": 4, // Brasileirão Série A (Brazil)
  "arg.1": 4, // Argentine Primera División
  "chi.1": 4, // Chilean Primera División
  "col.1": 4, // Colombian Primera A
  "per.1": 4, // Peruvian Liga 1
  "uru.1": 4, // Uruguayan Primera División
  "par.1": 4, // Paraguayan Primera División
  "ecu.1": 4, // Ecuadorian Serie A
  "ven.1": 4, // Venezuelan Primera División

  // ── Tier 5 — Asian & African top leagues ────────────────────────────────────
  "ksa.1": 5, // Saudi Pro League
  "uae.1": 5, // UAE Pro League
  "qat.1": 5, // Qatar Stars League
  "jpn.1": 5, // J1 League (Japan)
  "kor.1": 5, // K League 1 (South Korea)
  "chn.1": 5, // Chinese Super League
  "aus.1": 5, // A-League (Australia)
  "egy.1": 5, // Egyptian Premier League
  "rsa.1": 5, // South African Premier Division
  "mar.1": 5, // Moroccan Botola
  "tun.1": 5, // Tunisian Ligue 1
};

/**
 * Fallback name → tier matching for fixtures that only carry a competition
 * display name (e.g. SportScore) rather than an ESPN slug. Matched
 * case-insensitively as substrings, checked in order.
 */
const NAME_TIER: Array<{ match: string; tier: number }> = [
  // Tier 1
  { match: "champions league", tier: 1 },
  { match: "europa league", tier: 1 },
  { match: "conference league", tier: 1 },
  { match: "world cup", tier: 1 },
  { match: "european championship", tier: 1 },
  { match: "uefa euro", tier: 1 },
  { match: "copa américa", tier: 1 },
  { match: "copa america", tier: 1 },
  { match: "nations league", tier: 1 },
  { match: "club world cup", tier: 1 },
  { match: "libertadores", tier: 1 },
  { match: "sudamericana", tier: 1 },

  // Tier 2
  { match: "premier league", tier: 2 }, // note: refined below for non-English PLs
  { match: "laliga", tier: 2 },
  { match: "la liga", tier: 2 },
  { match: "bundesliga", tier: 2 },
  { match: "serie a", tier: 2 },
  { match: "ligue 1", tier: 2 },

  // Tier 3
  { match: "championship", tier: 3 },
  { match: "2. bundesliga", tier: 3 },
  { match: "serie b", tier: 3 },
  { match: "laliga 2", tier: 3 },
  { match: "ligue 2", tier: 3 },
  { match: "eredivisie", tier: 3 },
  { match: "primeira liga", tier: 3 },
  { match: "pro league", tier: 3 },
  { match: "premiership", tier: 3 },
  { match: "süper lig", tier: 3 },
  { match: "super lig", tier: 3 },
  { match: "super league greece", tier: 3 },
  { match: "swiss super league", tier: 3 },
  { match: "fa cup", tier: 3 },
  { match: "copa del rey", tier: 3 },
  { match: "dfb-pokal", tier: 3 },
  { match: "dfb pokal", tier: 3 },
  { match: "coppa italia", tier: 3 },
  { match: "coupe de france", tier: 3 },
  { match: "carabao cup", tier: 3 },
  { match: "efl cup", tier: 3 },

  // Tier 4
  { match: "mls", tier: 4 },
  { match: "major league soccer", tier: 4 },
  { match: "liga mx", tier: 4 },
  { match: "brasileirão", tier: 4 },
  { match: "brasileirao", tier: 4 },

  // Tier 5
  { match: "saudi pro league", tier: 5 },
  { match: "j1 league", tier: 5 },
  { match: "k league", tier: 5 },
  { match: "a-league", tier: 5 },
];

/**
 * Alternate provider spellings and ESPN's separate qualifying-round slugs.
 * They map onto the canonical parent competition so `LEAGUE_TIER` and
 * scoreboard fetches keep UEFA qualifying fixtures in the main feed.
 */
export const LEAGUE_SLUG_ALIASES: Record<string, string> = {
  // ESPN publishes summer qualifying rounds under separate competition slugs.
  // Normalize them into their parent UEFA competitions so those fixtures stay
  // visible in the main feed and retain the same tier/order as the league phase.
  "uefa.champions_qual": "uefa.champions",
  "uefa.europa_qual": "uefa.europa",
  "uefa.europa.conf_qual": "uefa.europa.conf",
  "uefa.conference": "uefa.europa.conf",
  "uefa.europa.conference": "uefa.europa.conf",
  "uefa.nationsleague": "uefa.nations",
  "uefa.nations_league": "uefa.nations",
  "fifa.worldcup": "fifa.world",
  "fifa.clubworldcup": "fifa.cwc",
  "fifa.club.world.cup": "fifa.cwc",
  "conmebol.copaamerica": "conmebol.america",
  "eng.facup": "eng.fa",
  "eng.fa_cup": "eng.fa",
  "eng.eflcup": "eng.league_cup",
  "eng.efl_cup": "eng.league_cup",
  "esp.cup": "esp.copa_del_rey",
  "ger.cup": "ger.dfb_pokal",
  "ita.cup": "ita.coppa_italia",
  "fra.cup": "fra.coupe_de_france",
};

/** Collapse a known alias onto the ESPN catalogue slug. Unknown slugs pass through. */
export function canonicalLeagueSlug(slug: string): string {
  return LEAGUE_SLUG_ALIASES[slug.trim()] ?? slug.trim();
}

/**
 * ESPN scoreboard slug candidates for a competition: the canonical slug first,
 * then any known aliases. Used when a catalogue slug returns an empty board.
 */
export function espnSlugCandidates(slug: string): string[] {
  const canonical = canonicalLeagueSlug(slug);
  const aliases = Object.entries(LEAGUE_SLUG_ALIASES)
    .filter(([, target]) => target === canonical)
    .map(([alias]) => alias);
  return [canonical, ...aliases.filter((alias) => alias !== canonical)];
}

/**
 * Resolve the priority tier for a fixture-like object.
 * Prefers the exact slug map, then falls back to a name substring match,
 * and finally to the lowest tier for anything unlisted.
 */
export function leagueTier(input: {
  leagueSlug?: string | null;
  leagueName?: string | null;
}): number {
  const slug = input.leagueSlug?.trim();
  if (slug) {
    const canonical = canonicalLeagueSlug(slug);
    if (canonical in LEAGUE_TIER) return LEAGUE_TIER[canonical];
    if (slug in LEAGUE_TIER) return LEAGUE_TIER[slug];
  }

  const name = input.leagueName?.trim().toLowerCase();
  if (name) {
    for (const { match, tier } of NAME_TIER) {
      if (name.includes(match)) return tier;
    }
  }

  return LOWEST_TIER;
}

/**
 * Comparator for two fixture-like objects by league importance
 * (lower tier number first). Ties are left to the caller (e.g. by date).
 */
export function compareLeaguePriority(
  a: { leagueSlug?: string | null; leagueName?: string | null },
  b: { leagueSlug?: string | null; leagueName?: string | null },
): number {
  return leagueTier(a) - leagueTier(b);
}

/**
 * Comparator for the league blocks used by the home feed. Blocks carry their
 * ESPN slug as `slug` rather than `leagueSlug`; `label` is also supplied as a
 * fallback for fixtures discovered through ESPN's global scoreboard.
 *
 * Keeping this here means All Matches, Today and the API use the exact same
 * T1 → T6 ordering instead of each view implementing a subtly different sort.
 */
export function compareLeagueBlockPriority(
  a: { slug?: string | null; label?: string | null },
  b: { slug?: string | null; label?: string | null },
): number {
  return compareLeaguePriority(
    { leagueSlug: a.slug, leagueName: a.label },
    { leagueSlug: b.slug, leagueName: b.label },
  );
}

/**
 * Full fixture comparator: league priority first, then earliest date within
 * the same tier. `dateOf` extracts an ISO date string from each item.
 */
export function compareFixturesByPriority<
  T extends { leagueSlug?: string | null; leagueName?: string | null },
>(a: T, b: T, dateOf: (x: T) => string | undefined = () => undefined): number {
  const byTier = compareLeaguePriority(a, b);
  if (byTier !== 0) return byTier;

  const da = dateOf(a);
  const db = dateOf(b);
  if (da && db) return new Date(da).getTime() - new Date(db).getTime();
  return 0;
}

/** Short display label for a tier, e.g. `T1`. */
export function tierLabel(tier: number): string {
  return `T${tier}`;
}

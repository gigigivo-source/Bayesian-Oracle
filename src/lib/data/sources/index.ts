// ĞIGI GIVØ — Stats source registry.
//
// Registers every stats source with its capability matrix (which stat fields
// its normaliser can fill) and exposes the reverse map (which sources provide
// each stat) for the debug endpoint, PR documentation and runtime validation.
//
// 2026-09-17 cleanup: nine of the eleven sources are dead for verified
// reasons (see DISABLED markers below). Their handler files are left on disk
// untouched — only the registration is commented out, so a future PR can
// re-enable any of them by uncommenting two lines. The aggregator treats a
// missing handler as "no handler registered" (no network, no wait), which is
// what removes the 1-3 min of dead-source probing from every scan.

import type { SourceHandler } from "./context";
import type { StatField, StatSourceName } from "../types";

// import { apiFootballSource } from "./apiFootball";
// import { datafcSource } from "./datafc";
// import { fbrefSource } from "./fbref";
// import { githubDatasetsSource } from "./githubDatasets";
// import { highlightlySource } from "./highlightly";
// import { openligadbSource } from "./openligadb";
// import { statsbombSource } from "./statsbomb";
// import { understatSource } from "./understat";
// import { worldcup2026Source } from "./worldcup2026";
import { openfootSource } from "./openfoot";
import { sportscoreSource } from "./sportscore";
import { thesportsdbSource } from "./thesportsdb";

/**
 * All registered source handlers, keyed by canonical name.
 * Partial: deregistered (commented-out) sources are simply absent, and the
 * aggregator skips them without any network attempt.
 */
export const SOURCE_HANDLERS: Partial<Record<StatSourceName, SourceHandler>> = {
  "SportScore": sportscoreSource,
  // DISABLED 2026-09-17 — user's free tier is exhausted (no current-season team stats available)
  // "API-Football": apiFootballSource,
  // DISABLED 2026-09-17 — open data is historical only; no 2026 fixtures
  // "StatsBomb": statsbombSource,
  // DISABLED 2026-09-17 — requires a self-hosted sidecar endpoint not running
  // "datafc": datafcSource,
  // DISABLED 2026-09-17 — 403 from Cloudflare WAF on the user's network
  // "FBref": fbrefSource,
  // DISABLED 2026-09-17 — 2026 pages do not exist yet (404)
  // "Understat": understatSource,
  // DISABLED 2026-09-17 — German leagues only
  // "OpenLigaDB": openligadbSource,
  // DISABLED 2026-09-17 — host api.highlightly.com unreachable from user's network (curl returns 000)
  // "Highlightly": highlightlySource,
  // DISABLED 2026-09-17 — World Cup 2026 only
  // "worldcup2026": worldcup2026Source,
  "TheSportsDB": thesportsdbSource,
  // DISABLED 2026-09-17 — all configured dataset URLs return 404
  // "GitHubDatasets": githubDatasetsSource,
  // Enabled 2026-09-17 — free tier 5000 req/month at openfootapi.com
  "OpenFootAPI": openfootSource,
};

/** Capability matrix: source name → stat fields its normaliser can fill. */
export const SOURCE_CAPABILITIES: Partial<Record<StatSourceName, StatField[]>> = Object.fromEntries(
  (Object.keys(SOURCE_HANDLERS) as StatSourceName[]).map((name) => [
    name,
    SOURCE_HANDLERS[name]?.capabilities ?? [],
  ]),
) as Partial<Record<StatSourceName, StatField[]>>;

/** Reverse matrix: stat field → sources that can provide it (priority order). */
export const STAT_SOURCES: Partial<Record<StatField, StatSourceName[]>> = (() => {
  const map = {} as Partial<Record<StatField, StatSourceName[]>>;
  for (const source of Object.keys(SOURCE_HANDLERS) as StatSourceName[]) {
    for (const stat of SOURCE_HANDLERS[source]?.capabilities ?? []) {
      (map[stat] ??= []).push(source);
    }
  }
  return map;
})();

/** The names of all registered sources, in registration order. */
export const REGISTERED_SOURCES: StatSourceName[] = Object.keys(SOURCE_HANDLERS) as StatSourceName[];

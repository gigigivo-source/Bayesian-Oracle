// ĞIGI GIVØ — Stats source registry.
//
// Registers every stats source with its capability matrix (which stat fields
// its normaliser can fill) and exposes the reverse map (which sources provide
// each stat) for the debug endpoint, PR documentation and runtime validation.

import type { SourceHandler } from "./context";
import type { StatField, StatSourceName } from "../types";

import { apiFootballSource } from "./apiFootball";
import { datafcSource } from "./datafc";
import { fbrefSource } from "./fbref";
import { githubDatasetsSource } from "./githubDatasets";
import { highlightlySource } from "./highlightly";
import { openligadbSource } from "./openligadb";
import { sportscoreSource } from "./sportscore";
import { statsbombSource } from "./statsbomb";
import { thesportsdbSource } from "./thesportsdb";
import { understatSource } from "./understat";
import { worldcup2026Source } from "./worldcup2026";

/** All registered source handlers, keyed by canonical name. */
export const SOURCE_HANDLERS: Record<StatSourceName, SourceHandler> = {
  "SportScore": sportscoreSource,
  "API-Football": apiFootballSource,
  "StatsBomb": statsbombSource,
  "datafc": datafcSource,
  "FBref": fbrefSource,
  "Understat": understatSource,
  "OpenLigaDB": openligadbSource,
  "Highlightly": highlightlySource,
  "worldcup2026": worldcup2026Source,
  "TheSportsDB": thesportsdbSource,
  "GitHubDatasets": githubDatasetsSource,
};

/** Capability matrix: source name → stat fields its normaliser can fill. */
export const SOURCE_CAPABILITIES: Record<StatSourceName, StatField[]> = Object.fromEntries(
  (Object.keys(SOURCE_HANDLERS) as StatSourceName[]).map((name) => [
    name,
    SOURCE_HANDLERS[name].capabilities,
  ]),
) as Record<StatSourceName, StatField[]>;

/** Reverse matrix: stat field → sources that can provide it (priority order). */
export const STAT_SOURCES: Record<StatField, StatSourceName[]> = (() => {
  const map = {} as Record<StatField, StatSourceName[]>;
  for (const source of Object.keys(SOURCE_HANDLERS) as StatSourceName[]) {
    for (const stat of SOURCE_HANDLERS[source].capabilities) {
      (map[stat] ??= []).push(source);
    }
  }
  return map;
})();

/** The names of all registered sources, in registration order. */
export const REGISTERED_SOURCES: StatSourceName[] = Object.keys(SOURCE_HANDLERS) as StatSourceName[];

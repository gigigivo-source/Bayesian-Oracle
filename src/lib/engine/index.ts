// ĞIGI GIVØ — Engine public entry point.
// Re-exports from the orchestrator so all callers use a single import path.

export { runEngine, runEngineFromReal, runEngineFromRealWithProfiles } from "./engine";
export { evaluateFinishedMatch } from "./evaluator";
export { runOracle } from "./oracle";
export type { EngineResult, Market, MarketPick, DeepStatsVector, PredictInput, AgentSignal } from "./types";

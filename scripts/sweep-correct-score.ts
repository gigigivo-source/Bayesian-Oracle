// scripts/sweep-correct-score.ts
//
// Run the correct-score parameter sweep from the command line — the same code
// path as `GET /api/correct-score/backtest?sweep=1`, without a dev server.
//
//   npx tsx scripts/sweep-correct-score.ts               # table to stdout
//   npx tsx scripts/sweep-correct-score.ts --json        # full response as JSON
//   npx tsx scripts/sweep-correct-score.ts --sims=2000   # faster, fewer draws
//
// Loads the last three Premier League seasons through the historical
// aggregator (database → GitHub datasets → openfootball → ESPN; whichever
// layers are reachable), replays every fixture under all 48 combinations and
// prints them best-first. Use the winner to update `DEFAULT_TUNING` in
// src/app/api/correct-score/route.ts.

import { GET } from "../src/app/api/correct-score/backtest/route";
import type { CorrectScoreSweepResponse, SweepResult } from "../src/app/api/correct-score/backtest/route";

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function row(label: string, result: SweepResult | null): string {
  if (!result) return `${label.padEnd(9)} —`;
  const { params } = result;
  return (
    `${label.padEnd(9)} ` +
    `w=${params.structuralWeight.toFixed(2)}  T=${params.temperature.toFixed(2)}  K=${String(params.eloElasticity).padStart(2)}  ` +
    `top1=${pct(result.top1Accuracy).padStart(7)}  top3=${pct(result.top3Accuracy).padStart(7)}  ` +
    `brier=${result.brierScore.toFixed(4)}`
  );
}

async function main(): Promise<void> {
  const sims = process.argv.find((arg) => arg.startsWith("--sims="))?.slice("--sims=".length);
  const url = `http://localhost/api/correct-score/backtest?sweep=1${sims ? `&sims=${sims}` : ""}`;
  const response = await GET(new Request(url));
  const body = (await response.json()) as CorrectScoreSweepResponse & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`Correct-score parameter sweep — ${body.model}`);
  console.log(
    `${body.matchesTested} fixtures, ${body.window.from?.slice(0, 10)} → ${body.window.to?.slice(0, 10)}, ` +
      `${body.simulations} sims/fixture, ${(body.elapsedMs / 1000).toFixed(1)}s`,
  );
  for (const source of body.historySources) {
    console.log(`  ${source.source.padEnd(16)} ${String(source.added).padStart(5)}  ${source.note}`);
  }
  console.log("");
  console.log(row("best", body.best));
  console.log(row("current", body.current));
  console.log(row("legacy", body.legacy));
  console.log("");
  console.log("rank  w     T     K   top1     top3     brier");
  body.results.forEach((result, index) => {
    const { params } = result;
    console.log(
      `${String(index + 1).padStart(3)}   ${params.structuralWeight.toFixed(1)}   ${params.temperature.toFixed(2)}  ` +
        `${String(params.eloElasticity).padStart(2)}  ${pct(result.top1Accuracy).padStart(7)}  ` +
        `${pct(result.top3Accuracy).padStart(7)}  ${result.brierScore.toFixed(4)}`,
    );
  });
  if (body.message) console.log(`\n${body.message}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

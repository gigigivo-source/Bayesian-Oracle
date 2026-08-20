import { Application } from "@/app/_components/Application";

function allowedNumber(value: string | undefined, allowed: number[], fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return allowed.includes(parsed) ? parsed : fallback;
}

export default async function BacktestPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; limit?: string; league?: string; match?: string }>;
}) {
  const query = await searchParams;
  return (
    <Application
      tab="backtest"
      backtestDays={allowedNumber(query.days, [3, 7, 14, 30], 7)}
      backtestLimit={allowedNumber(query.limit, [10, 20, 30, 50], 20)}
      backtestLeague={query.league ?? ""}
      expandedBacktestMatch={query.match}
    />
  );
}

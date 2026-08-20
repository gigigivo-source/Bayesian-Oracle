import { Application } from "@/app/_components/Application";

type OddsFormat = "decimal" | "american" | "fractional" | "probability";

export default async function OddsCalculatorPage({ searchParams }: { searchParams: Promise<{ format?: string }> }) {
  const { format } = await searchParams;
  const valid: OddsFormat[] = ["decimal", "american", "fractional", "probability"];
  const oddsFormat = valid.includes(format as OddsFormat) ? format as OddsFormat : "decimal";
  return <Application tab="oddscalc" oddsFormat={oddsFormat} />;
}

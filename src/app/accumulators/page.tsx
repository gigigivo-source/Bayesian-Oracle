import { Application } from "@/app/_components/Application";

type AccumulatorView = "highhit" | "value" | "slips" | "performance";

export default async function AccumulatorsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const valid: AccumulatorView[] = ["highhit", "value", "slips", "performance"];
  const accumulatorView = valid.includes(view as AccumulatorView) ? view as AccumulatorView : "highhit";
  return <Application tab="accumulators" accumulatorView={accumulatorView} />;
}

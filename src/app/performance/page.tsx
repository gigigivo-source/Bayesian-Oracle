import { Application } from "@/app/_components/Application";

type PerformanceView = "overview" | "accuracy" | "calibration";

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const valid: PerformanceView[] = ["overview", "accuracy", "calibration"];
  const performanceView = valid.includes(view as PerformanceView) ? view as PerformanceView : "overview";
  return <Application tab="performance" performanceView={performanceView} />;
}

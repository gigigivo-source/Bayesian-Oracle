import { Application } from "@/app/_components/Application";

export default async function SlipPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const slipId = Number.parseInt(id, 10);
  return (
    <Application
      tab="accumulators"
      accumulatorView="slips"
      expandedSlipId={Number.isFinite(slipId) ? slipId : undefined}
      editSlipStake={query.edit === "stake"}
    />
  );
}

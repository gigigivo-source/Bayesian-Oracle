import { FixtureRoutePage } from "@/app/_components/FixtureRoutePage";

type LiveTab = "events" | "stats" | "commentary";

export default async function FixturePage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ league?: string; family?: string; json?: string; live?: string }>;
}) {
  const [{ eventId }, query] = await Promise.all([params, searchParams]);
  const liveTabs: LiveTab[] = ["events", "stats", "commentary"];
  const liveTab = liveTabs.includes(query.live as LiveTab) ? query.live as LiveTab : "events";
  return (
    <FixtureRoutePage
      eventId={decodeURIComponent(eventId)}
      leagueSlug={query.league}
      familyFilter={query.family}
      showJson={query.json === "1"}
      liveTab={liveTab}
    />
  );
}

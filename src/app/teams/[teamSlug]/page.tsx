import { TeamRoutePage } from "@/app/_components/TeamRoutePage";

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ teamSlug: string }>;
  searchParams: Promise<{ name?: string; league?: string }>;
}) {
  const [{ teamSlug }, query] = await Promise.all([params, searchParams]);
  return (
    <TeamRoutePage
      teamSlug={decodeURIComponent(teamSlug)}
      teamName={query.name}
      leagueSlug={query.league}
    />
  );
}

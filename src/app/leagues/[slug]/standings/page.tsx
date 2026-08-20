import { Application } from "@/app/_components/Application";

export default async function LeagueStandingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <Application tab="standings" standingsSlug={decodeURIComponent(slug)} />;
}

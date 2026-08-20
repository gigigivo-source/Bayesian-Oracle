import { Application } from "@/app/_components/Application";

export default async function LeaguePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <Application tab="leagues" leagueSlug={decodeURIComponent(slug)} />;
}

import { Application } from "./_components/Application";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ today?: string }>;
}) {
  const query = await searchParams;
  return <Application tab="top" showTodayOnly={query.today === "1"} />;
}

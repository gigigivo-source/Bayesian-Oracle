import { Application } from "@/app/_components/Application";

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  return <Application tab="chat" chatQuery={q ?? ""} />;
}

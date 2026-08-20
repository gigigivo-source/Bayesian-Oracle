import { Application } from "@/app/_components/Application";

export default async function BankrollPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { type } = await searchParams;
  return <Application tab="bankroll" bankrollType={type ?? "deposit"} />;
}

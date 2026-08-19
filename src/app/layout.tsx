import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ĞIGI GIVØ — Probabilistic Match Engine",
  description:
    "Autonomous probabilistic dependency-graph engine. 18 families, 683 markets, Bayesian consensus, uncertainty quantification.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#05070d] text-slate-100 antialiased">{children}</body>
    </html>
  );
}

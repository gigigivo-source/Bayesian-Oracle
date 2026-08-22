import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ViewportIndicator } from "./_components/ViewportIndicator";
import "./globals.css";

export const metadata: Metadata = {
  title: "ĞIGI GIVØ — Probabilistic Match Engine",
  description:
    "Autonomous probabilistic dependency-graph engine. 18 families, 683 markets, Bayesian consensus, uncertainty quantification.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100 antialiased">
        {children}
        <ViewportIndicator />
      </body>
    </html>
  );
}

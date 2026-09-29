import type { Metadata } from "next";
import "./globals.css";

const title = "20Q Challenge";
const description = "Ranking del 20Q Challenge: rango, winrate, KDA, campeones y última partida SoloQ.";

export const metadata: Metadata = {
  title,
  description,
  icons: { icon: "/favicon.png" },
  openGraph: {
    title,
    description,
    type: "website",
    locale: "es_PE",
    images: [{ url: "https://20q-challenge.pages.dev/og.jpg", width: 1200, height: 630, alt: "20Q Challenge: ranking y última partida SoloQ" }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["https://20q-challenge.pages.dev/og.jpg"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <head>
        <link rel="preconnect" href="https://ddragon.leagueoflegends.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- root layout: applies to every page */}
        <link
          href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Instrument+Sans:wght@400;500;600;700&family=Cinzel:wght@600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

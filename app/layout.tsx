import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "20Q Challenge";
const description = "Ranking del 20Q Challenge: rango, winrate, KDA, campeones y última partida SoloQ.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0].trim();
  const directHost = requestHeaders.get("host")?.trim();
  const candidateHost = forwardedHost || directHost || "20q-challenge.pages.dev";
  const host = /^[a-z0-9.-]+(?::\d+)?$/i.test(candidateHost)
    ? candidateHost
    : "20q-challenge.pages.dev";
  const forwardedProto = requestHeaders.get("x-forwarded-proto")?.split(",")[0].trim();
  const protocol = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : "https";
  const imageUrl = `${protocol}://${host}/og.jpg`;

  return {
    title,
    description,
    icons: { icon: "/favicon.png" },
    openGraph: {
      title,
      description,
      type: "website",
      locale: "es_PE",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "20Q Challenge: ranking y última partida SoloQ" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <head>
        <link rel="preconnect" href="https://ddragon.leagueoflegends.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- root layout: applies to every page */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..800&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;700&family=Cinzel:wght@400;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

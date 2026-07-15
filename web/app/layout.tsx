import type { Metadata } from "next";
import { Fraunces, Sora, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-serif",
  style: ["normal", "italic"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Occulta — Hide the alpha, not just the balance.",
  description:
    "Confidential DeFi strategy agents on iExec Nox. Positions and strategy stay sealed; only the aggregate net per epoch is revealed, and it settles for real on Aave V3 and Uniswap V3.",
  metadataBase: new URL("https://occulta.live"),
  openGraph: {
    title: "Occulta — Hide the alpha, not just the balance.",
    description:
      "Confidential DeFi strategy agents on iExec Nox — sealed strategy, sealed positions, one revealed number per epoch.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${sora.variable} ${jetbrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

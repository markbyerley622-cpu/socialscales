import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Social Scales",
    template: "%s · Social Scales",
  },
  description:
    "AI-powered social media operating system: strategy, content, scheduling, publishing and learning in one workspace.",
};

export const viewport: Viewport = {
  themeColor: "#04070c",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="ss-ambient min-h-dvh antialiased">{children}</body>
    </html>
  );
}

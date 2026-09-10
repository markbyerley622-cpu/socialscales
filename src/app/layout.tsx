import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "sonner";

import "./globals.css";

/**
 * The root shell for both surfaces.
 *
 * Two interfaces live in this app: the Social Scales product dashboard under
 * `(app)`, and the operator console under `(ops)` at /ops. They share this
 * document, the font and the toast host; everything else — palette, chrome,
 * navigation — belongs to their own layouts.
 */

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
      <body className="ss-ambient min-h-dvh antialiased">
        {children}
        {/* The console's server actions report through sonner, so the toast host
            has to be mounted above both route groups. */}
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{
            style: {
              background: "var(--color-surface-3)",
              border: "1px solid var(--color-hairline-strong)",
              color: "var(--color-ink)",
              fontSize: "12.5px",
            },
          }}
        />
      </body>
    </html>
  );
}

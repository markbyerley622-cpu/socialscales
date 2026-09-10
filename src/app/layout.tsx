import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "CONTENT OS",
    template: "%s · CONTENT OS",
  },
  description:
    "Internal content distribution and experimentation console: upload, review, schedule, publish, learn.",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0c",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        {children}
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{
            style: {
              background: "var(--color-surface-raised)",
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

import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import SessionProviderWrapper from "../providers/SessionProviderWrapper";
import AuthGuard from "../components/AuthGuard";

export const metadata: Metadata = {
  title: "SmartBull.ai",
  description: "Trading platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/* NOTE: fonts are objects, not functions */}
      <body className={`${GeistSans.className} ${GeistMono.variable} antialiased`}>
        <SessionProviderWrapper>
          <AuthGuard>{children}</AuthGuard>
        </SessionProviderWrapper>
      </body>
    </html>
  );
}

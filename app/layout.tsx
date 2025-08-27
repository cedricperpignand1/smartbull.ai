import type { Metadata } from "next";
import { Geist, Geist_Mono } from "geist/font";
import "./globals.css";
import SessionProviderWrapper from "../providers/SessionProviderWrapper";
import AuthGuard from "../components/AuthGuard";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <SessionProviderWrapper>
          <AuthGuard>{children}</AuthGuard>
        </SessionProviderWrapper>
      </body>
    </html>
  );
}

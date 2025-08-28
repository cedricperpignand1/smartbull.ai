import type { Metadata } from "next";
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
      <body className="font-sans antialiased">
        <SessionProviderWrapper>
          <AuthGuard>{children}</AuthGuard>
        </SessionProviderWrapper>
      </body>
    </html>
  );
}

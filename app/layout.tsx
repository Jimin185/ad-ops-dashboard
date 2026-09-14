import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AdOps Control Center",
  description: "Naver and Meta advertising operations dashboard",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

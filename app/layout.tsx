import type { Metadata } from "next";
import localFont from "next/font/local";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const cereal = localFont({
  src: [
    { path: "../public/fonts/cereal/AirbnbCereal_W_Lt.otf", weight: "300", style: "normal" },
    { path: "../public/fonts/cereal/AirbnbCereal_W_Bk.otf", weight: "400", style: "normal" },
    { path: "../public/fonts/cereal/AirbnbCereal_W_Md.otf", weight: "500", style: "normal" },
    { path: "../public/fonts/cereal/AirbnbCereal_W_Bd.otf", weight: "700", style: "normal" },
    { path: "../public/fonts/cereal/AirbnbCereal_W_XBd.otf", weight: "800", style: "normal" },
    { path: "../public/fonts/cereal/AirbnbCereal_W_Blk.otf", weight: "900", style: "normal" },
  ],
  variable: "--font-cereal",
  display: "swap",
});

export const metadata: Metadata = {
  title: "frxkb studio",
  description: "Internal content studio for ArchitectGPT and CasaGPT",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${cereal.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground font-sans">
        {children}
        <Toaster position="top-right" />
      </body>
    </html>
  );
}

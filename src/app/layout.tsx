import type { Metadata } from "next";
import { Open_Sans } from "next/font/google";
import "./globals.css";

/* Unico font del progetto, unico peso: Open Sans Light. */
const openSans = Open_Sans({
  variable: "--font-open-sans",
  subsets: ["latin"],
  weight: "300",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Lighthouse Batch Audit",
  description:
    "Analizza la velocità di più pagine di un sito con l'API Lighthouse di Google ed esporta le azioni correttive in ordine di priorità.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="it" className={`${openSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-ink font-sans">
        {children}
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { JetBrains_Mono, Open_Sans } from "next/font/google";
import "./globals.css";

/* Stessa coppia di font degli altri strumenti: Open Sans con peso base 300
   e 500 per gli elementi interattivi, JetBrains Mono per URL e codice. */
const openSans = Open_Sans({
  variable: "--font-open-sans",
  subsets: ["latin"],
  weight: ["300", "500"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Analisi velocità di un sito",
  description:
    "Controlla la velocità di un sito intero con i dati reali degli utenti Chrome, approfondisci con Lighthouse dove serve ed esporta le azioni in ordine di priorità.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="it"
      className={`${openSans.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-ink font-sans">
        {children}
      </body>
    </html>
  );
}

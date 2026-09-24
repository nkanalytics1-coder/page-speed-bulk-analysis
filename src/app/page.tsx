import { Analyzer } from "@/components/Analyzer";

export default function Home() {
  const hasApiKey = Boolean(process.env.PAGESPEED_API_KEY);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-10">
      <header className="mb-8">
        <h1 className="text-2xl">Analisi velocità di un sito</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
          Controlla come va un sito intero in pochi secondi usando i dati degli
          utenti reali di Chrome, poi approfondisci con Lighthouse solo dove
          serve. Alla fine scarichi un Excel con le cose da fare in ordine di
          priorità.
        </p>
      </header>

      {!hasApiKey ? (
        <p className="mb-8 rounded-lg border border-average bg-average-soft px-4 py-3 text-sm">
          Nessuna chiave API configurata. Lo strumento funziona lo stesso, ma
          Google limita pesantemente le richieste anonime e su più pagine
          vedrai molti errori di quota. Imposta{" "}
          <code className="font-mono text-xs">PAGESPEED_API_KEY</code> in{" "}
          <code className="font-mono text-xs">.env.local</code> o nelle
          Environment Variables di Vercel.
        </p>
      ) : null}

      <Analyzer />

      <footer className="mt-16 border-t border-border pt-6 text-xs leading-relaxed text-ink-faint">
        <p>
          I punteggi provengono dall&apos;API PageSpeed Insights v5, lo stesso
          motore di pagespeed.web.dev. Sono dati di laboratorio: una simulazione
          su rete e CPU emulate, soggetta a variazioni di qualche punto tra
          un&apos;esecuzione e l&apos;altra. Dove disponibili, i dati di campo
          CrUX mostrano l&apos;esperienza reale degli utenti Chrome negli ultimi
          28 giorni.
        </p>
      </footer>
    </main>
  );
}

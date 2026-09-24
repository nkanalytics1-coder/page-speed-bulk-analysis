# Progetto: Lighthouse Batch Audit

Analizza più pagine di un sito con il motore Lighthouse di Google e produce un
piano di intervento ordinato per impatto, scaricabile in Excel.

## Stack
- Next.js 16 con App Router (Turbopack di default)
- React 19, TypeScript, Tailwind CSS 4
- exceljs per la generazione del file .xlsx
- Deploy su Vercel (auto-deploy da `main`)

> Next.js 16 ha breaking change rispetto alla 15. Le guide della versione
> installata stanno in `node_modules/next/dist/docs/`: leggerle prima di
> scrivere codice, come ricorda `AGENTS.md`.

## Struttura directory
- `src/app/` — pagine e route handler
  - `api/crux/` — dati di campo in blocco (veloce)
  - `api/analyze/` — una singola chiamata PageSpeed Insights (lenta)
  - `api/sitemap/` — estrae gli URL da sitemap.xml / robots.txt
  - `api/export/` — genera il file Excel
- `src/components/` — UI (client components)
- `src/lib/` — logica pura, testabile senza server
- `scripts/` — smoke test, verifica dei template, fixture

## Architettura — perché è fatta così

**Due fonti, due fasi.** L'API Chrome UX Report (`src/lib/crux.ts`) dà i dati di
campo in circa 0,02s per URL senza simulare nulla: è la scansione larga.
Lighthouse via PageSpeed Insights costa ~30s a pagina ma spiega *perché* una
pagina è lenta: è la diagnosi mirata, lanciata solo sui template che servono.
Non invertire l'ordine.

**Il campionamento per template** (`src/lib/templates.ts`) raggruppa le URL con
un albero dei percorsi che collassa in `*` i segmenti variabili. La regola non è
"molti fratelli" ma "molti fratelli **in rapporto** alle URL che passano da lì":
50 slug sotto `/blog` su 50 URL sono un identificativo, 20 sezioni sotto la
radice su 500 URL non lo sono. Senza il rapporto tutte le sezioni di primo
livello finirebbero fuse in un unico template sbagliato — è successo davvero, e
`scripts/template-check.mts` serve a verificare il risultato su sitemap reali
prima di fidarsi.

**I dati CrUX per singola URL spesso non esistono.** Google li pubblica solo per
pagine con traffico alto: nei test su Smashing Magazine e MDN nessuna pagina
profonda ne aveva. Il client ripiega sull'origin e lo dichiara in
`CruxResult.scope`, che diventa `TemplateSummary.dataScope`. Quando è `origin`
per tutti i template i numeri sono identici fra loro e non vanno confrontati:
UI ed Excel devono continuare a dirlo in modo evidente, non nasconderlo.

**Lighthouse non gira su Vercel.** Usiamo la PageSpeed Insights API v5, che
restituisce il `lighthouseResult` completo: stessi audit, stessi punteggi,
stessi suggerimenti di pagespeed.web.dev, più i dati di campo CrUX. Eseguire
Chrome headless in una funzione serverless significherebbe binari enormi e
timeout sistematici.

**La coda sta nel browser.** Una chiamata PSI richiede 15-45 secondi: un batch
da 40 analisi non entrerebbe mai in una funzione serverless. Il client chiama
`/api/analyze` una volta per coppia (url, strategia) con concorrenza limitata e
ritenta con backoff sugli errori 429/5xx. Ogni invocazione resta sotto i 60s.

**La chiave API resta sul server.** Il client non la vede mai: passa sempre da
`/api/analyze`.

**Il payload di export viaggia compresso.** Su 50 pagine × 2 strategie il JSON
supera i 4,5 MB accettati da Vercel. È fatto di descrizioni e tabelle identiche
ripetute su ogni pagina, quindi gzip lo riduce di circa 7 volte. Il client
comprime con `CompressionStream`, il server decomprime con `node:zlib`. Se il
browser non supporta `CompressionStream` si ricade su JSON in chiaro.

## Come si calcola la priorità

Sta in `src/lib/priority.ts` e `src/lib/lighthouse-scoring.ts`.

Il punto delicato: **le opportunità di performance hanno peso 0** nella
categoria Lighthouse. Il punteggio Performance dipende solo dalle 5 metriche,
quindi ordinare gli interventi per peso dell'audit darebbe zero per tutti. Per
questo applichiamo i `metricSavings` dichiarati da Lighthouse ai valori
misurati e ricalcoliamo il punteggio sulle stesse curve log-normali che usa
Lighthouse (`logNormalScore`, con i punti di controllo p10/median per mobile e
desktop). La differenza è la stima dei punti recuperabili.

Per le altre categorie i pesi sono reali, quindi il calcolo è diretto:
`peso × (1 − punteggio) × 100`.

`priorityScore = punti medi × quota di pagine coinvolte × moltiplicatore di categoria`

I moltiplicatori (Performance 1, SEO e Accessibilità 0,7, Best Practices 0,5)
riflettono il fatto che lo strumento nasce per la velocità. Sono in cima a
`priority.ts` e documentati nel foglio "Metodologia" dell'export.

## Regole operative
- Branch di lavoro: `main` (push diretti, nessun PR)
- Dopo ogni sessione di modifiche: commit e push automatico su main
- Prima del push, se ci sono modifiche strutturali: `npm run build`
- `npm run test:smoke` prima di toccare `lib/psi.ts`, `lib/priority.ts`,
  `lib/lighthouse-scoring.ts` o `lib/excel.ts` — gira su un report Lighthouse
  reale e non consuma quota API
- Non modificare `next.config.ts` senza conferma esplicita
- Le variabili d'ambiente vanno in `.env.local` (mai committato)
- Se aggiungi dipendenze, esegui `npm install` prima del push

## UI — regole fisse (non derogabili)
- **Font**: unico font consentito è **Open Sans Light** (weight 300), caricato
  via `next/font/google` in `src/app/layout.tsx` e applicato come `font-sans`
  globale. Nessun altro font, nessun altro peso: la gerarchia visiva si
  costruisce con dimensione e colore.
- **Tema**: sempre **chiaro**. Nessuna dark mode, nemmeno via
  `prefers-color-scheme`.

## Variabili d'ambiente
- `PAGESPEED_API_KEY` — chiave PageSpeed Insights (vedi `.env.example`).
  Opzionale ma di fatto necessaria: senza, la quota anonima condivisa di Google
  è quasi sempre esaurita.

## Limiti noti
- Le tabelle di dettaglio degli audit sono troncate a 10 righe
  (`MAX_TABLE_ITEMS` in `src/lib/psi.ts`) per tenere il payload gestibile. La
  UI dichiara sempre il totale reale.
- Massimo 50 pagine per sessione (`MAX_URLS` in `src/components/Analyzer.tsx`).
- I `subItems` delle tabelle Lighthouse vengono scartati in normalizzazione.
- I punteggi sono dati di laboratorio: due esecuzioni sulla stessa pagina
  possono differire di qualche punto.

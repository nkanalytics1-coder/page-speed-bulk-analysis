# Lighthouse Batch Audit

Analizza la velocità di più pagine di un sito in una sola sessione con il motore
Lighthouse di Google, e scarica le azioni correttive in un Excel ordinato per
priorità.

## Cosa fa

- **Analisi in blocco** — incolla un elenco di URL, o importali automaticamente
  dalla sitemap del sito, e analizzali su mobile e desktop.
- **Report Lighthouse completo** — per ogni pagina: i quattro punteggi, le
  metriche di laboratorio, opportunità, diagnostica, controlli superati,
  informativi e non applicabili, con le tabelle di dettaglio degli audit. Lo
  stesso contenuto di pagespeed.web.dev.
- **Dati reali degli utenti** — dove disponibili, i dati di campo CrUX degli
  ultimi 28 giorni, per pagina e per intero sito.
- **Piano d'azione prioritizzato** — gli audit falliti aggregati su tutte le
  pagine, ordinati per impatto stimato sul punteggio.
- **Export Excel** — sei fogli: piano d'azione, riepilogo pagine, dettaglio per
  pagina, risorse da correggere, dati CrUX e metodologia.

## Avvio in locale

```bash
npm install
cp .env.example .env.local   # poi incolla la chiave API
npm run dev
```

Apri http://localhost:3000.

### Chiave API

Lo strumento usa la [PageSpeed Insights API](https://developers.google.com/speed/docs/insights/v5/get-started).
Funziona anche senza chiave, ma la quota anonima è condivisa fra tutti e in
pratica è sempre esaurita: su più pagine otterrai errori 429.

Per ottenerne una (gratuita, 25.000 richieste al giorno):

1. Vai su [console.cloud.google.com](https://console.cloud.google.com) e crea o
   seleziona un progetto.
2. **API e servizi → Libreria** → abilita **PageSpeed Insights API**.
3. **API e servizi → Credenziali → Crea credenziali → Chiave API**.
4. Limita la chiave alla sola PageSpeed Insights API.

Mettila in `.env.local` come `PAGESPEED_API_KEY`, e su Vercel in
**Settings → Environment Variables**.

## Deploy su Vercel

1. Pusha la repo su GitHub. **Fallo prima di importare il progetto su Vercel**:
   vedi la nota sul Framework Preset più sotto.
2. Su [vercel.com](https://vercel.com) → **Add New Project** → importa la repo.
3. Framework preset: deve essere **Next.js**. Verificalo, non darlo per scontato.
4. Aggiungi `PAGESPEED_API_KEY` fra le Environment Variables **prima** del primo
   deploy.
5. Deploy. Da qui ogni push su `main` ne fa partire uno nuovo.

Le route `/api/analyze` e `/api/export` dichiarano `maxDuration = 60`: sul piano
Hobby è il massimo consentito ed è sufficiente, perché ogni invocazione gestisce
una sola analisi.

### Se il sito risponde 404 dopo un deploy riuscito

Controlla **Settings → Build and Deployment → Framework Preset**: deve essere
**Next.js**. Se è su `Other`, Vercel esegue comunque `npm run build` e il deploy
risulta Ready, ma poi pubblica solo la cartella `public/` come sito statico e
scarta l'output server di Next: home, API e `/_next/static/` rispondono 404
mentre i file dentro `public/` rispondono 200. È il sintomo che distingue questo
caso da un problema di dominio.

Succede quando il progetto viene importato su Vercel **prima** che il codice sia
su GitHub: Vercel ispeziona una repo vuota, non trova `package.json` e ripiega
su `Other`. Il preset non viene ri-rilevato dopo il primo push: va corretto a
mano, e poi serve un nuovo deploy perché l'alias di produzione resta agganciato
al vecchio build finché non ne arriva uno nuovo.

### Se un'analisi va in timeout

L'API PageSpeed Insights occasionalmente supera i 55 secondi su pagine pesanti,
e la route interrompe la chiamata per restituire un errore pulito invece di far
scadere la funzione. L'errore è marcato come ritentabile e il client riprova
fino a 3 volte con backoff, quindi di norma si risolve da solo. Misurato in
produzione su una pagina pesante: 2 successi a circa 30s e un timeout su 3
tentativi.

## Come leggere le priorità

Ogni intervento ha un **punteggio di priorità**:

```
punti recuperabili medi per pagina × quota di pagine coinvolte × moltiplicatore di categoria
```

I punti recuperabili si calcolano in modo diverso a seconda della categoria, per
una ragione precisa.

**Prestazioni.** Le opportunità di performance hanno peso 0 nella categoria
Lighthouse: il punteggio dipende solo dalle cinque metriche (FCP, Speed Index,
LCP, TBT, CLS). Ordinare per peso dell'audit darebbe zero per tutte. Perciò lo
strumento prende i risparmi che Lighthouse dichiara per ogni audit
(`metricSavings` su LCP, FCP, TBT, CLS), li applica ai valori misurati e
ricalcola il punteggio sulle stesse curve log-normali usate da Lighthouse. La
differenza è la stima dei punti che recuperi davvero.

**Altre categorie.** Qui i pesi sono reali, quindi il calcolo è diretto:
`peso dell'audit × (1 − punteggio) × 100`.

**Impatto "stimato da tempo".** Alcuni audit diagnostici non dichiarano alcun
risparmio metrico: l'impatto sul punteggio non è quantificabile, quindi viene
usato il tempo risparmiato come proxy con un tetto di 3 punti. Vanno letti come
approfondimenti, non come stime.

I moltiplicatori di categoria (Prestazioni 1, SEO e Accessibilità 0,7, Best
Practices 0,5) riflettono il fatto che lo strumento serve a ottimizzare la
velocità. Si cambiano in `src/lib/priority.ts` e sono riportati nel foglio
"Metodologia" di ogni export.

## Verifica

```bash
npm run test:smoke
```

Fa passare un report Lighthouse reale (`scripts/fixtures/sample-lhr.json`, dal
repo ufficiale GoogleChrome/lighthouse) per normalizzazione, calcolo delle
priorità e generazione dell'Excel, poi rilegge il file prodotto. Non consuma
quota API e non richiede un server in esecuzione.

Controlla fra l'altro che le curve di scoring riproducano i punti di controllo
di Lighthouse, che i pesi di ogni categoria sommino a 1, che le metriche non
finiscano fra le azioni, e che il payload compresso resti sotto il limite di
4,5 MB di Vercel nel caso peggiore ammesso dalla UI.

## Limiti

- Le tabelle di dettaglio sono troncate a 10 righe per audit; la UI dichiara
  sempre il totale reale.
- Massimo 50 pagine per sessione.
- I punteggi sono dati di laboratorio, da una singola simulazione su rete e CPU
  emulate: due esecuzioni sulla stessa pagina possono differire di qualche
  punto. Le differenze piccole non sono segnale. I dati di campo CrUX, dove
  presenti, sono la fonte più affidabile per l'impatto reale.

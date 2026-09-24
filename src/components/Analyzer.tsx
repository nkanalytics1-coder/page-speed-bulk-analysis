"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { ActionPlanTable } from "./ActionPlanTable";
import { CompetitorTable, type CompetitorRow } from "./CompetitorTable";
import { Gauge, ScoreChip } from "./Gauge";
import { PageReport } from "./PageReport";
import { TemplateTable } from "./TemplateTable";
import {
  CRUX_TTL_MS,
  LIGHTHOUSE_TTL_MS,
  cacheClear,
  cacheGet,
  cacheSet,
  cruxKey,
  lighthouseKey,
} from "@/lib/cache";
import type { CruxMiss, CruxResult, FormFactor } from "@/lib/crux";
import {
  PAYLOAD_ENCODING_HEADER,
  gzipJson,
  toExportPayload,
} from "@/lib/export-payload";
import { shortUrl } from "@/lib/format";
import { buildActionPlan } from "@/lib/priority";
import { groupByTemplate, sampleSize, type Template } from "@/lib/templates";
import type { Importance } from "@/lib/templates";
import {
  importanceByUrl,
  sortByUrgency,
  summarizeTemplate,
} from "@/lib/template-summary";
import { CATEGORY_IDS, CATEGORY_LABELS } from "@/lib/types";
import type { AnalyzeResponse, RunResult, Strategy } from "@/lib/types";

const MAX_URLS = 500;
const CRUX_BATCH = 40;
const LIGHTHOUSE_CONCURRENCY = 8;
const LIGHTHOUSE_ATTEMPTS = 3;

type JobStatus = "pending" | "running" | "done" | "error";

interface Job {
  key: string;
  url: string;
  strategy: Strategy;
  status: JobStatus;
  result?: RunResult;
  error?: string;
}

function parseUrls(input: string): string[] {
  const seen = new Set<string>();
  for (const token of input.split(/[\s,]+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname.includes(".")) seen.add(parsed.toString());
    } catch {
      // token non interpretabile: lo ignoriamo
    }
  }
  return [...seen];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Intestazione numerata di uno step, con la spiegazione di cosa fa. */
function StepHeading({
  number,
  title,
  description,
  aside,
}: {
  number: number;
  title: string;
  description: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-base">
          <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-surface-alt text-sm text-ink-muted">
            {number}
          </span>
          {title}
        </h2>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
          {description}
        </p>
      </div>
      {aside}
    </div>
  );
}

/** Etichetta di un campo, con la riga che spiega cosa scriverci. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm">{label}</label>
      <p className="mt-0.5 text-xs leading-relaxed text-ink-faint">{hint}</p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

export function Analyzer() {
  const [sitemapInput, setSitemapInput] = useState("");
  const [urlsText, setUrlsText] = useState("");
  const [samplesPerTemplate, setSamplesPerTemplate] = useState(3);
  const [formFactor, setFormFactor] = useState<FormFactor>("PHONE");

  const [sitemapBusy, setSitemapBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ done: 0, total: 0 });
  const [cruxResults, setCruxResults] = useState<Record<string, CruxResult>>({});
  const [cruxMisses, setCruxMisses] = useState<CruxMiss[]>([]);
  const [scannedTemplates, setScannedTemplates] = useState<Template[]>([]);
  const [templateTypes, setTemplateTypes] = useState<Record<string, string>>({});
  // Solo le importanze impostate a mano: le altre seguono il tipo di pagina,
  // così cambiare il tipo aggiorna anche l'importanza proposta.
  const [importanceOverrides, setImportanceOverrides] = useState<
    Record<string, Importance>
  >({});
  const [cacheHits, setCacheHits] = useState(0);

  const [competitorsText, setCompetitorsText] = useState("");
  const [competitorPage, setCompetitorPage] = useState("");
  const [competitorRows, setCompetitorRows] = useState<CompetitorRow[]>([]);
  const [comparing, setComparing] = useState(false);

  const [jobs, setJobs] = useState<Job[]>([]);
  const [diagnosing, setDiagnosing] = useState<Set<string>>(new Set());
  const [diagnosed, setDiagnosed] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const cancelled = useRef(false);

  const urls = useMemo(() => parseUrls(urlsText), [urlsText]);
  const templates = useMemo(
    () => groupByTemplate(urls, { samplesPerTemplate }),
    [urls, samplesPerTemplate],
  );
  const plannedAnalyses = sampleSize(templates);

  const summaries = useMemo(() => {
    if (scannedTemplates.length === 0) return [];
    return sortByUrgency(
      scannedTemplates.map((template) =>
        summarizeTemplate(
          template,
          template.sample
            .map((url) => cruxResults[cruxKey(url, formFactor)])
            .filter((result): result is CruxResult => Boolean(result)),
          templateTypes[template.pattern],
          importanceOverrides[template.pattern],
        ),
      ),
    );
  }, [
    scannedTemplates,
    cruxResults,
    formFactor,
    templateTypes,
    importanceOverrides,
  ]);

  const lighthouseRuns = useMemo(
    () =>
      jobs
        .filter((job): job is Job & { result: RunResult } => Boolean(job.result))
        .map((job) => job.result),
    [jobs],
  );

  const plan = useMemo(
    () => buildActionPlan(lighthouseRuns, importanceByUrl(summaries)),
    [lighthouseRuns, summaries],
  );

  /* ---------------------------------------------------------- sitemap */

  const importSitemap = useCallback(async () => {
    if (!sitemapInput.trim()) return;
    setSitemapBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/sitemap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: sitemapInput.trim() }),
      });
      const data = (await response.json()) as
        | { ok: true; urls: string[]; sitemap: string; truncated: boolean }
        | { ok: false; error: string };

      if (!data.ok) {
        setError(data.error);
        return;
      }

      setUrlsText(data.urls.join("\n"));
      setMessage(
        `${data.urls.length} URL importati da ${data.sitemap}${
          data.truncated ? " (elenco troncato a 300)" : ""
        }.`,
      );
    } catch {
      setError("Impossibile leggere la sitemap.");
    } finally {
      setSitemapBusy(false);
    }
  }, [sitemapInput]);

  /* ------------------------------------------------------------- CrUX */

  /** Interroga CrUX passando prima dalla cache locale. */
  const fetchCrux = useCallback(
    async (
      targets: string[],
      factor: FormFactor,
      onProgress?: (done: number) => void,
    ): Promise<{ results: CruxResult[]; misses: CruxMiss[]; fromCache: number }> => {
      const results: CruxResult[] = [];
      const misses: CruxMiss[] = [];
      const pending: string[] = [];
      let fromCache = 0;
      let done = 0;

      for (const url of targets) {
        const cached = await cacheGet<CruxResult>(cruxKey(url, factor), CRUX_TTL_MS);
        if (cached) {
          results.push(cached.value);
          fromCache += 1;
          done += 1;
          onProgress?.(done);
        } else {
          pending.push(url);
        }
      }

      for (const batch of chunk(pending, CRUX_BATCH)) {
        if (cancelled.current) break;
        try {
          const response = await fetch("/api/crux", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              targets: batch.map((url) => ({ url, formFactor: factor })),
            }),
          });
          const data = (await response.json()) as
            | { ok: true; results: CruxResult[]; misses: CruxMiss[] }
            | { ok: false; error: string };

          if (!data.ok) {
            setError(data.error);
            break;
          }

          for (const result of data.results) {
            results.push(result);
            await cacheSet(cruxKey(result.requestedUrl, factor), result);
          }
          misses.push(...data.misses);
        } catch {
          setError("Errore durante la richiesta dei dati di campo.");
          break;
        }
        done += batch.length;
        onProgress?.(done);
      }

      return { results, misses, fromCache };
    },
    [],
  );

  const startScan = useCallback(async () => {
    if (urls.length === 0) {
      setError("Inserisci almeno un URL, o importa una sitemap.");
      return;
    }
    if (urls.length > MAX_URLS) {
      setError(`Massimo ${MAX_URLS} URL. Ne hai ${urls.length}.`);
      return;
    }

    setError(null);
    setMessage(null);
    cancelled.current = false;
    setScanning(true);
    setJobs([]);
    setDiagnosed(new Set());
    setSelectedKey(null);

    const currentTemplates = templates;
    const sampleUrls = [
      ...new Set(currentTemplates.flatMap((template) => template.sample)),
    ];
    setScanProgress({ done: 0, total: sampleUrls.length });

    const { results, misses, fromCache } = await fetchCrux(
      sampleUrls,
      formFactor,
      (done) => setScanProgress({ done, total: sampleUrls.length }),
    );

    const byKey: Record<string, CruxResult> = {};
    for (const result of results) {
      byKey[cruxKey(result.requestedUrl, formFactor)] = result;
    }

    setCruxResults(byKey);
    setCruxMisses(misses);
    setScannedTemplates(currentTemplates);
    // I tipi dedotti diventano il valore iniziale, poi restano quelli scelti.
    setTemplateTypes((current) => {
      const next = { ...current };
      for (const template of currentTemplates) {
        if (!next[template.pattern]) next[template.pattern] = template.suggestedType;
      }
      return next;
    });
    setCacheHits(fromCache);
    setScanning(false);
  }, [fetchCrux, formFactor, templates, urls]);

  /* ------------------------------------------------------- competitor */

  const runComparison = useCallback(async () => {
    const competitors = parseUrls(competitorsText);
    if (competitors.length === 0) {
      setError("Inserisci almeno un concorrente.");
      return;
    }

    const own = competitorPage.trim()
      ? parseUrls(competitorPage)[0]
      : (urls[0] ?? null);

    if (!own) {
      setError("Indica la tua pagina da mettere a confronto.");
      return;
    }

    setError(null);
    setComparing(true);

    const targets = [...new Set([own, ...competitors])];
    const { results, misses } = await fetchCrux(targets, formFactor);
    const byUrl = new Map(results.map((result) => [result.requestedUrl, result]));

    const rows: CompetitorRow[] = [
      {
        label: new URL(own).hostname,
        isSelf: true,
        result: byUrl.get(own) ?? null,
        miss: byUrl.get(own) ? null : "Nessun dato di campo",
      },
      ...competitors.map((url) => {
        const result = byUrl.get(url) ?? null;
        const miss = misses.find((entry) => entry.requestedUrl === url);
        return {
          label: new URL(url).hostname,
          isSelf: false,
          result,
          miss: result ? null : (miss?.message ?? "Nessun dato di campo"),
        };
      }),
    ];

    setCompetitorRows(rows);
    setComparing(false);
  }, [competitorPage, competitorsText, fetchCrux, formFactor, urls]);

  /* ------------------------------------------------- diagnosi Lighthouse */

  const analyzeOne = useCallback(
    async (url: string, strategy: Strategy): Promise<RunResult> => {
      const cached = await cacheGet<RunResult>(
        lighthouseKey(url, strategy),
        LIGHTHOUSE_TTL_MS,
      );
      if (cached) return cached.value;

      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, strategy }),
      });
      const data = (await response.json()) as AnalyzeResponse;
      if (!data.ok) {
        const failure = new Error(data.error) as Error & { retryable?: boolean };
        failure.retryable = data.retryable;
        throw failure;
      }

      await cacheSet(lighthouseKey(url, strategy), data.result);
      return data.result;
    },
    [],
  );

  const diagnose = useCallback(
    async (pattern: string, targetUrls: string[]) => {
      const strategy: Strategy = formFactor === "DESKTOP" ? "desktop" : "mobile";
      cancelled.current = false;
      setDiagnosing((current) => new Set(current).add(pattern));

      const newJobs: Job[] = targetUrls.map((url) => ({
        key: `${url}::${strategy}`,
        url,
        strategy,
        status: "pending" as JobStatus,
      }));

      setJobs((current) => {
        const existing = new Set(current.map((job) => job.key));
        return [...current, ...newJobs.filter((job) => !existing.has(job.key))];
      });

      const queue = [...newJobs];
      const worker = async () => {
        while (queue.length > 0 && !cancelled.current) {
          const job = queue.shift();
          if (!job) break;

          setJobs((current) =>
            current.map((entry) =>
              entry.key === job.key ? { ...entry, status: "running" } : entry,
            ),
          );

          for (let attempt = 1; attempt <= LIGHTHOUSE_ATTEMPTS; attempt += 1) {
            try {
              const result = await analyzeOne(job.url, job.strategy);
              setJobs((current) =>
                current.map((entry) =>
                  entry.key === job.key
                    ? { ...entry, status: "done", result }
                    : entry,
                ),
              );
              break;
            } catch (failure) {
              const retryable =
                failure instanceof Error &&
                (failure as Error & { retryable?: boolean }).retryable !== false;
              const text =
                failure instanceof Error ? failure.message : "Errore sconosciuto.";

              if (!retryable || attempt === LIGHTHOUSE_ATTEMPTS) {
                setJobs((current) =>
                  current.map((entry) =>
                    entry.key === job.key
                      ? { ...entry, status: "error", error: text }
                      : entry,
                  ),
                );
                break;
              }
              // Backoff esponenziale: PSI rifiuta le raffiche ravvicinate e
              // ogni tanto fallisce da sola, quindi conviene distanziare.
              await sleep(2000 * 2 ** (attempt - 1));
            }
          }
        }
      };

      await Promise.all(
        Array.from(
          { length: Math.min(LIGHTHOUSE_CONCURRENCY, newJobs.length) },
          worker,
        ),
      );

      setDiagnosing((current) => {
        const next = new Set(current);
        next.delete(pattern);
        return next;
      });
      setDiagnosed((current) => new Set(current).add(pattern));
    },
    [analyzeOne, formFactor],
  );

  /* ------------------------------------------------------------ export */

  const downloadExcel = useCallback(async () => {
    if (lighthouseRuns.length === 0 && summaries.length === 0) return;
    setExporting(true);
    try {
      let site = "sito";
      try {
        site = new URL(urls[0]).hostname;
      } catch {
        // manteniamo il nome di default
      }

      const payload = {
        runs: toExportPayload(lighthouseRuns),
        templates: summaries,
        competitors: competitorRows,
        formFactor,
        site,
      };

      const compressed = await gzipJson(payload);
      const response = await fetch("/api/export", {
        method: "POST",
        headers: compressed
          ? {
              "Content-Type": "application/octet-stream",
              [PAYLOAD_ENCODING_HEADER]: "gzip",
            }
          : { "Content-Type": "application/json" },
        body: compressed ?? JSON.stringify(payload),
      });

      if (!response.ok) {
        setError("Generazione del file Excel non riuscita.");
        return;
      }

      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `velocita-${site}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
    } catch {
      setError("Generazione del file Excel non riuscita.");
    } finally {
      setExporting(false);
    }
  }, [competitorRows, formFactor, lighthouseRuns, summaries, urls]);

  const selectedRun = lighthouseRuns.find((run) => run.key === selectedKey) ?? null;
  const runningJobs = jobs.filter((job) => job.status === "running").length;
  const failedJobs = jobs.filter((job) => job.status === "error");
  const scanned = summaries.length > 0;

  /* -------------------------------------------------------------- vista */

  return (
    <div className="space-y-6">
      {error ? (
        <p className="rounded border border-fail bg-fail-soft px-3 py-2 text-sm text-fail">
          {error}
        </p>
      ) : null}

      {/* ------------------------------------------------------- Step 1 */}
      <section className="rounded-lg border border-border p-5">
        <StepHeading
          number={1}
          title="Il tuo sito"
          description="Indica quali pagine controllare. Lo strumento le raggruppa da solo per template, così non serve analizzarle tutte: le pagine costruite allo stesso modo hanno gli stessi problemi."
        />

        <div className="space-y-5">
          <Field
            label="Dominio o sitemap"
            hint="Scrivi il dominio (esempio.it) e cerco io la sitemap nel robots.txt e nei percorsi standard. Se la conosci già, incolla direttamente l'indirizzo del file .xml."
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={sitemapInput}
                onChange={(event) => setSitemapInput(event.target.value)}
                placeholder="esempio.it"
                className="flex-1 rounded border border-border px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={importSitemap}
                disabled={sitemapBusy || !sitemapInput.trim()}
                className="rounded border border-border px-4 py-2 text-sm hover:bg-surface disabled:opacity-40"
              >
                {sitemapBusy ? "Leggo…" : "Importa le pagine"}
              </button>
            </div>
          </Field>

          <Field
            label="Pagine da controllare"
            hint="Un indirizzo per riga. Si riempie da solo con il pulsante qui sopra, ma puoi anche incollare la tua lista o togliere le pagine che non ti interessano."
          >
            <textarea
              value={urlsText}
              onChange={(event) => setUrlsText(event.target.value)}
              rows={6}
              spellCheck={false}
              placeholder={"https://esempio.it/\nhttps://esempio.it/prodotti/scarpa-rossa\nhttps://esempio.it/blog/come-scegliere"}
              className="w-full rounded border border-border px-3 py-2 font-mono text-xs outline-none focus:border-accent"
            />
          </Field>

          {urls.length > 0 ? (
            <div className="rounded border border-border bg-surface px-3 py-2">
              <p className="text-sm">
                {urls.length} indirizzi, raggruppati in {templates.length} template.
                Controllandone {samplesPerTemplate} per gruppo bastano{" "}
                <strong>{plannedAnalyses} pagine</strong>.
              </p>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {templates.slice(0, 8).map((template) => (
                  <li key={template.pattern} className="text-xs text-ink-muted">
                    <span className="font-mono">{template.pattern}</span>{" "}
                    <span className="text-ink-faint">({template.urls.length})</span>
                  </li>
                ))}
                {templates.length > 8 ? (
                  <li className="text-xs text-ink-faint">
                    e altri {templates.length - 8}
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
            <Field
              label="Pagine per template"
              hint="Quante pagine controllare per ogni gruppo. Tre bastano quasi sempre."
            >
              <select
                value={samplesPerTemplate}
                onChange={(event) =>
                  setSamplesPerTemplate(Number(event.target.value))
                }
                className="rounded border border-border px-2 py-1.5 text-sm"
              >
                {[1, 2, 3, 5, 8].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Dispositivo"
              hint="Google valuta il sito sui dati mobile: parti da lì."
            >
              <select
                value={formFactor}
                onChange={(event) =>
                  setFormFactor(event.target.value as FormFactor)
                }
                className="rounded border border-border px-2 py-1.5 text-sm"
              >
                <option value="PHONE">Mobile</option>
                <option value="DESKTOP">Desktop</option>
              </select>
            </Field>
          </div>

          {message ? <p className="text-xs text-ink-muted">{message}</p> : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={startScan}
              disabled={scanning || urls.length === 0}
              className="rounded bg-accent px-5 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40"
            >
              {scanning
                ? `Controllo… ${scanProgress.done}/${scanProgress.total}`
                : "Controlla i dati reali"}
            </button>
            <button
              type="button"
              onClick={async () => {
                await cacheClear();
                setMessage("Risultati salvati cancellati.");
              }}
              className="text-xs text-ink-faint underline underline-offset-2"
            >
              Svuota i risultati salvati
            </button>
          </div>

          <p className="text-xs leading-relaxed text-ink-faint">
            Questo primo controllo usa i dati degli utenti reali di Chrome: arriva
            in pochi secondi perché non simula niente. La diagnosi vera e propria,
            più lenta, la lanci dopo e solo dove serve.
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------- Step 2 */}
      {scanned ? (
        <section className="rounded-lg border border-border p-5">
          <StepHeading
            number={2}
            title="Come va il sito, per tipo di pagina"
            description="Questi sono i dati degli utenti reali di Chrome degli ultimi 28 giorni: è su questi che Google valuta il sito. Nelle prime due colonne controlla il tipo di pagina e quanto conta per il tuo business: il tipo finisce nel report, l'importanza decide l'ordine degli interventi. Un secondo perso sul checkout non vale quanto un secondo perso su un archivio di tag, e questo solo tu puoi saperlo."
            aside={
              <div className="flex items-center gap-3">
                <span className="text-xs text-ink-faint">
                  {summaries.filter((entry) => entry.passesCwv === false).length}{" "}
                  da sistemare
                  {cacheHits > 0 ? ` · ${cacheHits} già in memoria` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    for (const summary of summaries) {
                      void diagnose(summary.pattern, summary.sampleUrls);
                    }
                  }}
                  disabled={diagnosing.size > 0}
                  className="rounded border border-accent px-3 py-1 text-xs text-accent hover:bg-accent-soft disabled:opacity-40"
                >
                  Diagnosi su tutti ({sampleSize(scannedTemplates)} pagine)
                </button>
              </div>
            }
          />

          {summaries.length > 1 &&
          summaries.every((entry) => entry.dataScope === "origin") ? (
            <p className="mb-3 rounded border border-average bg-average-soft px-3 py-2 text-sm leading-relaxed">
              Attenzione: Google non pubblica dati sulle singole pagine di questo
              sito, quindi ogni riga qui sotto riporta lo stesso valore, quello
              dell&apos;intero dominio. Confrontare i template fra loro non ha
              senso. Usa la diagnosi Lighthouse, che misura pagina per pagina.
            </p>
          ) : null}

          <TemplateTable
            summaries={summaries}
            diagnosing={diagnosing}
            diagnosed={diagnosed}
            onTypeChange={(pattern, pageType) =>
              setTemplateTypes((current) => ({ ...current, [pattern]: pageType }))
            }
            onImportanceChange={(pattern, importance) =>
              setImportanceOverrides((current) => ({
                ...current,
                [pattern]: importance,
              }))
            }
            onDiagnose={(summary) =>
              diagnose(
                summary.pattern,
                summary.failingUrls.length > 0
                  ? summary.failingUrls
                  : summary.sampleUrls,
              )
            }
          />

          {cruxMisses.length > 0 ? (
            <details className="mt-3 rounded border border-border px-3 py-2">
              <summary className="cursor-pointer text-xs text-ink-muted">
                {cruxMisses.length} pagine senza dati reali
              </summary>
              <p className="mt-2 text-xs leading-relaxed text-ink-faint">
                Google pubblica questi dati solo per pagine con traffico
                sufficiente. Su queste puoi comunque lanciare la diagnosi
                Lighthouse, che non ha questo limite.
              </p>
              <ul className="mt-2 space-y-0.5">
                {cruxMisses.slice(0, 20).map((miss) => (
                  <li key={miss.requestedUrl} className="text-xs text-ink-muted">
                    {shortUrl(miss.requestedUrl, 70)}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <div className="mt-4">
            <button
              type="button"
              onClick={downloadExcel}
              disabled={exporting}
              className="rounded border border-accent px-4 py-2 text-sm text-accent hover:bg-accent-soft disabled:opacity-40"
            >
              {exporting ? "Preparo il file…" : "Scarica il report Excel"}
            </button>
            <span className="ml-3 text-xs text-ink-faint">
              Include tutto quello che hai raccolto finora.
            </span>
          </div>
        </section>
      ) : null}

      {/* ------------------------------------------------------- Step 3 */}
      {scanned ? (
        <section className="rounded-lg border border-border p-5">
          <StepHeading
            number={3}
            title="Confronto con i concorrenti"
            description="Facoltativo, e puoi farlo anche in un secondo momento. Il confronto si basa sui dati degli utenti reali, quindi è immediato e non consuma analisi."
          />

          <div className="space-y-5">
            <Field
              label="Concorrenti"
              hint="Un sito per riga. Puoi scrivere solo il dominio (concorrente.it) per confrontare l'intero sito, oppure l'indirizzo di una pagina precisa se vuoi mettere a confronto pagine dello stesso tipo — la tua scheda prodotto contro la loro."
            >
              <textarea
                value={competitorsText}
                onChange={(event) => setCompetitorsText(event.target.value)}
                rows={3}
                spellCheck={false}
                placeholder={"concorrente1.it\nconcorrente2.it\nhttps://concorrente3.it/prodotti/qualcosa"}
                className="w-full rounded border border-border px-3 py-2 font-mono text-xs outline-none focus:border-accent"
              />
            </Field>

            <Field
              label="La tua pagina da confrontare"
              hint={`Lascia vuoto per usare ${urls[0] ? shortUrl(urls[0], 40) : "la prima pagina dell'elenco"}. Compila solo se vuoi confrontare una pagina specifica, dello stesso tipo di quelle dei concorrenti.`}
            >
              <input
                type="text"
                value={competitorPage}
                onChange={(event) => setCompetitorPage(event.target.value)}
                placeholder={urls[0] ?? "https://esempio.it/"}
                className="w-full rounded border border-border px-3 py-2 font-mono text-xs outline-none focus:border-accent"
              />
            </Field>

            <button
              type="button"
              onClick={runComparison}
              disabled={comparing || !competitorsText.trim()}
              className="rounded bg-accent px-5 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40"
            >
              {comparing ? "Confronto…" : "Confronta"}
            </button>

            {competitorRows.length > 0 ? (
              <CompetitorTable rows={competitorRows} />
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ------------------------------------------------------- Step 4 */}
      {jobs.length > 0 ? (
        <section className="rounded-lg border border-border p-5">
          <StepHeading
            number={4}
            title="Diagnosi: cosa correggere"
            description="Qui Lighthouse ha simulato il caricamento delle pagine per capire perché sono lente. Gli interventi sono ordinati per impatto: i primi valgono più degli ultimi."
            aside={
              <span className="text-xs text-ink-faint">
                {jobs.filter((job) => job.status === "done").length} / {jobs.length}
                {runningJobs > 0 ? ` · ${runningJobs} in corso` : ""}
              </span>
            }
          />

          {failedJobs.length > 0 ? (
            <details className="mb-4 rounded border border-fail bg-fail-soft px-3 py-2">
              <summary className="cursor-pointer text-xs text-fail">
                {failedJobs.length} analisi non riuscite
              </summary>
              <ul className="mt-2 space-y-1">
                {failedJobs.map((job) => (
                  <li key={job.key} className="text-xs text-ink-muted">
                    {shortUrl(job.url, 60)}: {job.error}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {lighthouseRuns.length > 0 && !selectedRun ? (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-6 rounded-lg border border-border p-5">
                {CATEGORY_IDS.map((category) => {
                  const scores = lighthouseRuns
                    .map((run) => run.categories[category]?.score)
                    .filter((score): score is number => typeof score === "number");
                  const average =
                    scores.length > 0
                      ? scores.reduce((sum, score) => sum + score, 0) / scores.length
                      : null;
                  return (
                    <Gauge
                      key={category}
                      score={average}
                      label={CATEGORY_LABELS[category]}
                      size="md"
                    />
                  );
                })}
              </div>

              <ActionPlanTable items={plan.items} />

              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[40rem] text-left">
                  <thead className="bg-surface-alt text-xs text-ink-muted">
                    <tr>
                      <th className="px-3 py-2">Pagina</th>
                      {CATEGORY_IDS.map((category) => (
                        <th key={category} className="px-3 py-2 text-center">
                          {CATEGORY_LABELS[category]}
                        </th>
                      ))}
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {lighthouseRuns.map((run) => (
                      <tr key={run.key} className="border-t border-border">
                        <td className="max-w-xs truncate px-3 py-2 text-sm">
                          {shortUrl(run.requestedUrl, 50)}
                        </td>
                        {CATEGORY_IDS.map((category) => (
                          <td key={category} className="px-3 py-2 text-center">
                            <ScoreChip
                              score={run.categories[category]?.score ?? null}
                            />
                          </td>
                        ))}
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedKey(run.key)}
                            className="text-xs text-accent underline underline-offset-2"
                          >
                            Report
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {selectedRun ? (
            <div className="space-y-4">
              <button
                type="button"
                onClick={() => setSelectedKey(null)}
                className="text-sm text-accent underline underline-offset-2"
              >
                ← Torna all&apos;elenco
              </button>
              <PageReport run={selectedRun} />
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

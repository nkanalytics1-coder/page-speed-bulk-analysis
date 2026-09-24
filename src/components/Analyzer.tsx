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
import { sortByUrgency, summarizeTemplate } from "@/lib/template-summary";
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

export function Analyzer() {
  const [sitemapInput, setSitemapInput] = useState("");
  const [urlsText, setUrlsText] = useState("");
  const [competitorsText, setCompetitorsText] = useState("");
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
  const [competitorRows, setCompetitorRows] = useState<CompetitorRow[]>([]);
  const [cacheHits, setCacheHits] = useState(0);

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
        ),
      ),
    );
  }, [scannedTemplates, cruxResults, formFactor]);

  const lighthouseRuns = useMemo(
    () =>
      jobs
        .filter((job): job is Job & { result: RunResult } => Boolean(job.result))
        .map((job) => job.result),
    [jobs],
  );

  const plan = useMemo(() => buildActionPlan(lighthouseRuns), [lighthouseRuns]);

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
          data.truncated ? " (elenco troncato)" : ""
        }.`,
      );
    } catch {
      setError("Impossibile leggere la sitemap.");
    } finally {
      setSitemapBusy(false);
    }
  }, [sitemapInput]);

  /* ------------------------------------------------------- scansione */

  /** Interroga CrUX passando prima dalla cache locale. */
  const fetchCrux = useCallback(
    async (
      targets: string[],
      factor: FormFactor,
      onProgress: (done: number) => void,
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
          onProgress(done);
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
          setError("Errore durante la scansione CrUX.");
          break;
        }
        done += batch.length;
        onProgress(done);
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
    const sampleUrls = currentTemplates.flatMap((template) => template.sample);
    const competitors = parseUrls(competitorsText);
    // Il confronto ha senso solo a parità di oggetto: mettiamo a fianco dei
    // competitor la nostra prima URL, che è quasi sempre la home.
    const selfTarget = competitors.length > 0 ? urls[0] : null;

    const allTargets = [
      ...new Set([...sampleUrls, ...(selfTarget ? [selfTarget] : []), ...competitors]),
    ];
    setScanProgress({ done: 0, total: allTargets.length });

    const { results, misses, fromCache } = await fetchCrux(
      allTargets,
      formFactor,
      (done) => setScanProgress({ done, total: allTargets.length }),
    );

    const byKey: Record<string, CruxResult> = {};
    for (const result of results) {
      byKey[cruxKey(result.requestedUrl, formFactor)] = result;
    }

    setCruxResults(byKey);
    setCruxMisses(misses);
    setScannedTemplates(currentTemplates);
    setCacheHits(fromCache);

    if (competitors.length > 0 && selfTarget) {
      const rows: CompetitorRow[] = [];
      const own = byKey[cruxKey(selfTarget, formFactor)] ?? null;
      rows.push({
        label: new URL(selfTarget).hostname,
        isSelf: true,
        result: own,
        miss: own ? null : "Nessun dato di campo",
      });
      for (const competitor of competitors) {
        const result = byKey[cruxKey(competitor, formFactor)] ?? null;
        const miss = misses.find((entry) => entry.requestedUrl === competitor);
        rows.push({
          label: new URL(competitor).hostname,
          isSelf: false,
          result,
          miss: result ? null : (miss?.message ?? "Nessun dato di campo"),
        });
      }
      setCompetitorRows(rows);
    } else {
      setCompetitorRows([]);
    }

    setScanning(false);
  }, [competitorsText, fetchCrux, formFactor, templates, urls]);

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

  /* -------------------------------------------------------------- vista */

  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-border p-5">
        <h2 className="text-sm text-ink-muted">1. Le pagine da controllare</h2>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={sitemapInput}
            onChange={(event) => setSitemapInput(event.target.value)}
            placeholder="esempio.it oppure https://esempio.it/sitemap.xml"
            className="flex-1 rounded border border-border px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={importSitemap}
            disabled={sitemapBusy || !sitemapInput.trim()}
            className="rounded border border-border px-4 py-2 text-sm hover:bg-surface disabled:opacity-40"
          >
            {sitemapBusy ? "Leggo…" : "Importa da sitemap"}
          </button>
        </div>

        <textarea
          value={urlsText}
          onChange={(event) => setUrlsText(event.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={"https://esempio.it/\nhttps://esempio.it/prodotti/scarpa-rossa\nhttps://esempio.it/blog/come-scegliere"}
          className="mt-3 w-full rounded border border-border px-3 py-2 font-mono text-xs outline-none focus:border-accent"
        />

        {urls.length > 0 ? (
          <div className="mt-3 rounded border border-border bg-surface px-3 py-2">
            <p className="text-sm">
              {urls.length} URL raggruppate in {templates.length} template.
              Analizzandone {samplesPerTemplate} per template servono{" "}
              <strong>{plannedAnalyses} controlli</strong> invece di {urls.length}.
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

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="flex items-center gap-2 text-sm">
            Pagine per template
            <select
              value={samplesPerTemplate}
              onChange={(event) =>
                setSamplesPerTemplate(Number(event.target.value))
              }
              className="rounded border border-border px-2 py-1 text-sm"
            >
              {[1, 2, 3, 5, 8].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-sm">
            Dispositivo
            <select
              value={formFactor}
              onChange={(event) => setFormFactor(event.target.value as FormFactor)}
              className="rounded border border-border px-2 py-1 text-sm"
            >
              <option value="PHONE">Mobile</option>
              <option value="DESKTOP">Desktop</option>
            </select>
          </label>
        </div>

        <div className="mt-4">
          <label className="block text-sm text-ink-muted">
            Competitor da confrontare (facoltativo, uno per riga)
          </label>
          <textarea
            value={competitorsText}
            onChange={(event) => setCompetitorsText(event.target.value)}
            rows={3}
            spellCheck={false}
            placeholder={"concorrente1.it\nconcorrente2.it"}
            className="mt-2 w-full rounded border border-border px-3 py-2 font-mono text-xs outline-none focus:border-accent"
          />
        </div>

        {error ? (
          <p className="mt-3 rounded border border-fail bg-fail-soft px-3 py-2 text-sm text-fail">
            {error}
          </p>
        ) : null}
        {message ? <p className="mt-3 text-xs text-ink-muted">{message}</p> : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={startScan}
            disabled={scanning || urls.length === 0}
            className="rounded bg-accent px-5 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40"
          >
            {scanning
              ? `Scansione… ${scanProgress.done}/${scanProgress.total}`
              : "Scansiona i dati reali"}
          </button>
          {summaries.length > 0 ? (
            <button
              type="button"
              onClick={downloadExcel}
              disabled={exporting}
              className="rounded border border-accent px-4 py-2 text-sm text-accent hover:bg-accent-soft disabled:opacity-40"
            >
              {exporting ? "Preparo il file…" : "Scarica Excel"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={async () => {
              await cacheClear();
              setMessage("Cache svuotata.");
            }}
            className="text-xs text-ink-faint underline underline-offset-2"
          >
            Svuota la cache
          </button>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          La scansione usa i dati di campo del Chrome UX Report: sono i numeri su
          cui Google valuta davvero il sito e arrivano in meno di un secondo per
          pagina, perché non viene eseguita nessuna simulazione. La diagnosi
          Lighthouse, che è lenta, la lanci dopo e solo sui template che ne hanno
          bisogno.
        </p>
      </section>

      {summaries.length > 0 ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-sm text-ink-muted">
              2. Dati reali degli utenti, per template
            </h2>
            <div className="flex items-center gap-3">
              <span className="text-xs text-ink-faint">
                {summaries.filter((entry) => entry.passesCwv === false).length}{" "}
                template da sistemare
                {cacheHits > 0 ? ` · ${cacheHits} risultati dalla cache` : ""}
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
                Diagnosi su tutti i template ({sampleSize(scannedTemplates)}{" "}
                pagine)
              </button>
            </div>
          </div>

          {summaries.length > 1 &&
          summaries.every((entry) => entry.dataScope === "origin") ? (
            <p className="rounded border border-average bg-average-soft px-3 py-2 text-sm leading-relaxed">
              Attenzione: il Chrome UX Report non ha dati sulle singole pagine di
              questo sito, quindi ogni riga qui sotto riporta lo stesso valore,
              quello dell&apos;intero dominio. Il confronto fra template non dice
              nulla. Serve traffico maggiore sulle singole pagine perché Google
              li pubblichi; nel frattempo usa la diagnosi Lighthouse, che misura
              davvero pagina per pagina.
            </p>
          ) : null}

          <TemplateTable
            summaries={summaries}
            diagnosing={diagnosing}
            diagnosed={diagnosed}
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
            <details className="rounded border border-border px-3 py-2">
              <summary className="cursor-pointer text-xs text-ink-muted">
                {cruxMisses.length} pagine senza dati di campo
              </summary>
              <p className="mt-2 text-xs leading-relaxed text-ink-faint">
                Il Chrome UX Report pubblica i dati solo per pagine con traffico
                sufficiente. Per queste puoi comunque lanciare la diagnosi
                Lighthouse, che non ha questo limite ma è una simulazione.
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
        </section>
      ) : null}

      {competitorRows.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm text-ink-muted">3. Confronto con i competitor</h2>
          <CompetitorTable rows={competitorRows} />
        </section>
      ) : null}

      {jobs.length > 0 ? (
        <section className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-sm text-ink-muted">4. Diagnosi Lighthouse</h2>
            <span className="text-xs text-ink-faint">
              {jobs.filter((job) => job.status === "done").length} / {jobs.length}
              {runningJobs > 0 ? ` · ${runningJobs} in corso` : ""}
            </span>
          </div>

          {failedJobs.length > 0 ? (
            <details className="rounded border border-fail bg-fail-soft px-3 py-2">
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
            <>
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
            </>
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

"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { ActionPlanTable } from "./ActionPlanTable";
import { Gauge, ScoreChip } from "./Gauge";
import { PageReport } from "./PageReport";
import {
  PAYLOAD_ENCODING_HEADER,
  gzipJson,
  toExportPayload,
} from "@/lib/export-payload";
import { formatPercent, shortUrl } from "@/lib/format";
import { buildActionPlan } from "@/lib/priority";
import { CATEGORY_IDS, CATEGORY_LABELS } from "@/lib/types";
import type { AnalyzeResponse, RunResult, Strategy } from "@/lib/types";

type JobStatus = "pending" | "running" | "done" | "error";

interface Job {
  key: string;
  url: string;
  strategy: Strategy;
  status: JobStatus;
  result?: RunResult;
  error?: string;
  attempts: number;
}

type View = "plan" | "overview" | "page";

const MAX_ATTEMPTS = 3;
const MAX_URLS = 50;

/** Accetta URL separati da a capo, virgola o spazio e normalizza il protocollo. */
function parseUrls(input: string): { urls: string[]; invalid: string[] } {
  const tokens = input
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const urls: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const candidate = /^https?:\/\//i.test(token) ? token : `https://${token}`;
    try {
      const parsed = new URL(candidate);
      if (!parsed.hostname.includes(".")) throw new Error("host incompleto");
      const normalized = parsed.toString();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        urls.push(normalized);
      }
    } catch {
      invalid.push(token);
    }
  }

  return { urls, invalid };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function Analyzer() {
  const [urlsText, setUrlsText] = useState("");
  const [sitemapInput, setSitemapInput] = useState("");
  const [sitemapBusy, setSitemapBusy] = useState(false);
  const [sitemapMessage, setSitemapMessage] = useState<string | null>(null);

  const [useMobile, setUseMobile] = useState(true);
  const [useDesktop, setUseDesktop] = useState(true);
  const [concurrency, setConcurrency] = useState(4);

  const [jobs, setJobs] = useState<Job[]>([]);
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<View>("plan");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const cancelled = useRef(false);

  const results = useMemo(
    () =>
      jobs
        .filter((job): job is Job & { result: RunResult } => Boolean(job.result))
        .map((job) => job.result),
    [jobs],
  );

  const plan = useMemo(() => buildActionPlan(results), [results]);

  const done = jobs.filter(
    (job) => job.status === "done" || job.status === "error",
  ).length;
  const failed = jobs.filter((job) => job.status === "error");

  const updateJob = useCallback((key: string, patch: Partial<Job>) => {
    setJobs((current) =>
      current.map((job) => (job.key === key ? { ...job, ...patch } : job)),
    );
  }, []);

  const importSitemap = useCallback(async () => {
    if (!sitemapInput.trim()) return;
    setSitemapBusy(true);
    setSitemapMessage(null);
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
        setSitemapMessage(data.error);
        return;
      }

      setUrlsText((current) => {
        const existing = current.trim();
        return existing
          ? `${existing}\n${data.urls.join("\n")}`
          : data.urls.join("\n");
      });
      setSitemapMessage(
        `${data.urls.length} URL importati da ${data.sitemap}${
          data.truncated ? " (elenco troncato)" : ""
        }. Tieni solo le pagine che ti servono.`,
      );
    } catch {
      setSitemapMessage("Impossibile leggere la sitemap.");
    } finally {
      setSitemapBusy(false);
    }
  }, [sitemapInput]);

  const analyze = useCallback(
    async (job: Job): Promise<RunResult> => {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: job.url, strategy: job.strategy }),
      });

      const data = (await response.json()) as AnalyzeResponse;
      if (data.ok) return data.result;

      const error = new Error(data.error) as Error & { retryable?: boolean };
      error.retryable = data.retryable;
      throw error;
    },
    [],
  );

  const start = useCallback(async () => {
    const { urls, invalid } = parseUrls(urlsText);

    if (urls.length === 0) {
      setFormError("Inserisci almeno un URL valido.");
      return;
    }
    if (invalid.length > 0) {
      setFormError(
        `Non riesco a interpretare: ${invalid.slice(0, 3).join(", ")}${
          invalid.length > 3 ? "…" : ""
        }`,
      );
      return;
    }
    if (urls.length > MAX_URLS) {
      setFormError(
        `Massimo ${MAX_URLS} pagine per analisi. Ne hai inserite ${urls.length}.`,
      );
      return;
    }

    const strategies: Strategy[] = [];
    if (useMobile) strategies.push("mobile");
    if (useDesktop) strategies.push("desktop");
    if (strategies.length === 0) {
      setFormError("Seleziona almeno un dispositivo.");
      return;
    }

    setFormError(null);
    cancelled.current = false;
    setSelectedKey(null);
    setView("plan");

    const queue: Job[] = urls.flatMap((url) =>
      strategies.map((strategy) => ({
        key: `${url}::${strategy}`,
        url,
        strategy,
        status: "pending" as JobStatus,
        attempts: 0,
      })),
    );

    setJobs(queue);
    setRunning(true);

    const pending = [...queue];

    const worker = async () => {
      while (pending.length > 0 && !cancelled.current) {
        const job = pending.shift();
        if (!job) break;

        updateJob(job.key, { status: "running" });

        let lastError = "Errore sconosciuto.";
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          if (cancelled.current) return;
          try {
            const result = await analyze(job);
            updateJob(job.key, { status: "done", result, attempts: attempt });
            lastError = "";
            break;
          } catch (error) {
            const retryable =
              error instanceof Error &&
              (error as Error & { retryable?: boolean }).retryable !== false;
            lastError =
              error instanceof Error ? error.message : "Errore sconosciuto.";

            if (!retryable || attempt === MAX_ATTEMPTS) {
              updateJob(job.key, {
                status: "error",
                error: lastError,
                attempts: attempt,
              });
              break;
            }
            // Backoff crescente: l'API PSI rifiuta le raffiche ravvicinate.
            await sleep(attempt * 2500);
          }
        }
      }
    };

    const workerCount = Math.max(1, Math.min(concurrency, pending.length));
    await Promise.all(Array.from({ length: workerCount }, worker));

    setRunning(false);
  }, [analyze, concurrency, updateJob, urlsText, useDesktop, useMobile]);

  const stop = useCallback(() => {
    cancelled.current = true;
    setRunning(false);
    setJobs((current) =>
      current.map((job) =>
        job.status === "pending" || job.status === "running"
          ? { ...job, status: "error", error: "Analisi interrotta." }
          : job,
      ),
    );
  }, []);

  const downloadExcel = useCallback(async () => {
    if (results.length === 0) return;
    setExporting(true);
    try {
      let site = "sito";
      try {
        site = new URL(results[0].requestedUrl).hostname;
      } catch {
        // manteniamo il nome di default
      }

      const payload = { runs: toExportPayload(results), site };
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
        setFormError("Generazione del file Excel non riuscita.");
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `lighthouse-${site}-${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setFormError("Generazione del file Excel non riuscita.");
    } finally {
      setExporting(false);
    }
  }, [results]);

  const selectedRun = results.find((run) => run.key === selectedKey) ?? null;
  const urlCount = parseUrls(urlsText).urls.length;
  const runCount = urlCount * ((useMobile ? 1 : 0) + (useDesktop ? 1 : 0));

  return (
    <div className="space-y-8">
      {/* ---------------------------------------------------------- Form */}
      <section className="rounded-lg border border-border p-5">
        <h2 className="text-sm text-ink-muted">Pagine da analizzare</h2>

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
            {sitemapBusy ? "Leggo la sitemap…" : "Importa da sitemap"}
          </button>
        </div>
        {sitemapMessage ? (
          <p className="mt-2 text-xs text-ink-muted">{sitemapMessage}</p>
        ) : null}

        <textarea
          value={urlsText}
          onChange={(event) => setUrlsText(event.target.value)}
          rows={8}
          spellCheck={false}
          placeholder={"https://esempio.it/\nhttps://esempio.it/prodotti\nhttps://esempio.it/contatti"}
          className="mt-3 w-full rounded border border-border px-3 py-2 font-mono text-xs outline-none focus:border-accent"
        />

        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={useMobile}
              onChange={(event) => setUseMobile(event.target.checked)}
            />
            Mobile
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={useDesktop}
              onChange={(event) => setUseDesktop(event.target.checked)}
            />
            Desktop
          </label>
          <label className="flex items-center gap-2 text-sm">
            Analisi in parallelo
            <select
              value={concurrency}
              onChange={(event) => setConcurrency(Number(event.target.value))}
              className="rounded border border-border px-2 py-1 text-sm"
            >
              {[1, 2, 3, 4, 5, 6].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <span className="text-xs text-ink-faint">
            {urlCount} pagine · {runCount} analisi
          </span>
        </div>

        {formError ? (
          <p className="mt-3 rounded border border-fail bg-fail-soft px-3 py-2 text-sm text-fail">
            {formError}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={start}
            disabled={running || urlCount === 0}
            className="rounded bg-accent px-5 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40"
          >
            {running ? "Analisi in corso…" : "Avvia analisi"}
          </button>
          {running ? (
            <button
              type="button"
              onClick={stop}
              className="rounded border border-border px-4 py-2 text-sm hover:bg-surface"
            >
              Interrompi
            </button>
          ) : null}
          {results.length > 0 ? (
            <button
              type="button"
              onClick={downloadExcel}
              disabled={exporting}
              className="rounded border border-accent px-4 py-2 text-sm text-accent hover:bg-accent-soft disabled:opacity-40"
            >
              {exporting ? "Preparo il file…" : "Scarica Excel"}
            </button>
          ) : null}
        </div>

        <p className="mt-3 text-xs text-ink-faint">
          Ogni analisi richiede 15-45 secondi. Lighthouse gira sui server di
          Google, non sul tuo browser: puoi lasciare la scheda aperta in
          background.
        </p>
      </section>

      {/* ------------------------------------------------------ Avanzamento */}
      {jobs.length > 0 ? (
        <section className="rounded-lg border border-border p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm text-ink-muted">Avanzamento</h2>
            <span className="text-xs tabular-nums text-ink-faint">
              {done} / {jobs.length}
            </span>
          </div>

          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-alt">
            <div
              className="h-full bg-accent transition-[width] duration-500"
              style={{ width: `${(done / jobs.length) * 100}%` }}
            />
          </div>

          <ul className="mt-4 grid gap-1.5 sm:grid-cols-2">
            {jobs.map((job) => (
              <li
                key={job.key}
                className="flex items-center gap-2 text-xs"
                title={job.error ?? job.url}
              >
                <span
                  className={`inline-block size-2 shrink-0 rounded-full ${
                    job.status === "done"
                      ? "bg-pass"
                      : job.status === "error"
                        ? "bg-fail"
                        : job.status === "running"
                          ? "bg-accent"
                          : "bg-border-strong"
                  }`}
                />
                <span className="truncate text-ink-muted">
                  {shortUrl(job.url, 42)}
                </span>
                <span className="shrink-0 text-ink-faint">
                  {job.strategy === "mobile" ? "mob" : "desk"}
                </span>
                {job.status === "running" ? (
                  <span className="shrink-0 text-accent">in corso</span>
                ) : null}
              </li>
            ))}
          </ul>

          {failed.length > 0 ? (
            <details className="mt-4 rounded border border-fail bg-fail-soft px-3 py-2">
              <summary className="cursor-pointer text-xs text-fail">
                {failed.length} analisi non riuscite
              </summary>
              <ul className="mt-2 space-y-1">
                {failed.map((job) => (
                  <li key={job.key} className="text-xs text-ink-muted">
                    <span className="text-ink">{shortUrl(job.url, 50)}</span> (
                    {job.strategy}): {job.error}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      {/* --------------------------------------------------------- Risultati */}
      {results.length > 0 ? (
        <section>
          <div className="mb-4 flex flex-wrap gap-2 border-b border-border">
            {(
              [
                ["plan", `Piano d'azione (${plan.items.length})`],
                ["overview", `Riepilogo (${results.length})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setView(key);
                  setSelectedKey(null);
                }}
                className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                  view === key
                    ? "border-accent text-accent"
                    : "border-transparent text-ink-muted hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
            {selectedRun ? (
              <button
                type="button"
                className="-mb-px border-b-2 border-accent px-3 py-2 text-sm text-accent"
              >
                {shortUrl(selectedRun.requestedUrl, 32)} ·{" "}
                {selectedRun.strategy === "mobile" ? "mobile" : "desktop"}
              </button>
            ) : null}
          </div>

          {view === "plan" && !selectedRun ? (
            <div className="space-y-4">
              <p className="text-sm text-ink-muted">
                {plan.items.length} interventi ordinati per impatto su{" "}
                {plan.totalPages} pagine. Clicca una riga per vedere cosa fare e
                dove.
              </p>
              <ActionPlanTable items={plan.items} />
            </div>
          ) : null}

          {view === "overview" && !selectedRun ? (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[48rem] text-left">
                <thead className="bg-surface-alt text-xs text-ink-muted">
                  <tr>
                    <th className="px-3 py-2">Pagina</th>
                    <th className="px-3 py-2">Dispositivo</th>
                    {CATEGORY_IDS.map((category) => (
                      <th key={category} className="px-3 py-2 text-center">
                        {CATEGORY_LABELS[category]}
                      </th>
                    ))}
                    <th className="px-3 py-2">LCP</th>
                    <th className="px-3 py-2">TBT</th>
                    <th className="px-3 py-2">CLS</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {results.map((run) => {
                    const metric = (id: string) =>
                      run.metrics.find((m) => m.id === id)?.displayValue ?? "—";
                    return (
                      <tr key={run.key} className="border-t border-border">
                        <td className="max-w-xs truncate px-3 py-2 text-sm">
                          {shortUrl(run.requestedUrl, 44)}
                        </td>
                        <td className="px-3 py-2 text-xs text-ink-muted">
                          {run.strategy === "mobile" ? "Mobile" : "Desktop"}
                        </td>
                        {CATEGORY_IDS.map((category) => (
                          <td key={category} className="px-3 py-2 text-center">
                            <ScoreChip
                              score={run.categories[category]?.score ?? null}
                              title={CATEGORY_LABELS[category]}
                            />
                          </td>
                        ))}
                        <td className="px-3 py-2 text-sm tabular-nums">
                          {metric("largest-contentful-paint")}
                        </td>
                        <td className="px-3 py-2 text-sm tabular-nums">
                          {metric("total-blocking-time")}
                        </td>
                        <td className="px-3 py-2 text-sm tabular-nums">
                          {metric("cumulative-layout-shift")}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedKey(run.key);
                              setView("page");
                            }}
                            className="text-xs text-accent underline underline-offset-2"
                          >
                            Report
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {selectedRun ? (
            <div className="space-y-4">
              <button
                type="button"
                onClick={() => {
                  setSelectedKey(null);
                  setView("overview");
                }}
                className="text-sm text-accent underline underline-offset-2"
              >
                ← Torna al riepilogo
              </button>
              <PageReport run={selectedRun} />
            </div>
          ) : null}
        </section>
      ) : null}

      {/* -------------------------------------------- Medie di tutto il set */}
      {results.length > 1 && !selectedRun ? (
        <section className="rounded-lg border border-border p-5">
          <h2 className="mb-4 text-sm text-ink-muted">
            Punteggi medi sulle {plan.totalPages} pagine analizzate
          </h2>
          <div className="flex flex-wrap gap-6">
            {CATEGORY_IDS.map((category) => {
              const scores = results
                .map((run) => run.categories[category]?.score)
                .filter((score): score is number => typeof score === "number");
              const average =
                scores.length > 0
                  ? scores.reduce((sum, score) => sum + score, 0) /
                    scores.length
                  : null;
              return (
                <Gauge
                  key={category}
                  score={average}
                  label={CATEGORY_LABELS[category]}
                  size="lg"
                />
              );
            })}
          </div>
          <p className="mt-4 text-xs text-ink-faint">
            Copertura del piano: gli interventi in fascia Critica toccano in
            media il{" "}
            {plan.items.filter((item) => item.priorityBand === "Critica")
              .length > 0
              ? formatPercent(
                  plan.items
                    .filter((item) => item.priorityBand === "Critica")
                    .reduce((sum, item) => sum + item.coverage, 0) /
                    plan.items.filter((item) => item.priorityBand === "Critica")
                      .length,
                )
              : "0%"}{" "}
            delle pagine.
          </p>
        </section>
      ) : null}
    </div>
  );
}

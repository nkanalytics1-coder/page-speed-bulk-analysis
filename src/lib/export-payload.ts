import type { RunResult } from "./types";

/**
 * Alleggerisce i risultati prima di inviarli all'endpoint di export.
 *
 * Vercel limita il corpo di una richiesta a 4,5 MB. Gli screenshot pesano
 * decine di KB ciascuno e gli audit superati non finiscono in nessun foglio,
 * quindi vengono rimossi qui invece che sul server.
 */
export function toExportPayload(runs: RunResult[]): RunResult[] {
  return runs.map((run) => ({
    ...run,
    screenshot: null,
    audits: run.audits.filter((audit) => audit.isFailing),
  }));
}

/** Converte i link markdown di Lighthouse in testo semplice. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Estrae il primo link di approfondimento citato nella descrizione. */
export function learnMoreUrl(text: string): string | null {
  const match = /\[[^\]]+\]\((https?:\/\/[^)]+)\)/.exec(text);
  return match ? match[1] : null;
}

/** Header che segnala al server un corpo compresso. */
export const PAYLOAD_ENCODING_HEADER = "x-payload-encoding";

/**
 * Comprime il corpo prima dell'invio.
 *
 * Su 50 pagine × 2 strategie il JSON supera i 4,5 MB accettati da Vercel, ma è
 * fatto in larga parte di descrizioni e tabelle identiche ripetute su ogni
 * pagina: gzip lo riduce di un ordine di grandezza. Se `CompressionStream` non
 * è disponibile restituiamo null e il chiamante invia JSON in chiaro.
 */
export async function gzipJson(value: unknown): Promise<Blob | null> {
  if (typeof CompressionStream === "undefined") return null;
  const json = JSON.stringify(value);
  const stream = new Blob([json])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).blob();
}

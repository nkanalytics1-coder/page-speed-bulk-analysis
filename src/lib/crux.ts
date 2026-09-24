/**
 * Client dell'API Chrome UX Report.
 *
 * Restituisce i dati di campo (esperienza reale degli utenti Chrome negli
 * ultimi 28 giorni) in meno di un secondo, perché non esegue nessuna
 * simulazione. È l'opposto di Lighthouse: niente diagnosi, ma i numeri su cui
 * Google valuta davvero il sito, e abbastanza veloce da interrogare centinaia
 * di URL.
 */

export const CRUX_ENDPOINT =
  "https://chromeuxreport.googleapis.com/v1/records:queryRecord";

export type FormFactor = "PHONE" | "DESKTOP";

/** Ambito del dato: la singola pagina, o l'intero sito come ripiego. */
export type CruxScope = "url" | "origin";

export type CruxRating = "good" | "needs-improvement" | "poor";

export const CORE_WEB_VITALS = [
  "largest_contentful_paint",
  "interaction_to_next_paint",
  "cumulative_layout_shift",
] as const;

export type CoreWebVital = (typeof CORE_WEB_VITALS)[number];

export type CruxMetricId =
  | CoreWebVital
  | "first_contentful_paint"
  | "experimental_time_to_first_byte"
  | "round_trip_time";

/** Le quattro fasi in cui CrUX scompone l'LCP quando è un'immagine. */
export type LcpPhaseId =
  | "largest_contentful_paint_image_time_to_first_byte"
  | "largest_contentful_paint_image_resource_load_delay"
  | "largest_contentful_paint_image_resource_load_duration"
  | "largest_contentful_paint_image_element_render_delay";

interface Threshold {
  good: number;
  poor: number;
  unit: "ms" | "unitless";
}

/** Soglie ufficiali dei Core Web Vitals, valutate al 75° percentile. */
export const THRESHOLDS: Record<CruxMetricId, Threshold> = {
  largest_contentful_paint: { good: 2500, poor: 4000, unit: "ms" },
  interaction_to_next_paint: { good: 200, poor: 500, unit: "ms" },
  cumulative_layout_shift: { good: 0.1, poor: 0.25, unit: "unitless" },
  first_contentful_paint: { good: 1800, poor: 3000, unit: "ms" },
  experimental_time_to_first_byte: { good: 800, poor: 1800, unit: "ms" },
  round_trip_time: { good: 75, poor: 275, unit: "ms" },
};

export const METRIC_LABELS: Record<CruxMetricId, string> = {
  largest_contentful_paint: "LCP",
  interaction_to_next_paint: "INP",
  cumulative_layout_shift: "CLS",
  first_contentful_paint: "FCP",
  experimental_time_to_first_byte: "TTFB",
  round_trip_time: "RTT",
};

export const METRIC_FULL_LABELS: Record<CruxMetricId, string> = {
  largest_contentful_paint: "Largest Contentful Paint",
  interaction_to_next_paint: "Interaction to Next Paint",
  cumulative_layout_shift: "Cumulative Layout Shift",
  first_contentful_paint: "First Contentful Paint",
  experimental_time_to_first_byte: "Time to First Byte",
  round_trip_time: "Round Trip Time",
};

export const LCP_PHASE_LABELS: Record<LcpPhaseId, string> = {
  largest_contentful_paint_image_time_to_first_byte: "Risposta del server",
  largest_contentful_paint_image_resource_load_delay: "Ritardo di caricamento",
  largest_contentful_paint_image_resource_load_duration: "Durata caricamento",
  largest_contentful_paint_image_element_render_delay: "Ritardo di rendering",
};

/** Dove intervenire, a seconda della fase che domina l'LCP. */
export const LCP_PHASE_HINTS: Record<LcpPhaseId, string> = {
  largest_contentful_paint_image_time_to_first_byte:
    "Il server è lento a rispondere: agisci su hosting, cache lato server o CDN.",
  largest_contentful_paint_image_resource_load_delay:
    "Il browser scopre l'immagine tardi: precaricala e togli di mezzo ciò che la ritarda (lazy-load errato, immagine impostata via CSS o JavaScript).",
  largest_contentful_paint_image_resource_load_duration:
    "L'immagine è pesante da scaricare: comprimila, usa formati moderni e servi dimensioni adeguate.",
  largest_contentful_paint_image_element_render_delay:
    "Il rendering è bloccato: riduci JavaScript e CSS che bloccano la pagina.",
};

/* ------------------------------------------------------------------ *
 * Tipi normalizzati
 * ------------------------------------------------------------------ */

export interface CruxBin {
  start: number;
  end: number | null;
  density: number;
}

export interface CruxMetric {
  id: CruxMetricId;
  p75: number;
  rating: CruxRating;
  histogram: CruxBin[];
}

export interface LcpPhase {
  id: LcpPhaseId;
  label: string;
  p75: number;
  /** Quota dell'LCP totale attribuibile a questa fase (0-1). */
  share: number;
}

export interface CruxResult {
  /** L'URL richiesto, sempre quello originale. */
  requestedUrl: string;
  formFactor: FormFactor;
  /** "origin" quando la pagina non ha dati e si ripiega sull'intero sito. */
  scope: CruxScope;
  metrics: Partial<Record<CruxMetricId, CruxMetric>>;
  lcpPhases: LcpPhase[];
  /** Quota di LCP per tipo di risorsa, es. { image: 0.96, text: 0.04 }. */
  lcpResourceType: Record<string, number> | null;
  collectionPeriod: { first: string; last: string } | null;
  /** null quando manca il dato per una delle tre metriche core. */
  passesCwv: boolean | null;
  /** Core Web Vitals privi di dati per questo ambito. */
  missingCwv: CoreWebVital[];
}

export interface CruxMiss {
  requestedUrl: string;
  formFactor: FormFactor;
  /** true quando CrUX non ha dati né per la pagina né per l'origin. */
  noData: boolean;
  message: string;
}

export type CruxOutcome =
  | { ok: true; result: CruxResult }
  | { ok: false; miss: CruxMiss };

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/** CrUX restituisce i valori di CLS come stringhe ("0.00"), il resto come numeri. */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function ratingFor(id: CruxMetricId, value: number): CruxRating {
  const threshold = THRESHOLDS[id];
  if (value <= threshold.good) return "good";
  if (value <= threshold.poor) return "needs-improvement";
  return "poor";
}

interface RawMetric {
  histogram?: { start?: unknown; end?: unknown; density?: unknown }[];
  percentiles?: { p75?: unknown };
  fractions?: Record<string, unknown>;
}

interface RawRecord {
  record?: {
    key?: { url?: string; origin?: string; formFactor?: string };
    metrics?: Record<string, RawMetric>;
    collectionPeriod?: {
      firstDate?: { year?: number; month?: number; day?: number };
      lastDate?: { year?: number; month?: number; day?: number };
    };
  };
}

function formatDate(date?: { year?: number; month?: number; day?: number }) {
  if (!date?.year || !date.month || !date.day) return null;
  return `${String(date.day).padStart(2, "0")}/${String(date.month).padStart(2, "0")}/${date.year}`;
}

const ALL_METRIC_IDS: CruxMetricId[] = [
  "largest_contentful_paint",
  "interaction_to_next_paint",
  "cumulative_layout_shift",
  "first_contentful_paint",
  "experimental_time_to_first_byte",
  "round_trip_time",
];

const LCP_PHASE_IDS: LcpPhaseId[] = [
  "largest_contentful_paint_image_time_to_first_byte",
  "largest_contentful_paint_image_resource_load_delay",
  "largest_contentful_paint_image_resource_load_duration",
  "largest_contentful_paint_image_element_render_delay",
];

export function normalizeCrux(
  raw: RawRecord,
  requestedUrl: string,
  formFactor: FormFactor,
  scope: CruxScope,
): CruxResult {
  const rawMetrics = raw.record?.metrics ?? {};
  const metrics: CruxResult["metrics"] = {};

  for (const id of ALL_METRIC_IDS) {
    const metric = rawMetrics[id];
    const p75 = toNumber(metric?.percentiles?.p75);
    if (p75 == null) continue;

    metrics[id] = {
      id,
      p75,
      rating: ratingFor(id, p75),
      histogram: (metric?.histogram ?? []).map((bin) => ({
        start: toNumber(bin.start) ?? 0,
        end: toNumber(bin.end),
        density: toNumber(bin.density) ?? 0,
      })),
    };
  }

  // Le fasi dell'LCP arrivano solo con i percentili, senza istogramma.
  const phaseValues = LCP_PHASE_IDS.map((id) => ({
    id,
    p75: toNumber(rawMetrics[id]?.percentiles?.p75),
  })).filter((phase): phase is { id: LcpPhaseId; p75: number } => phase.p75 != null);

  const phaseTotal = phaseValues.reduce((sum, phase) => sum + phase.p75, 0);
  const lcpPhases: LcpPhase[] = phaseValues.map((phase) => ({
    id: phase.id,
    label: LCP_PHASE_LABELS[phase.id],
    p75: phase.p75,
    share: phaseTotal > 0 ? phase.p75 / phaseTotal : 0,
  }));

  const resourceFractions = rawMetrics["largest_contentful_paint_resource_type"]?.fractions;
  let lcpResourceType: Record<string, number> | null = null;
  if (resourceFractions) {
    lcpResourceType = {};
    for (const [key, value] of Object.entries(resourceFractions)) {
      const parsed = toNumber(value);
      if (parsed != null) lcpResourceType[key] = parsed;
    }
  }

  const missingCwv = CORE_WEB_VITALS.filter((id) => !metrics[id]);
  // Google considera superati i CWV solo se tutte e tre le metriche sono
  // "good". Se una manca del tutto, il verdetto non è esprimibile.
  const passesCwv =
    missingCwv.length > 0
      ? null
      : CORE_WEB_VITALS.every((id) => metrics[id]?.rating === "good");

  const period = raw.record?.collectionPeriod;

  return {
    requestedUrl,
    formFactor,
    scope,
    metrics,
    lcpPhases,
    lcpResourceType,
    collectionPeriod: period
      ? {
          first: formatDate(period.firstDate) ?? "",
          last: formatDate(period.lastDate) ?? "",
        }
      : null,
    passesCwv,
    missingCwv,
  };
}

/* ------------------------------------------------------------------ *
 * Fetch
 * ------------------------------------------------------------------ */

export function originOf(url: string): string {
  return new URL(url).origin;
}

async function queryOnce(
  body: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${CRUX_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

/**
 * Interroga CrUX per una pagina, ripiegando sull'intero sito quando la pagina
 * non ha traffico sufficiente. È il caso normale per i competitor: le loro
 * pagine interne quasi mai hanno dati a livello di URL.
 */
export async function queryCrux(
  requestedUrl: string,
  formFactor: FormFactor,
  apiKey: string,
  options: { allowOriginFallback?: boolean; signal?: AbortSignal } = {},
): Promise<CruxOutcome> {
  const { allowOriginFallback = true, signal } = options;

  try {
    const byUrl = await queryOnce(
      { url: requestedUrl, formFactor },
      apiKey,
      signal,
    );

    if (byUrl.status === 200) {
      return {
        ok: true,
        result: normalizeCrux(byUrl.json as RawRecord, requestedUrl, formFactor, "url"),
      };
    }

    // 404 = nessun dato per questa pagina. Qualsiasi altro codice è un errore
    // vero (chiave, quota, servizio) e non va mascherato da "nessun dato".
    if (byUrl.status !== 404) {
      const message =
        (byUrl.json as { error?: { message?: string } } | null)?.error?.message ??
        `Errore CrUX ${byUrl.status}`;
      return {
        ok: false,
        miss: { requestedUrl, formFactor, noData: false, message },
      };
    }

    if (!allowOriginFallback) {
      return {
        ok: false,
        miss: {
          requestedUrl,
          formFactor,
          noData: true,
          message: "Nessun dato di campo per questa pagina.",
        },
      };
    }

    const byOrigin = await queryOnce(
      { origin: originOf(requestedUrl), formFactor },
      apiKey,
      signal,
    );

    if (byOrigin.status === 200) {
      return {
        ok: true,
        result: normalizeCrux(
          byOrigin.json as RawRecord,
          requestedUrl,
          formFactor,
          "origin",
        ),
      };
    }

    return {
      ok: false,
      miss: {
        requestedUrl,
        formFactor,
        noData: byOrigin.status === 404,
        message:
          byOrigin.status === 404
            ? "Nessun dato di campo, né per la pagina né per il sito."
            : ((byOrigin.json as { error?: { message?: string } } | null)?.error
                ?.message ?? `Errore CrUX ${byOrigin.status}`),
      },
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      miss: {
        requestedUrl,
        formFactor,
        noData: false,
        message: aborted
          ? "Timeout nella richiesta CrUX."
          : "Impossibile contattare l'API CrUX.",
      },
    };
  }
}

/* ------------------------------------------------------------------ *
 * Formattazione
 * ------------------------------------------------------------------ */

export function formatMetric(id: CruxMetricId, value: number): string {
  if (THRESHOLDS[id].unit === "unitless") {
    return value.toLocaleString("it-IT", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toLocaleString("it-IT", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} s`;
}

export const RATING_LABELS: Record<CruxRating, string> = {
  good: "Buono",
  "needs-improvement": "Da migliorare",
  poor: "Scarso",
};

export const RATING_COLORS: Record<CruxRating, string> = {
  good: "#0cce6b",
  "needs-improvement": "#ffa400",
  poor: "#ff4e42",
};

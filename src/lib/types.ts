export type Strategy = "mobile" | "desktop";

export type CategoryId =
  | "performance"
  | "accessibility"
  | "best-practices"
  | "seo";

export const CATEGORY_IDS: CategoryId[] = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
];

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  performance: "Prestazioni",
  accessibility: "Accessibilità",
  "best-practices": "Best Practices",
  seo: "SEO",
};

/** Le 5 metriche che compongono il punteggio Performance, più TTI (informativa). */
export type MetricId =
  | "first-contentful-paint"
  | "speed-index"
  | "largest-contentful-paint"
  | "total-blocking-time"
  | "cumulative-layout-shift"
  | "interactive";

export interface CategoryScore {
  id: CategoryId;
  title: string;
  /** 0-1, oppure null se la categoria non è stata calcolata. */
  score: number | null;
}

export interface MetricResult {
  id: string;
  title: string;
  /** Valore già formattato da Lighthouse, es. "2,4 s". */
  displayValue: string | null;
  numericValue: number | null;
  numericUnit: string | null;
  score: number | null;
}

/** Una riga della tabella di dettaglio di un audit. */
export type AuditTableItem = Record<string, unknown>;

export interface AuditTableHeading {
  key: string | null;
  label: string;
  valueType: string;
}

export interface AuditTable {
  type: "table" | "opportunity" | "list" | "criticalrequestchain";
  headings: AuditTableHeading[];
  items: AuditTableItem[];
  /** Numero totale di righe prima del troncamento. */
  totalItems: number;
}

/** Risparmi stimati per metrica, in ms (CLS è adimensionale). */
export type MetricSavings = Partial<
  Record<"LCP" | "FCP" | "TBT" | "CLS" | "INP", number>
>;

/**
 * Appartenenza di un audit a una categoria. Lighthouse referenzia lo stesso
 * audit da più categorie (`image-alt` sta in Accessibilità e in SEO) con peso
 * e gruppo diversi, e lo mostra in entrambe le schede del report.
 */
export interface AuditMembership {
  category: CategoryId;
  /** Peso grezzo dentro quella categoria. */
  weight: number;
  /** Peso normalizzato sul totale dei pesi della categoria (0-1). */
  weightPct: number;
  /** Gruppo Lighthouse, es. "metrics", "diagnostics", "a11y-names-labels". */
  group: string | null;
}

export interface NormalizedAudit {
  id: string;
  title: string;
  description: string;
  /** 0-1, null per audit informativi / non applicabili / manuali. */
  score: number | null;
  scoreDisplayMode: string;
  displayValue: string | null;
  numericValue: number | null;
  numericUnit: string | null;
  /** Tutte le categorie in cui Lighthouse mostra questo audit. */
  memberships: AuditMembership[];
  /** Categoria di riferimento: quella in cui l'audit pesa di più. */
  category: CategoryId;
  /** Gruppo nella categoria di riferimento. */
  group: string | null;
  /** Peso grezzo nella categoria di riferimento. */
  weight: number;
  /** Peso normalizzato nella categoria di riferimento (0-1). */
  weightPct: number;
  savingsMs: number | null;
  savingsBytes: number | null;
  metricSavings: MetricSavings | null;
  /** true se Lighthouse la classifica come "opportunità" (details.type === "opportunity"). */
  isOpportunity: boolean;
  /** true se l'audit è da correggere: score < 0.9 e modalità numeric/binary. */
  isFailing: boolean;
  table: AuditTable | null;
  /** Testo esplicativo aggiuntivo emesso da Lighthouse per questo run. */
  warnings: string[];
}

export interface FieldMetric {
  id: string;
  label: string;
  percentile: number;
  category: "FAST" | "AVERAGE" | "SLOW";
  distributions: { min: number; max: number | null; proportion: number }[];
}

export interface FieldData {
  overallCategory: "FAST" | "AVERAGE" | "SLOW" | null;
  metrics: FieldMetric[];
}

export interface RunResult {
  /** Chiave univoca: `${url}::${strategy}`. */
  key: string;
  requestedUrl: string;
  finalUrl: string;
  strategy: Strategy;
  fetchTime: string;
  lighthouseVersion: string;
  /** Screenshot finale come data URI. Rimosso prima dell'export Excel. */
  screenshot: string | null;
  categories: Partial<Record<CategoryId, CategoryScore>>;
  metrics: MetricResult[];
  audits: NormalizedAudit[];
  /** Dati di campo CrUX per questa specifica pagina, se disponibili. */
  field: FieldData | null;
  /** Dati di campo CrUX aggregati sull'intera origin. */
  fieldOrigin: FieldData | null;
  runWarnings: string[];
  /** Titoli dei gruppi Lighthouse, per ricostruire le sezioni del report. */
  groupTitles: Record<string, string>;
}

export interface RunError {
  key: string;
  requestedUrl: string;
  strategy: Strategy;
  message: string;
  /** Codice HTTP restituito dall'API PSI, se presente. */
  status: number | null;
}

/** Una voce aggregata del piano d'azione. */
export interface ActionItem {
  auditId: string;
  title: string;
  description: string;
  category: CategoryId;
  /** Numero di run (pagina × strategia) in cui l'audit fallisce. */
  occurrences: number;
  /** Numero di URL distinti coinvolti. */
  pagesAffected: number;
  affectedUrls: string[];
  strategies: Strategy[];
  avgScore: number | null;
  /** Punti di categoria recuperabili, media sulle run in cui fallisce. */
  avgPointsRecoverable: number;
  /** Somma dei punti recuperabili su tutte le run. */
  totalPointsRecoverable: number;
  totalSavingsMs: number;
  totalSavingsBytes: number;
  /** Frazione di pagine analizzate coinvolte (0-1). */
  coverage: number;
  /** Punteggio finale di priorità (0-100 circa). */
  priorityScore: number;
  priorityBand: "Critica" | "Alta" | "Media" | "Bassa";
  /** true quando l'impatto sul punteggio non è quantificabile (pura diagnostica). */
  impactEstimated: boolean;
}

/** Appartenenza di un audit a una specifica categoria, se esiste. */
export function membershipIn(
  audit: NormalizedAudit,
  category: CategoryId,
): AuditMembership | null {
  return (
    audit.memberships.find((member) => member.category === category) ?? null
  );
}

export interface AnalyzeRequest {
  url: string;
  strategy: Strategy;
  locale?: string;
}

export type AnalyzeResponse =
  | { ok: true; result: RunResult }
  | { ok: false; error: string; status: number | null; retryable: boolean };

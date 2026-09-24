import { PASS_THRESHOLD } from "./lighthouse-scoring";
import { CATEGORY_IDS } from "./types";
import type {
  AuditMembership,
  AuditTable,
  AuditTableHeading,
  AuditTableItem,
  FieldData,
  FieldMetric,
  MetricResult,
  MetricSavings,
  NormalizedAudit,
  RunResult,
  Strategy,
} from "./types";

export const PSI_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

/** Righe di dettaglio conservate per audit: tiene il payload gestibile. */
const MAX_TABLE_ITEMS = 10;

/** Lunghezza massima di una stringa dentro una riga di dettaglio. */
const MAX_STRING_LENGTH = 300;

/** Gli id delle metriche mostrate nella sezione "Metriche" del report. */
const METRIC_AUDIT_IDS = [
  "first-contentful-paint",
  "largest-contentful-paint",
  "total-blocking-time",
  "cumulative-layout-shift",
  "speed-index",
  "interactive",
];

const FIELD_METRIC_LABELS: Record<string, string> = {
  LARGEST_CONTENTFUL_PAINT_MS: "Largest Contentful Paint",
  FIRST_CONTENTFUL_PAINT_MS: "First Contentful Paint",
  CUMULATIVE_LAYOUT_SHIFT_SCORE: "Cumulative Layout Shift",
  INTERACTION_TO_NEXT_PAINT: "Interaction to Next Paint",
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: "Time to First Byte",
  EXPERIMENTAL_INTERACTION_TO_NEXT_PAINT: "Interaction to Next Paint",
};

/* ------------------------------------------------------------------ *
 * Tipi minimi della risposta PSI. Non tipizziamo l'intero schema:
 * ci interessano solo i campi che leggiamo davvero.
 * ------------------------------------------------------------------ */

interface PsiAuditRef {
  id: string;
  weight: number;
  group?: string;
  acronym?: string;
}

interface PsiCategory {
  id?: string;
  title?: string;
  score?: number | null;
  auditRefs?: PsiAuditRef[];
}

interface PsiAudit {
  id?: string;
  title?: string;
  description?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  displayValue?: string;
  numericValue?: number;
  numericUnit?: string;
  warnings?: unknown;
  metricSavings?: Record<string, number>;
  details?: {
    type?: string;
    headings?: { key?: string | null; label?: unknown; valueType?: string }[];
    items?: Record<string, unknown>[];
    overallSavingsMs?: number;
    overallSavingsBytes?: number;
    data?: string;
  };
}

interface PsiLoadingExperience {
  overall_category?: string;
  metrics?: Record<
    string,
    {
      percentile?: number;
      category?: string;
      distributions?: { min?: number; max?: number; proportion?: number }[];
    }
  >;
}

export interface PsiResponse {
  id?: string;
  loadingExperience?: PsiLoadingExperience;
  originLoadingExperience?: PsiLoadingExperience;
  analysisUTCTimestamp?: string;
  lighthouseResult?: {
    requestedUrl?: string;
    finalUrl?: string;
    finalDisplayedUrl?: string;
    fetchTime?: string;
    lighthouseVersion?: string;
    runWarnings?: unknown[];
    audits?: Record<string, PsiAudit>;
    categories?: Record<string, PsiCategory>;
    categoryGroups?: Record<string, { title?: string; description?: string }>;
  };
}

/* ------------------------------------------------------------------ *
 * Fetch
 * ------------------------------------------------------------------ */

export function buildPsiUrl(
  url: string,
  strategy: Strategy,
  locale: string,
  apiKey: string | undefined,
): string {
  const params = new URLSearchParams();
  params.set("url", url);
  params.set("strategy", strategy);
  params.set("locale", locale);
  for (const category of CATEGORY_IDS) {
    params.append("category", category.toUpperCase().replace(/-/g, "_"));
  }
  if (apiKey) params.set("key", apiKey);
  return `${PSI_ENDPOINT}?${params.toString()}`;
}

export class PsiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PsiError";
  }
}

export async function fetchPsi(
  url: string,
  strategy: Strategy,
  locale: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<PsiResponse> {
  let response: Response;
  try {
    response = await fetch(buildPsiUrl(url, strategy, locale, apiKey), {
      signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Timeout: l'analisi ha superato il tempo massimo."
        : "Impossibile contattare l'API PageSpeed Insights.";
    throw new PsiError(message, null, true);
  }

  if (!response.ok) {
    const body = await response.text();
    let detail = body.slice(0, 400);
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      // il corpo non è JSON: teniamo il testo grezzo troncato
    }
    // 429 = quota, 500/503 = instabilità lato Google: entrambi hanno senso da riprovare.
    const retryable = response.status === 429 || response.status >= 500;
    throw new PsiError(detail, response.status, retryable);
  }

  return (await response.json()) as PsiResponse;
}

/* ------------------------------------------------------------------ *
 * Normalizzazione
 * ------------------------------------------------------------------ */

function truncate(value: string): string {
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}…`
    : value;
}

/** Riduce un valore di dettaglio a qualcosa di serializzabile e compatto. */
function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value == null) return null;
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 2) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 3).map((entry) => sanitizeValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      // `subItems` e `path` gonfiano il payload senza aggiungere leggibilità.
      if (key === "subItems" || key === "path" || key === "boundingRect") {
        continue;
      }
      const clean = sanitizeValue(entry, depth + 1);
      if (clean !== null) out[key] = clean;
    }
    return out;
  }
  return null;
}

type RawHeading = { key?: string | null; label?: unknown; valueType?: string };

function normalizeHeadings(
  headings: RawHeading[] | undefined,
): AuditTableHeading[] {
  if (!Array.isArray(headings)) return [];
  return headings.map((heading) => ({
    key: heading.key ?? null,
    label:
      typeof heading.label === "string"
        ? heading.label
        : typeof heading.label === "object" && heading.label !== null
          ? String(
              (heading.label as { formattedDefault?: string })
                .formattedDefault ?? "",
            )
          : "",
    valueType: heading.valueType ?? "text",
  }));
}

function normalizeTable(audit: PsiAudit): AuditTable | null {
  const details = audit.details;
  if (!details) return null;
  const type = details.type;
  if (type !== "table" && type !== "opportunity" && type !== "list") return null;
  if (!Array.isArray(details.items) || details.items.length === 0) return null;

  const headings = normalizeHeadings(details.headings);
  if (headings.length === 0) return null;

  const keys = headings.map((heading) => heading.key).filter(Boolean) as string[];
  const items: AuditTableItem[] = details.items
    .slice(0, MAX_TABLE_ITEMS)
    .map((item) => {
      const row: AuditTableItem = {};
      for (const key of keys) {
        const clean = sanitizeValue(item[key]);
        if (clean !== null) row[key] = clean;
      }
      return row;
    });

  return {
    type: type as AuditTable["type"],
    headings,
    items,
    totalItems: details.items.length,
  };
}

function normalizeMetricSavings(
  raw: Record<string, number> | undefined,
): MetricSavings | null {
  if (!raw) return null;
  const out: MetricSavings = {};
  let hasValue = false;
  for (const key of ["LCP", "FCP", "TBT", "CLS", "INP"] as const) {
    const value = raw[key];
    if (typeof value === "number" && value > 0) {
      out[key] = value;
      hasValue = true;
    }
  }
  return hasValue ? out : null;
}

function normalizeField(
  experience: PsiLoadingExperience | undefined,
): FieldData | null {
  if (!experience?.metrics) return null;
  const metrics: FieldMetric[] = [];

  for (const [id, metric] of Object.entries(experience.metrics)) {
    if (typeof metric.percentile !== "number") continue;
    metrics.push({
      id,
      label: FIELD_METRIC_LABELS[id] ?? id,
      percentile: metric.percentile,
      category: (metric.category as FieldMetric["category"]) ?? "AVERAGE",
      distributions: (metric.distributions ?? []).map((distribution) => ({
        min: distribution.min ?? 0,
        max: distribution.max ?? null,
        proportion: distribution.proportion ?? 0,
      })),
    });
  }

  if (metrics.length === 0) return null;
  return {
    overallCategory:
      (experience.overall_category as FieldData["overallCategory"]) ?? null,
    metrics,
  };
}

/**
 * Un audit può comparire negli `auditRefs` di più categorie, con peso e gruppo
 * diversi: `image-alt`, per esempio, sta sia in Accessibilità sia in SEO e il
 * report ufficiale lo mostra in entrambe. Raccogliamo tutte le appartenenze.
 */
function buildAuditRefIndex(
  categories: Record<string, PsiCategory> | undefined,
): Map<string, AuditMembership[]> {
  const index = new Map<string, AuditMembership[]>();
  if (!categories) return index;

  for (const categoryId of CATEGORY_IDS) {
    const category = categories[categoryId];
    if (!category?.auditRefs) continue;

    const totalWeight = category.auditRefs.reduce(
      (sum, ref) => sum + (ref.weight || 0),
      0,
    );

    for (const ref of category.auditRefs) {
      const weight = ref.weight || 0;
      const membership: AuditMembership = {
        category: categoryId,
        weight,
        weightPct: totalWeight > 0 ? weight / totalWeight : 0,
        group: ref.group ?? null,
      };
      const existing = index.get(ref.id);
      if (existing) existing.push(membership);
      else index.set(ref.id, [membership]);
    }
  }

  return index;
}

/**
 * Categoria di riferimento per il piano d'azione: quella in cui l'audit pesa
 * di più, perché è lì che sistemarlo produce il guadagno maggiore.
 */
function primaryMembership(memberships: AuditMembership[]): AuditMembership {
  return memberships.reduce((best, current) =>
    current.weightPct > best.weightPct ? current : best,
  );
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map(truncate);
}

export function normalizeRun(
  response: PsiResponse,
  requestedUrl: string,
  strategy: Strategy,
): RunResult {
  const lhr = response.lighthouseResult;
  if (!lhr?.audits || !lhr.categories) {
    throw new PsiError(
      "Risposta PageSpeed Insights priva del report Lighthouse.",
      null,
      true,
    );
  }

  const refIndex = buildAuditRefIndex(lhr.categories);
  const audits: NormalizedAudit[] = [];

  for (const [auditId, audit] of Object.entries(lhr.audits)) {
    const memberships = refIndex.get(auditId);
    // Audit non referenziato da nessuna categoria (es. gli artefatti interni):
    // non compare nel report Lighthouse, quindi lo saltiamo anche noi.
    if (!memberships || memberships.length === 0) continue;

    const primary = primaryMembership(memberships);
    const score = typeof audit.score === "number" ? audit.score : null;
    const scoreDisplayMode = audit.scoreDisplayMode ?? "informative";
    const isScored =
      scoreDisplayMode === "numeric" ||
      scoreDisplayMode === "binary" ||
      scoreDisplayMode === "metricSavings";

    audits.push({
      id: auditId,
      title: audit.title ?? auditId,
      description: audit.description ?? "",
      score,
      scoreDisplayMode,
      displayValue: audit.displayValue ?? null,
      numericValue:
        typeof audit.numericValue === "number" ? audit.numericValue : null,
      numericUnit: audit.numericUnit ?? null,
      memberships,
      category: primary.category,
      group: primary.group,
      weight: primary.weight,
      weightPct: primary.weightPct,
      savingsMs:
        typeof audit.details?.overallSavingsMs === "number"
          ? audit.details.overallSavingsMs
          : null,
      savingsBytes:
        typeof audit.details?.overallSavingsBytes === "number"
          ? audit.details.overallSavingsBytes
          : null,
      metricSavings: normalizeMetricSavings(audit.metricSavings),
      isOpportunity: audit.details?.type === "opportunity",
      isFailing: isScored && score !== null && score < PASS_THRESHOLD,
      table: normalizeTable(audit),
      warnings: toStringArray(audit.warnings),
    });
  }

  const categories: RunResult["categories"] = {};
  for (const categoryId of CATEGORY_IDS) {
    const category = lhr.categories[categoryId];
    if (!category) continue;
    categories[categoryId] = {
      id: categoryId,
      title: category.title ?? categoryId,
      score: typeof category.score === "number" ? category.score : null,
    };
  }

  const metrics: MetricResult[] = METRIC_AUDIT_IDS.map((metricId) => {
    const audit = lhr.audits?.[metricId];
    if (!audit) return null;
    return {
      id: metricId,
      title: audit.title ?? metricId,
      displayValue: audit.displayValue ?? null,
      numericValue:
        typeof audit.numericValue === "number" ? audit.numericValue : null,
      numericUnit: audit.numericUnit ?? null,
      score: typeof audit.score === "number" ? audit.score : null,
    };
  }).filter((metric): metric is MetricResult => metric !== null);

  const screenshotData = lhr.audits["final-screenshot"]?.details?.data;

  const groupTitles: Record<string, string> = {};
  for (const [groupId, group] of Object.entries(lhr.categoryGroups ?? {})) {
    if (group?.title) groupTitles[groupId] = group.title;
  }

  return {
    key: `${requestedUrl}::${strategy}`,
    requestedUrl: lhr.requestedUrl ?? requestedUrl,
    finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl ?? requestedUrl,
    strategy,
    fetchTime: lhr.fetchTime ?? response.analysisUTCTimestamp ?? "",
    lighthouseVersion: lhr.lighthouseVersion ?? "",
    screenshot: typeof screenshotData === "string" ? screenshotData : null,
    categories,
    metrics,
    audits,
    field: normalizeField(response.loadingExperience),
    fieldOrigin: normalizeField(response.originLoadingExperience),
    runWarnings: toStringArray(lhr.runWarnings),
    groupTitles,
  };
}

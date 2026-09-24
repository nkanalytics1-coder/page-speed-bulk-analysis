import { estimateScoreGain } from "./lighthouse-scoring";
import type {
  ActionItem,
  CategoryId,
  NormalizedAudit,
  RunResult,
  Strategy,
} from "./types";

/**
 * Moltiplicatori di categoria applicati al punteggio di priorità.
 *
 * Lo strumento nasce per la velocità, quindi Performance pesa pieno. Gli altri
 * sono scalati perché un punto di Best Practices non ha lo stesso valore di
 * business di un punto di Performance. I valori sono riportati nel foglio
 * "Metodologia" dell'export, così la scelta resta ispezionabile.
 */
export const CATEGORY_MULTIPLIERS: Record<CategoryId, number> = {
  performance: 1,
  seo: 0.7,
  accessibility: 0.7,
  "best-practices": 0.5,
};

/** Soglie delle fasce di priorità, applicate al `priorityScore`. */
export const PRIORITY_BANDS = {
  Critica: 10,
  Alta: 5,
  Media: 2,
} as const;

function bandFor(score: number): ActionItem["priorityBand"] {
  if (score >= PRIORITY_BANDS.Critica) return "Critica";
  if (score >= PRIORITY_BANDS.Alta) return "Alta";
  if (score >= PRIORITY_BANDS.Media) return "Media";
  return "Bassa";
}

/**
 * Punti di categoria recuperabili sistemando questo audit su questa run.
 *
 * Per Performance il peso dell'audit è sempre 0 (solo le metriche pesano),
 * quindi simuliamo i `metricSavings` sulle curve di scoring di Lighthouse.
 * Per le altre categorie il peso è reale e il calcolo è diretto.
 */
function pointsRecoverable(audit: NormalizedAudit, run: RunResult): number {
  if (audit.category === "performance") {
    if (!audit.metricSavings) return 0;
    const measured: Record<string, number | null> = {};
    for (const metric of run.metrics) {
      measured[metric.id] = metric.numericValue;
    }
    return estimateScoreGain(run.strategy, measured, audit.metricSavings);
  }

  if (audit.score == null) return 0;
  return audit.weightPct * (1 - audit.score) * 100;
}

interface Accumulator {
  auditId: string;
  title: string;
  description: string;
  category: CategoryId;
  occurrences: number;
  urls: Set<string>;
  strategies: Set<Strategy>;
  scoreSum: number;
  scoreCount: number;
  pointsSum: number;
  savingsMs: number;
  savingsBytes: number;
  /** Somma dei moltiplicatori di importanza delle run coinvolte. */
  importanceSum: number;
}

export interface ActionPlan {
  items: ActionItem[];
  totalPages: number;
  totalRuns: number;
}

export function buildActionPlan(
  runs: RunResult[],
  /**
   * Moltiplicatore di importanza per URL, dal tipo di pagina scelto
   * sul template. Assente significa importanza neutra.
   */
  importanceByUrl: Record<string, number> = {},
): ActionPlan {
  const totalPages = new Set(runs.map((run) => run.requestedUrl)).size;
  const accumulators = new Map<string, Accumulator>();

  for (const run of runs) {
    for (const audit of run.audits) {
      if (!audit.isFailing) continue;
      // Le metriche sono sintomi, non azioni: restano fuori dal piano.
      if (audit.group === "metrics") continue;

      let accumulator = accumulators.get(audit.id);
      if (!accumulator) {
        accumulator = {
          auditId: audit.id,
          title: audit.title,
          description: audit.description,
          category: audit.category,
          occurrences: 0,
          urls: new Set(),
          strategies: new Set(),
          scoreSum: 0,
          scoreCount: 0,
          pointsSum: 0,
          savingsMs: 0,
          savingsBytes: 0,
          importanceSum: 0,
        };
        accumulators.set(audit.id, accumulator);
      }

      accumulator.importanceSum += importanceByUrl[run.requestedUrl] ?? 1;
      accumulator.occurrences += 1;
      accumulator.urls.add(run.requestedUrl);
      accumulator.strategies.add(run.strategy);
      if (audit.score != null) {
        accumulator.scoreSum += audit.score;
        accumulator.scoreCount += 1;
      }
      accumulator.pointsSum += pointsRecoverable(audit, run);
      accumulator.savingsMs += audit.savingsMs ?? 0;
      accumulator.savingsBytes += audit.savingsBytes ?? 0;
    }
  }

  const items: ActionItem[] = [];

  for (const accumulator of accumulators.values()) {
    const avgPoints = accumulator.pointsSum / accumulator.occurrences;
    const coverage =
      totalPages > 0 ? accumulator.urls.size / totalPages : 0;

    // Diagnostiche senza metricSavings: l'impatto sul punteggio non è
    // quantificabile, usiamo il tempo risparmiato come proxy limitato
    // così non finiscono tutte appiattite a zero.
    const impactEstimated = avgPoints <= 0;
    const avgSavingsMs = accumulator.savingsMs / accumulator.occurrences;
    const basePoints = impactEstimated
      ? Math.min(3, avgSavingsMs / 1000)
      : avgPoints;

    // Importanza media delle pagine su cui l'audit fallisce: un problema che
    // colpisce il checkout pesa più dello stesso problema su un archivio.
    const meanImportance =
      accumulator.occurrences > 0
        ? accumulator.importanceSum / accumulator.occurrences
        : 1;

    const priorityScore =
      basePoints *
      coverage *
      CATEGORY_MULTIPLIERS[accumulator.category] *
      meanImportance;

    items.push({
      meanImportance,
      auditId: accumulator.auditId,
      title: accumulator.title,
      description: accumulator.description,
      category: accumulator.category,
      occurrences: accumulator.occurrences,
      pagesAffected: accumulator.urls.size,
      affectedUrls: [...accumulator.urls].sort(),
      strategies: [...accumulator.strategies].sort(),
      avgScore:
        accumulator.scoreCount > 0
          ? accumulator.scoreSum / accumulator.scoreCount
          : null,
      avgPointsRecoverable: avgPoints,
      totalPointsRecoverable: accumulator.pointsSum,
      totalSavingsMs: accumulator.savingsMs,
      totalSavingsBytes: accumulator.savingsBytes,
      coverage,
      priorityScore,
      priorityBand: bandFor(priorityScore),
      impactEstimated,
    });
  }

  items.sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) {
      return b.priorityScore - a.priorityScore;
    }
    if (b.totalSavingsMs !== a.totalSavingsMs) {
      return b.totalSavingsMs - a.totalSavingsMs;
    }
    return a.title.localeCompare(b.title, "it");
  });

  return { items, totalPages, totalRuns: runs.length };
}

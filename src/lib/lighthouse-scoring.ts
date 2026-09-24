import type { MetricSavings, Strategy } from "./types";

/**
 * Riproduzione della funzione di scoring di Lighthouse (core/lib/statistics.js).
 *
 * Lighthouse mappa ogni metrica su un punteggio 0-1 con una distribuzione
 * log-normale definita da due punti di controllo: `median` (→ 0.5) e
 * `p10` (→ 0.9). Serve per stimare quanti punti del punteggio Performance
 * si recuperano davvero applicando un `metricSavings`, dato che le
 * opportunità di performance hanno peso 0 nella categoria e quindi non
 * sono ordinabili per peso.
 */

/** Approssimazione di Abramowitz & Stegun 7.1.26, la stessa usata da Lighthouse. */
function erf(x: number): number {
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
  return sign * (1 - y * Math.exp(-ax * ax));
}

/** Closest double to `erfc^-1(2 * 1/10)`. Costante presa da Lighthouse. */
const INVERSE_ERFC_ONE_FIFTH = 0.9061938024368232;

export function logNormalScore(
  controlPoints: { median: number; p10: number },
  value: number,
): number {
  const { median, p10 } = controlPoints;
  if (value <= 0) return 1;

  const xLogRatio = Math.log(value / median);
  const p10LogRatio = -Math.log(p10 / median); // positivo, perché p10 < median
  const standardizedX = (xLogRatio * INVERSE_ERFC_ONE_FIFTH) / p10LogRatio;
  const score = (1 - erf(standardizedX)) / 2;

  if (score > 0.9999) return 1;
  if (score < 0.0001) return 0;
  return score;
}

export interface MetricCurve {
  id: string;
  /** Chiave usata da Lighthouse dentro `audit.metricSavings`. */
  savingsKey: keyof MetricSavings;
  label: string;
  weight: number;
  median: number;
  p10: number;
  unit: "ms" | "unitless";
}

/**
 * Pesi e punti di controllo della versione 10+ di Lighthouse.
 * Fonte: developer.chrome.com/docs/lighthouse/performance/performance-scoring
 */
const MOBILE_CURVES: MetricCurve[] = [
  {
    id: "first-contentful-paint",
    savingsKey: "FCP",
    label: "First Contentful Paint",
    weight: 10,
    p10: 1800,
    median: 3000,
    unit: "ms",
  },
  {
    id: "speed-index",
    savingsKey: "FCP", // Lighthouse non emette savings per SI: non lo simuliamo
    label: "Speed Index",
    weight: 10,
    p10: 3387,
    median: 5800,
    unit: "ms",
  },
  {
    id: "largest-contentful-paint",
    savingsKey: "LCP",
    label: "Largest Contentful Paint",
    weight: 25,
    p10: 2500,
    median: 4000,
    unit: "ms",
  },
  {
    id: "total-blocking-time",
    savingsKey: "TBT",
    label: "Total Blocking Time",
    weight: 30,
    p10: 200,
    median: 600,
    unit: "ms",
  },
  {
    id: "cumulative-layout-shift",
    savingsKey: "CLS",
    label: "Cumulative Layout Shift",
    weight: 25,
    p10: 0.1,
    median: 0.25,
    unit: "unitless",
  },
];

const DESKTOP_CURVES: MetricCurve[] = [
  {
    id: "first-contentful-paint",
    savingsKey: "FCP",
    label: "First Contentful Paint",
    weight: 10,
    p10: 934,
    median: 1600,
    unit: "ms",
  },
  {
    id: "speed-index",
    savingsKey: "FCP",
    label: "Speed Index",
    weight: 10,
    p10: 1311,
    median: 2300,
    unit: "ms",
  },
  {
    id: "largest-contentful-paint",
    savingsKey: "LCP",
    label: "Largest Contentful Paint",
    weight: 25,
    p10: 1200,
    median: 2400,
    unit: "ms",
  },
  {
    id: "total-blocking-time",
    savingsKey: "TBT",
    label: "Total Blocking Time",
    weight: 30,
    p10: 146,
    median: 350,
    unit: "ms",
  },
  {
    id: "cumulative-layout-shift",
    savingsKey: "CLS",
    label: "Cumulative Layout Shift",
    weight: 25,
    p10: 0.1,
    median: 0.25,
    unit: "unitless",
  },
];

export function curvesFor(strategy: Strategy): MetricCurve[] {
  return strategy === "desktop" ? DESKTOP_CURVES : MOBILE_CURVES;
}

/**
 * Stima i punti di Performance (scala 0-100) che si recuperano applicando
 * i `metricSavings` di un audit ai valori metrici misurati.
 *
 * Solo le metriche per cui Lighthouse emette un savings esplicito vengono
 * simulate: Speed Index viene lasciato invariato perché non è mai presente
 * in `metricSavings`, e stimarlo sarebbe inventato.
 */
export function estimateScoreGain(
  strategy: Strategy,
  /** Valori misurati, per id di audit (es. "largest-contentful-paint": 3200). */
  measured: Record<string, number | null>,
  savings: MetricSavings,
): number {
  const curves = curvesFor(strategy);
  const totalWeight = curves.reduce((sum, c) => sum + c.weight, 0);
  let gain = 0;

  for (const curve of curves) {
    // Speed Index non è simulabile: nessun audit dichiara savings per lui.
    if (curve.id === "speed-index") continue;

    const value = measured[curve.id];
    if (value == null || !Number.isFinite(value)) continue;

    const saved = savings[curve.savingsKey];
    if (!saved || saved <= 0) continue;

    const improved = Math.max(0, value - saved);
    const before = logNormalScore(curve, value);
    const after = logNormalScore(curve, improved);
    gain += ((after - before) * curve.weight) / totalWeight;
  }

  return Math.max(0, gain * 100);
}

/** Soglia Lighthouse: un audit con score ≥ 0.9 è considerato superato. */
export const PASS_THRESHOLD = 0.9;

/** Soglia Lighthouse per il colore arancione (0.5-0.89). */
export const AVERAGE_THRESHOLD = 0.5;

export type Rating = "pass" | "average" | "fail" | "none";

export function ratingFor(score: number | null | undefined): Rating {
  if (score == null) return "none";
  if (score >= PASS_THRESHOLD) return "pass";
  if (score >= AVERAGE_THRESHOLD) return "average";
  return "fail";
}

import type { FieldMetric } from "./types";

const numberFormat = new Intl.NumberFormat("it-IT");

export function formatScore(score: number | null | undefined): string {
  if (score == null) return "—";
  return String(Math.round(score * 100));
}

export function formatMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toLocaleString("it-IT", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} s`;
}

export function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`;
  return `${(value / (1024 * 1024)).toLocaleString("it-IT", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} MiB`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return numberFormat.format(Math.round(value));
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** I percentili CrUX sono in ms, tranne CLS che arriva moltiplicato per 100. */
export function formatFieldValue(metric: FieldMetric): string {
  if (metric.id === "CUMULATIVE_LAYOUT_SHIFT_SCORE") {
    return (metric.percentile / 100).toLocaleString("it-IT", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return formatMs(metric.percentile);
}

export interface FormattedCell {
  text: string;
  href?: string;
  /** true per valori monospaziati (selettori CSS, snippet, posizioni nel sorgente). */
  code?: boolean;
}

type CellObject = Record<string, unknown>;

function asString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return numberFormat.format(value);
  if (typeof value === "boolean") return value ? "sì" : "no";
  return "";
}

/**
 * Formatta una cella di dettaglio Lighthouse nel modo in cui la renderizza
 * il report ufficiale, a partire dal `valueType` della colonna.
 */
export function formatCell(value: unknown, valueType: string): FormattedCell {
  if (value == null) return { text: "" };

  if (typeof value === "object") {
    const object = value as CellObject;
    const type = asString(object.type);

    if (type === "node") {
      const label =
        asString(object.nodeLabel) ||
        asString(object.selector) ||
        asString(object.snippet);
      return { text: label, code: true };
    }
    if (type === "source-location") {
      const url = asString(object.url);
      const line = object.line != null ? `:${asString(object.line)}` : "";
      return { text: `${url}${line}`, href: url || undefined, code: true };
    }
    if (type === "link") {
      return {
        text: asString(object.text) || asString(object.url),
        href: asString(object.url) || undefined,
      };
    }
    if (type === "url") {
      const url = asString(object.value);
      return { text: url, href: url || undefined };
    }
    if (type === "code") {
      return { text: asString(object.value), code: true };
    }
    // Forma generica: proviamo i campi che Lighthouse usa più spesso.
    const fallback =
      asString(object.value) ||
      asString(object.text) ||
      asString(object.url) ||
      asString(object.snippet);
    return { text: fallback };
  }

  if (typeof value === "number") {
    switch (valueType) {
      case "bytes":
        return { text: formatBytes(value) };
      case "ms":
      case "timespanMs":
        return { text: formatMs(value) };
      default:
        return { text: formatNumber(value) };
    }
  }

  const text = asString(value);
  if (valueType === "url") {
    return { text, href: text.startsWith("http") ? text : undefined };
  }
  if (valueType === "code") {
    return { text, code: true };
  }
  return { text };
}

/** Versione testuale semplice, usata nell'export Excel. */
export function cellToText(value: unknown, valueType: string): string {
  return formatCell(value, valueType).text;
}

export function shortUrl(url: string, maxLength = 60): string {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const display = path === "/" ? parsed.hostname : path;
    return display.length > maxLength
      ? `${display.slice(0, maxLength)}…`
      : display;
  } catch {
    return url.length > maxLength ? `${url.slice(0, maxLength)}…` : url;
  }
}

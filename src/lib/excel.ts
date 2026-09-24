import ExcelJS from "exceljs";
import { cellToText, formatBytes, formatMs } from "./format";
import { learnMoreUrl, stripMarkdown } from "./export-payload";
import { CATEGORY_MULTIPLIERS, buildActionPlan } from "./priority";
import { CATEGORY_IDS, CATEGORY_LABELS } from "./types";
import type { ActionItem, CategoryId, RunResult } from "./types";
import type { CruxResult } from "./crux";
import type { TemplateSummary } from "./template-summary";

const FONT = "Open Sans";

const COLORS = {
  header: "FF1F2933",
  headerText: "FFFFFFFF",
  critica: "FFFFD5D2",
  alta: "FFFFE8CC",
  media: "FFFFF6D6",
  bassa: "FFE9F7EF",
  pass: "FF0CCE6B",
  average: "FFFFA400",
  fail: "FFFF4E42",
  muted: "FFF4F5F7",
} as const;

type Column = ExcelJS.Column & { key: string };

function styleHeader(sheet: ExcelJS.Worksheet) {
  const header = sheet.getRow(1);
  header.font = { name: FONT, size: 10, bold: true, color: { argb: COLORS.headerText } };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: COLORS.header },
  };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 30;
}

function applyBodyFont(sheet: ExcelJS.Worksheet) {
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.font = { name: FONT, size: 10 };
    row.alignment = { vertical: "top", wrapText: false };
  });
}

function finalize(sheet: ExcelJS.Worksheet, columnCount: number) {
  styleHeader(sheet);
  applyBodyFont(sheet);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  if (sheet.rowCount > 1) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columnCount },
    };
  }
}

function bandColor(band: ActionItem["priorityBand"]): string {
  switch (band) {
    case "Critica":
      return COLORS.critica;
    case "Alta":
      return COLORS.alta;
    case "Media":
      return COLORS.media;
    default:
      return COLORS.bassa;
  }
}

function scoreColor(score: number | null): string | null {
  if (score == null) return null;
  if (score >= 0.9) return COLORS.pass;
  if (score >= 0.5) return COLORS.average;
  return COLORS.fail;
}

function paint(cell: ExcelJS.Cell, argb: string) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
}

/* ------------------------------------------------------------------ *
 * Fogli
 * ------------------------------------------------------------------ */

function addActionPlanSheet(
  workbook: ExcelJS.Workbook,
  items: ActionItem[],
  totalPages: number,
) {
  const sheet = workbook.addWorksheet("Piano d'azione", {
    properties: { defaultRowHeight: 15 },
  });

  sheet.columns = [
    { header: "#", key: "rank", width: 5 },
    { header: "Priorità", key: "band", width: 10 },
    { header: "Punteggio priorità", key: "score", width: 11 },
    { header: "Categoria", key: "category", width: 14 },
    { header: "Azione da fare", key: "title", width: 52 },
    { header: "Pagine coinvolte", key: "pages", width: 10 },
    { header: "% pagine", key: "coverage", width: 9 },
    { header: "Run coinvolte", key: "occurrences", width: 9 },
    { header: "Punteggio medio audit", key: "avgScore", width: 11 },
    { header: "Punti recuperabili (media pagina)", key: "avgPoints", width: 13 },
    { header: "Punti recuperabili (totale)", key: "totalPoints", width: 13 },
    { header: "Risparmio tempo totale", key: "savingsMs", width: 13 },
    { header: "Risparmio peso totale", key: "savingsBytes", width: 13 },
    { header: "Dispositivi", key: "strategies", width: 16 },
    { header: "Impatto", key: "estimated", width: 16 },
    { header: "Come intervenire", key: "description", width: 70 },
    { header: "Documentazione", key: "docs", width: 30 },
    { header: "ID audit Lighthouse", key: "auditId", width: 28 },
    { header: "URL coinvolti", key: "urls", width: 70 },
  ] as Column[];

  items.forEach((item, index) => {
    const row = sheet.addRow({
      rank: index + 1,
      band: item.priorityBand,
      score: Number(item.priorityScore.toFixed(2)),
      category: CATEGORY_LABELS[item.category],
      title: item.title,
      pages: item.pagesAffected,
      coverage: item.coverage,
      occurrences: item.occurrences,
      avgScore: item.avgScore == null ? "—" : Math.round(item.avgScore * 100),
      avgPoints: Number(item.avgPointsRecoverable.toFixed(2)),
      totalPoints: Number(item.totalPointsRecoverable.toFixed(2)),
      savingsMs: item.totalSavingsMs > 0 ? formatMs(item.totalSavingsMs) : "—",
      savingsBytes:
        item.totalSavingsBytes > 0 ? formatBytes(item.totalSavingsBytes) : "—",
      strategies: item.strategies
        .map((s) => (s === "mobile" ? "Mobile" : "Desktop"))
        .join(" + "),
      estimated: item.impactEstimated ? "Stimato da tempo" : "Calcolato",
      description: stripMarkdown(item.description),
      docs: learnMoreUrl(item.description) ?? "",
      auditId: item.auditId,
      urls: item.affectedUrls.slice(0, 8).join("\n"),
    });

    paint(row.getCell("band"), bandColor(item.priorityBand));
    row.getCell("coverage").numFmt = "0%";
    row.getCell("score").numFmt = "0.00";
    row.getCell("avgPoints").numFmt = "0.00";
    row.getCell("totalPoints").numFmt = "0.00";

    const docs = row.getCell("docs");
    if (typeof docs.value === "string" && docs.value) {
      docs.value = { text: "Documentazione", hyperlink: docs.value };
      docs.font = { name: FONT, size: 10, underline: true, color: { argb: "FF1A73E8" } };
    }
  });

  finalize(sheet, sheet.columnCount);

  // La colonna URL contiene elenchi multiriga: la mandiamo a capo.
  sheet.getColumn("urls").alignment = { wrapText: true, vertical: "top" };
  sheet.getColumn("title").alignment = { wrapText: true, vertical: "top" };
  sheet.getColumn("description").alignment = { wrapText: true, vertical: "top" };

  if (items.length === 0) {
    sheet.addRow({
      title: `Nessun audit fallito sulle ${totalPages} pagine analizzate.`,
    });
  }
}

function addSummarySheet(workbook: ExcelJS.Workbook, runs: RunResult[]) {
  const sheet = workbook.addWorksheet("Riepilogo pagine");

  sheet.columns = [
    { header: "URL", key: "url", width: 60 },
    { header: "Dispositivo", key: "strategy", width: 11 },
    ...CATEGORY_IDS.map((category) => ({
      header: CATEGORY_LABELS[category],
      key: category,
      width: 13,
    })),
    { header: "FCP", key: "fcp", width: 10 },
    { header: "LCP", key: "lcp", width: 10 },
    { header: "TBT", key: "tbt", width: 10 },
    { header: "CLS", key: "cls", width: 10 },
    { header: "Speed Index", key: "si", width: 11 },
    { header: "Time to Interactive", key: "tti", width: 11 },
    { header: "Audit da correggere", key: "failing", width: 11 },
    { header: "Data analisi", key: "fetchTime", width: 20 },
    { header: "Versione Lighthouse", key: "version", width: 13 },
  ] as Column[];

  const metric = (run: RunResult, id: string) =>
    run.metrics.find((m) => m.id === id)?.displayValue ?? "—";

  for (const run of runs) {
    const row = sheet.addRow({
      url: run.requestedUrl,
      strategy: run.strategy === "mobile" ? "Mobile" : "Desktop",
      performance: run.categories.performance?.score ?? null,
      accessibility: run.categories.accessibility?.score ?? null,
      "best-practices": run.categories["best-practices"]?.score ?? null,
      seo: run.categories.seo?.score ?? null,
      fcp: metric(run, "first-contentful-paint"),
      lcp: metric(run, "largest-contentful-paint"),
      tbt: metric(run, "total-blocking-time"),
      cls: metric(run, "cumulative-layout-shift"),
      si: metric(run, "speed-index"),
      tti: metric(run, "interactive"),
      failing: run.audits.filter((audit) => audit.isFailing).length,
      fetchTime: run.fetchTime ? new Date(run.fetchTime).toLocaleString("it-IT") : "—",
      version: run.lighthouseVersion,
    });

    for (const category of CATEGORY_IDS) {
      const cell = row.getCell(category);
      const score = run.categories[category]?.score ?? null;
      if (score == null) {
        cell.value = "—";
        continue;
      }
      cell.value = Math.round(score * 100);
      const color = scoreColor(score);
      if (color) {
        paint(cell, color);
        cell.font = { name: FONT, size: 10, color: { argb: "FF1F2933" } };
        cell.alignment = { horizontal: "center" };
      }
    }
  }

  finalize(sheet, sheet.columnCount);
}

function addAuditDetailSheet(workbook: ExcelJS.Workbook, runs: RunResult[]) {
  const sheet = workbook.addWorksheet("Dettaglio per pagina");

  sheet.columns = [
    { header: "URL", key: "url", width: 55 },
    { header: "Dispositivo", key: "strategy", width: 11 },
    { header: "Categoria", key: "category", width: 14 },
    { header: "Audit", key: "title", width: 50 },
    { header: "Punteggio", key: "score", width: 9 },
    { header: "Valore rilevato", key: "displayValue", width: 18 },
    { header: "Risparmio tempo", key: "savingsMs", width: 12 },
    { header: "Risparmio peso", key: "savingsBytes", width: 12 },
    { header: "Risparmio LCP", key: "lcp", width: 11 },
    { header: "Risparmio FCP", key: "fcp", width: 11 },
    { header: "Risparmio TBT", key: "tbt", width: 11 },
    { header: "Risparmio CLS", key: "cls", width: 11 },
    { header: "Peso nella categoria", key: "weight", width: 11 },
    { header: "Elementi coinvolti", key: "items", width: 11 },
    { header: "ID audit", key: "auditId", width: 28 },
  ] as Column[];

  for (const run of runs) {
    const failing = run.audits
      .filter((audit) => audit.isFailing && audit.group !== "metrics")
      .sort((a, b) => (a.score ?? 0) - (b.score ?? 0));

    for (const audit of failing) {
      const row = sheet.addRow({
        url: run.requestedUrl,
        strategy: run.strategy === "mobile" ? "Mobile" : "Desktop",
        category: CATEGORY_LABELS[audit.category],
        title: audit.title,
        score: audit.score == null ? "—" : Math.round(audit.score * 100),
        displayValue: audit.displayValue ?? "—",
        savingsMs: audit.savingsMs ? formatMs(audit.savingsMs) : "—",
        savingsBytes: audit.savingsBytes ? formatBytes(audit.savingsBytes) : "—",
        lcp: audit.metricSavings?.LCP ? formatMs(audit.metricSavings.LCP) : "—",
        fcp: audit.metricSavings?.FCP ? formatMs(audit.metricSavings.FCP) : "—",
        tbt: audit.metricSavings?.TBT ? formatMs(audit.metricSavings.TBT) : "—",
        cls: audit.metricSavings?.CLS
          ? audit.metricSavings.CLS.toFixed(3)
          : "—",
        weight: audit.weightPct,
        items: audit.table?.totalItems ?? 0,
        auditId: audit.id,
      });

      row.getCell("weight").numFmt = "0.0%";
      const scoreCell = row.getCell("score");
      const color = scoreColor(audit.score);
      if (color) {
        paint(scoreCell, color);
        scoreCell.alignment = { horizontal: "center" };
      }
    }
  }

  finalize(sheet, sheet.columnCount);
}

function addResourcesSheet(workbook: ExcelJS.Workbook, runs: RunResult[]) {
  const sheet = workbook.addWorksheet("Risorse da correggere");

  sheet.columns = [
    { header: "URL pagina", key: "page", width: 45 },
    { header: "Dispositivo", key: "strategy", width: 11 },
    { header: "Audit", key: "audit", width: 40 },
    { header: "Elemento / risorsa", key: "resource", width: 70 },
    { header: "Dettaglio 1", key: "d1", width: 22 },
    { header: "Dettaglio 2", key: "d2", width: 22 },
    { header: "Dettaglio 3", key: "d3", width: 22 },
    { header: "Righe totali audit", key: "total", width: 11 },
  ] as Column[];

  for (const run of runs) {
    for (const audit of run.audits) {
      if (!audit.isFailing || !audit.table) continue;

      const headings = audit.table.headings.filter((h) => h.key);
      if (headings.length === 0) continue;

      const [first, ...rest] = headings;

      for (const item of audit.table.items) {
        const extras = rest
          .slice(0, 3)
          .map((heading) =>
            heading.key ? cellToText(item[heading.key], heading.valueType) : "",
          );

        sheet.addRow({
          page: run.requestedUrl,
          strategy: run.strategy === "mobile" ? "Mobile" : "Desktop",
          audit: audit.title,
          resource: first.key
            ? cellToText(item[first.key], first.valueType)
            : "",
          d1: `${rest[0]?.label ?? ""}${extras[0] ? `: ${extras[0]}` : ""}`,
          d2: `${rest[1]?.label ?? ""}${extras[1] ? `: ${extras[1]}` : ""}`,
          d3: `${rest[2]?.label ?? ""}${extras[2] ? `: ${extras[2]}` : ""}`,
          total: audit.table.totalItems,
        });
      }
    }
  }

  finalize(sheet, sheet.columnCount);
}

function addFieldSheet(workbook: ExcelJS.Workbook, runs: RunResult[]) {
  const sheet = workbook.addWorksheet("Dati reali utenti (CrUX)");

  sheet.columns = [
    { header: "URL", key: "url", width: 55 },
    { header: "Dispositivo", key: "strategy", width: 11 },
    { header: "Ambito", key: "scope", width: 14 },
    { header: "Valutazione complessiva", key: "overall", width: 14 },
    { header: "Metrica", key: "metric", width: 28 },
    { header: "75° percentile", key: "value", width: 14 },
    { header: "Valutazione", key: "rating", width: 12 },
    { header: "% utenti veloci", key: "fast", width: 11 },
    { header: "% utenti medi", key: "average", width: 11 },
    { header: "% utenti lenti", key: "slow", width: 11 },
  ] as Column[];

  const ratingLabels: Record<string, string> = {
    FAST: "Buono",
    AVERAGE: "Da migliorare",
    SLOW: "Scarso",
  };

  let hasData = false;

  for (const run of runs) {
    for (const [scope, field] of [
      ["Pagina", run.field],
      ["Intero sito", run.fieldOrigin],
    ] as const) {
      if (!field) continue;
      hasData = true;

      for (const metric of field.metrics) {
        const isCls = metric.id === "CUMULATIVE_LAYOUT_SHIFT_SCORE";
        const row = sheet.addRow({
          url: run.requestedUrl,
          strategy: run.strategy === "mobile" ? "Mobile" : "Desktop",
          scope,
          overall: field.overallCategory
            ? (ratingLabels[field.overallCategory] ?? field.overallCategory)
            : "—",
          metric: metric.label,
          value: isCls
            ? (metric.percentile / 100).toFixed(2)
            : formatMs(metric.percentile),
          rating: ratingLabels[metric.category] ?? metric.category,
          fast: metric.distributions[0]?.proportion ?? 0,
          average: metric.distributions[1]?.proportion ?? 0,
          slow: metric.distributions[2]?.proportion ?? 0,
        });

        for (const key of ["fast", "average", "slow"]) {
          row.getCell(key).numFmt = "0%";
        }

        const color =
          metric.category === "FAST"
            ? COLORS.pass
            : metric.category === "AVERAGE"
              ? COLORS.average
              : COLORS.fail;
        paint(row.getCell("rating"), color);
      }
    }
  }

  if (!hasData) {
    sheet.addRow({
      url: "Nessun dato di campo disponibile: le pagine analizzate non hanno traffico sufficiente nel Chrome UX Report.",
    });
  }

  finalize(sheet, sheet.columnCount);
}

function addMethodSheet(
  workbook: ExcelJS.Workbook,
  runs: RunResult[],
  itemCount: number,
) {
  const sheet = workbook.addWorksheet("Metodologia");
  sheet.columns = [
    { header: "Voce", key: "key", width: 34 },
    { header: "Valore", key: "value", width: 110 },
  ] as Column[];

  const pages = new Set(runs.map((run) => run.requestedUrl)).size;
  const versions = [...new Set(runs.map((run) => run.lighthouseVersion))]
    .filter(Boolean)
    .join(", ");

  const rows: [string, string][] = [
    ["Generato il", new Date().toLocaleString("it-IT")],
    ["", ""],
    ["DUE FONTI DIVERSE, NON CONFONDERLE", ""],
    [
      "Dati di campo (CrUX)",
      "Foglio \"Template (dati reali)\" e \"Confronto competitor\". Sono le misure degli utenti reali di Chrome negli ultimi 28 giorni, al 75° percentile. Sono i numeri su cui Google valuta il sito e su cui si decide se i Core Web Vitals sono superati. Esistono solo per pagine con traffico sufficiente.",
    ],
    [
      "Dati di laboratorio (Lighthouse)",
      "Tutti gli altri fogli. Sono una simulazione su rete e CPU emulate, eseguita al momento. Servono a capire PERCHÉ una pagina è lenta e cosa correggere, non a misurarne le prestazioni reali. Due esecuzioni sulla stessa pagina possono differire di qualche punto.",
    ],
    [
      "Ambito del dato di campo",
      "Quando CrUX non ha dati sulla singola pagina, il tool ripiega sulla media dell'intero sito e lo dichiara nella colonna \"Origine del dato\". Se tutti i template riportano lo stesso valore, è questo il motivo: non confrontarli fra loro.",
    ],
    ["", ""],
    ["Pagine analizzate", String(pages)],
    ["Analisi totali (pagina × dispositivo)", String(runs.length)],
    ["Azioni nel piano", String(itemCount)],
    ["Versione Lighthouse", versions || "—"],
    ["Fonte dati", "Google PageSpeed Insights API v5 (lo stesso motore di pagespeed.web.dev)"],
    ["", ""],
    ["COME SI LEGGE LA PRIORITÀ", ""],
    [
      "Punteggio priorità",
      "punti recuperabili medi per pagina × quota di pagine coinvolte × moltiplicatore di categoria. Scala indicativa 0-100, indipendente dal numero di pagine analizzate.",
    ],
    [
      "Punti recuperabili — Prestazioni",
      "Le opportunità di performance hanno peso 0 nella categoria: il punteggio dipende solo dalle 5 metriche. Perciò i risparmi dichiarati da Lighthouse (metricSavings su LCP, FCP, TBT, CLS) vengono applicati ai valori misurati e il punteggio viene ricalcolato sulle stesse curve log-normali usate da Lighthouse. La differenza è la stima dei punti recuperabili.",
    ],
    [
      "Punti recuperabili — altre categorie",
      "peso dell'audit nella categoria × (1 − punteggio audit) × 100. Qui i pesi sono reali e il calcolo è diretto.",
    ],
    [
      "Impatto \"Stimato da tempo\"",
      "Audit diagnostici per cui Lighthouse non dichiara alcun risparmio metrico. L'impatto sul punteggio non è quantificabile, quindi viene usato il tempo risparmiato come proxy, con un tetto di 3 punti. Vanno letti come approfondimenti, non come stime.",
    ],
    ["", ""],
    ["MOLTIPLICATORI DI CATEGORIA", ""],
    ...CATEGORY_IDS.map(
      (category) =>
        [
          CATEGORY_LABELS[category],
          `× ${CATEGORY_MULTIPLIERS[category as CategoryId]}`,
        ] as [string, string],
    ),
    [
      "Perché",
      "Lo strumento serve a ottimizzare la velocità, quindi Prestazioni pesa pieno. Modifica i moltiplicatori in src/lib/priority.ts se l'ordine di priorità deve riflettere obiettivi diversi.",
    ],
    ["", ""],
    ["FASCE DI PRIORITÀ", ""],
    ["Critica", "punteggio ≥ 10"],
    ["Alta", "punteggio ≥ 5"],
    ["Media", "punteggio ≥ 2"],
    ["Bassa", "punteggio < 2"],
    ["", ""],
    ["NOTE", ""],
    [
      "Dati di laboratorio",
      "I punteggi Lighthouse derivano da una singola simulazione su rete e CPU emulate. Due esecuzioni sulla stessa pagina possono differire di alcuni punti: usa le differenze grandi, non quelle di 2-3 punti.",
    ],
    [
      "Dati di campo",
      "Il foglio CrUX riporta l'esperienza reale degli utenti Chrome negli ultimi 28 giorni. È disponibile solo per pagine con traffico sufficiente ed è la fonte più affidabile per capire l'impatto reale.",
    ],
    [
      "Soglia di fallimento",
      "Un audit è considerato da correggere quando il punteggio è sotto 0,90, la stessa soglia usata dal report Lighthouse ufficiale.",
    ],
  ];

  for (const [key, value] of rows) {
    const row = sheet.addRow({ key, value });
    if (value === "" && key !== "") {
      row.font = { name: FONT, size: 10, bold: true };
    }
  }

  styleHeader(sheet);
  sheet.getColumn("value").alignment = { wrapText: true, vertical: "top" };
  sheet.getColumn("key").alignment = { vertical: "top" };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

/* ------------------------------------------------------------------ *
 * Fogli dei dati di campo
 * ------------------------------------------------------------------ */

function cwvFill(rating: string | undefined): string | null {
  if (rating === "good") return COLORS.pass;
  if (rating === "needs-improvement") return COLORS.average;
  if (rating === "poor") return COLORS.fail;
  return null;
}

type CoreId =
  | "largest_contentful_paint"
  | "interaction_to_next_paint"
  | "cumulative_layout_shift";

function addTemplateSheet(
  workbook: ExcelJS.Workbook,
  templates: TemplateSummary[],
  formFactor: string,
) {
  const sheet = workbook.addWorksheet("Template (dati reali)");
  const device = formFactor === "DESKTOP" ? "Desktop" : "Mobile";

  sheet.columns = [
    { header: "Template", key: "label", width: 28 },
    { header: "Percorso", key: "pattern", width: 32 },
    { header: "Pagine nel sito", key: "totalUrls", width: 11 },
    { header: "Pagine analizzate", key: "sampled", width: 11 },
    { header: "Core Web Vitals", key: "cwv", width: 16 },
    { header: "LCP mediana p75 (ms)", key: "lcp", width: 13 },
    { header: "INP mediana p75 (ms)", key: "inp", width: 13 },
    { header: "CLS mediana p75", key: "cls", width: 13 },
    { header: "FCP (ms)", key: "fcp", width: 11 },
    { header: "TTFB (ms)", key: "ttfb", width: 11 },
    { header: "Collo di bottiglia LCP", key: "phase", width: 22 },
    { header: "Quota della fase", key: "phaseShare", width: 11 },
    { header: "Cosa fare", key: "hint", width: 72 },
    { header: "Dati propri della pagina", key: "scoped", width: 12 },
    { header: "Origine del dato", key: "origin", width: 46 },
    { header: "Dispositivo", key: "device", width: 11 },
  ] as Column[];

  const originNote: Record<TemplateSummary["dataScope"], string> = {
    url: "Misure delle pagine di questo template.",
    mixed: "In parte misure di pagina, in parte media dell'intero sito.",
    origin:
      "ATTENZIONE: nessuna pagina di questo template ha dati propri. I valori sono la media dell'intero sito, identica per tutti i template: non usarli per confrontarli fra loro.",
    none: "Nessun dato di campo disponibile.",
  };

  for (const template of templates) {
    const lcp = template.metrics.largest_contentful_paint;
    const inp = template.metrics.interaction_to_next_paint;
    const cls = template.metrics.cumulative_layout_shift;

    const row = sheet.addRow({
      label: template.label,
      pattern: template.pattern,
      totalUrls: template.totalUrls,
      sampled: template.sampled,
      cwv:
        template.passesCwv === true
          ? "Superati"
          : template.passesCwv === false
            ? "NON superati"
            : "Dati insufficienti",
      lcp: lcp ? Math.round(lcp.median) : "—",
      inp: inp ? Math.round(inp.median) : "—",
      cls: cls ? Number(cls.median.toFixed(3)) : "—",
      fcp: template.metrics.first_contentful_paint
        ? Math.round(template.metrics.first_contentful_paint.median)
        : "—",
      ttfb: template.metrics.experimental_time_to_first_byte
        ? Math.round(template.metrics.experimental_time_to_first_byte.median)
        : "—",
      phase: template.dominantLcpPhase?.label ?? "—",
      phaseShare: template.dominantLcpPhase?.share ?? "",
      hint: template.dominantLcpPhase?.hint ?? "",
      scoped: `${template.urlScoped} / ${template.sampled}`,
      origin: originNote[template.dataScope],
      device,
    });

    if (template.dataScope === "origin") {
      paint(row.getCell("origin"), COLORS.alta);
    }

    if (typeof row.getCell("phaseShare").value === "number") {
      row.getCell("phaseShare").numFmt = "0%";
    }

    const verdict = row.getCell("cwv");
    paint(
      verdict,
      template.passesCwv === true
        ? COLORS.pass
        : template.passesCwv === false
          ? COLORS.fail
          : COLORS.muted,
    );

    for (const [key, metric] of [
      ["lcp", lcp],
      ["inp", inp],
      ["cls", cls],
    ] as const) {
      const fill = cwvFill(metric?.rating);
      if (fill) paint(row.getCell(key), fill);
    }
  }

  if (templates.length === 0) {
    sheet.addRow({ label: "Nessuna scansione dei dati di campo effettuata." });
  }

  finalize(sheet, sheet.columnCount);
  sheet.getColumn("hint").alignment = { wrapText: true, vertical: "top" };
  sheet.getColumn("origin").alignment = { wrapText: true, vertical: "top" };
}

export interface CompetitorExport {
  label: string;
  isSelf: boolean;
  result: CruxResult | null;
  miss: string | null;
}

function addCompetitorSheet(
  workbook: ExcelJS.Workbook,
  competitors: CompetitorExport[],
  formFactor: string,
) {
  if (competitors.length === 0) return;

  const sheet = workbook.addWorksheet("Confronto competitor");

  sheet.columns = [
    { header: "Sito", key: "site", width: 30 },
    { header: "È il tuo", key: "self", width: 9 },
    { header: "Ambito del dato", key: "scope", width: 14 },
    { header: "Core Web Vitals", key: "cwv", width: 18 },
    { header: "LCP (ms)", key: "lcp", width: 11 },
    { header: "Confronto LCP", key: "dLcp", width: 20 },
    { header: "INP (ms)", key: "inp", width: 11 },
    { header: "Confronto INP", key: "dInp", width: 20 },
    { header: "CLS", key: "cls", width: 11 },
    { header: "Confronto CLS", key: "dCls", width: 20 },
    { header: "Periodo rilevazione", key: "period", width: 24 },
    { header: "Dispositivo", key: "device", width: 11 },
  ] as Column[];

  const self = competitors.find((entry) => entry.isSelf) ?? null;

  for (const entry of competitors) {
    const value = (id: CoreId) => entry.result?.metrics[id]?.p75 ?? null;
    const delta = (id: CoreId) => {
      if (entry.isSelf) return "";
      const theirs = value(id);
      const ours = self?.result?.metrics[id]?.p75 ?? null;
      if (theirs == null || ours == null) return "—";
      const diff = theirs - ours;
      const size =
        id === "cumulative_layout_shift"
          ? Math.abs(diff).toFixed(3)
          : String(Math.round(Math.abs(diff)));
      if (Number(size) === 0) return "pari";
      // Meno è meglio su tutte e tre: se il competitor ha un valore più alto,
      // il vantaggio è nostro.
      return diff > 0 ? `sei avanti di ${size}` : `sei indietro di ${size}`;
    };

    const row = sheet.addRow({
      site: entry.label,
      self: entry.isSelf ? "sì" : "",
      scope: entry.result
        ? entry.result.scope === "url"
          ? "Pagina"
          : "Intero sito"
        : "—",
      cwv: entry.result
        ? entry.result.passesCwv === true
          ? "Superati"
          : entry.result.passesCwv === false
            ? "NON superati"
            : "Dati insufficienti"
        : (entry.miss ?? "Nessun dato"),
      lcp: value("largest_contentful_paint") ?? "—",
      dLcp: delta("largest_contentful_paint"),
      inp: value("interaction_to_next_paint") ?? "—",
      dInp: delta("interaction_to_next_paint"),
      cls: value("cumulative_layout_shift") ?? "—",
      dCls: delta("cumulative_layout_shift"),
      period: entry.result?.collectionPeriod
        ? `${entry.result.collectionPeriod.first} – ${entry.result.collectionPeriod.last}`
        : "—",
      device: formFactor === "DESKTOP" ? "Desktop" : "Mobile",
    });

    const verdict = row.getCell("cwv");
    if (entry.result?.passesCwv === true) paint(verdict, COLORS.pass);
    else if (entry.result?.passesCwv === false) paint(verdict, COLORS.fail);

    for (const [key, id] of [
      ["lcp", "largest_contentful_paint"],
      ["inp", "interaction_to_next_paint"],
      ["cls", "cumulative_layout_shift"],
    ] as const) {
      const fill = cwvFill(entry.result?.metrics[id]?.rating);
      if (fill) paint(row.getCell(key), fill);
    }
  }

  finalize(sheet, sheet.columnCount);

  sheet.addRow({});
  const note = sheet.addRow({
    site:
      "Valori al 75° percentile degli utenti reali di Chrome, ultimi 28 giorni. " +
      'Dove l\'ambito è "Intero sito", CrUX non aveva dati sulla singola pagina: ' +
      "il valore è quello medio del dominio e va confrontato con cautela con un dato di pagina.",
  });
  note.font = { name: FONT, size: 9, italic: true };
}

/* ------------------------------------------------------------------ *
 * Composizione
 * ------------------------------------------------------------------ */

export interface WorkbookInput {
  runs: RunResult[];
  templates: TemplateSummary[];
  competitors: CompetitorExport[];
  formFactor: string;
}

/** Costruisce l'intera cartella di lavoro a partire dai risultati normalizzati. */
export function buildAuditWorkbook(input: WorkbookInput): ExcelJS.Workbook {
  const { runs, templates, competitors, formFactor } = input;
  const plan = buildActionPlan(runs);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Analisi velocità";
  workbook.created = new Date();

  // I dati di campo vengono per primi: sono quelli su cui Google valuta il sito.
  addTemplateSheet(workbook, templates, formFactor);
  addCompetitorSheet(workbook, competitors, formFactor);

  // I fogli Lighthouse compaiono solo se è stata fatta almeno una diagnosi.
  if (runs.length > 0) {
    addActionPlanSheet(workbook, plan.items, plan.totalPages);
    addSummarySheet(workbook, runs);
    addAuditDetailSheet(workbook, runs);
    addResourcesSheet(workbook, runs);
    addFieldSheet(workbook, runs);
  }

  addMethodSheet(workbook, runs, plan.items.length);

  return workbook;
}

/**
 * Verifica la pipeline completa senza consumare quota PageSpeed Insights.
 *
 * Usa un report Lighthouse reale (scripts/fixtures/sample-lhr.json, preso dal
 * repo ufficiale GoogleChrome/lighthouse) e lo fa passare per normalizzazione,
 * calcolo delle priorità e generazione dell'Excel, ricontrollando il file
 * prodotto. Eseguire con: npm run test:smoke
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import ExcelJS from "exceljs";

import { buildAuditWorkbook } from "@/lib/excel";
import { toExportPayload } from "@/lib/export-payload";
import { logNormalScore } from "@/lib/lighthouse-scoring";
import { buildActionPlan } from "@/lib/priority";
import { normalizeRun, type PsiResponse } from "@/lib/psi";
import { membershipIn } from "@/lib/types";
import type { RunResult, Strategy } from "@/lib/types";

const here = dirname(fileURLToPath(import.meta.url));
const lhr = JSON.parse(
  readFileSync(join(here, "fixtures", "sample-lhr.json"), "utf8"),
) as Record<string, unknown>;

const PAGES = [
  "https://esempio.it/",
  "https://esempio.it/prodotti",
  "https://esempio.it/contatti",
];

/** Dati di campo nella forma esatta restituita da PSI. */
const loadingExperience = {
  overall_category: "AVERAGE",
  metrics: {
    LARGEST_CONTENTFUL_PAINT_MS: {
      percentile: 3100,
      category: "AVERAGE",
      distributions: [
        { min: 0, max: 2500, proportion: 0.55 },
        { min: 2500, max: 4000, proportion: 0.28 },
        { min: 4000, proportion: 0.17 },
      ],
    },
    CUMULATIVE_LAYOUT_SHIFT_SCORE: {
      percentile: 12,
      category: "AVERAGE",
      distributions: [
        { min: 0, max: 10, proportion: 0.7 },
        { min: 10, max: 25, proportion: 0.2 },
        { min: 25, proportion: 0.1 },
      ],
    },
  },
};

function envelope(url: string): PsiResponse {
  return {
    loadingExperience,
    originLoadingExperience: loadingExperience,
    lighthouseResult: { ...lhr, requestedUrl: url } as PsiResponse["lighthouseResult"],
  };
}

function section(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
}

/* 1. Curve di scoring ------------------------------------------------- */

section("Curve di scoring Lighthouse");
// I due punti di controllo devono mappare esattamente su 0.9 e 0.5.
const lcpMobile = { median: 4000, p10: 2500 };
assert.ok(Math.abs(logNormalScore(lcpMobile, 2500) - 0.9) < 0.005, "p10 → 0.9");
assert.ok(Math.abs(logNormalScore(lcpMobile, 4000) - 0.5) < 0.005, "median → 0.5");
assert.equal(logNormalScore(lcpMobile, 0), 1, "valore nullo → 1");
assert.ok(logNormalScore(lcpMobile, 20000) < 0.05, "valore pessimo → ~0");
console.log(`LCP 2500ms → ${logNormalScore(lcpMobile, 2500).toFixed(4)} (atteso 0.9)`);
console.log(`LCP 4000ms → ${logNormalScore(lcpMobile, 4000).toFixed(4)} (atteso 0.5)`);
console.log(`LCP 1200ms → ${logNormalScore(lcpMobile, 1200).toFixed(4)}`);

/* 2. Normalizzazione -------------------------------------------------- */

section("Normalizzazione del report");
const runs: RunResult[] = [];
for (const url of PAGES) {
  for (const strategy of ["mobile", "desktop"] as Strategy[]) {
    runs.push(normalizeRun(envelope(url), url, strategy));
  }
}

const first = runs[0];
assert.equal(runs.length, 6, "6 run attese");
assert.ok(first.audits.length > 50, "audit normalizzati");
assert.ok(first.categories.performance, "categoria performance presente");
assert.ok(first.metrics.length >= 5, "metriche presenti");
assert.ok(first.field, "dati di campo presenti");

console.log(`Lighthouse ${first.lighthouseVersion} · ${first.audits.length} audit referenziati`);
for (const [id, category] of Object.entries(first.categories)) {
  console.log(`  ${id.padEnd(16)} ${Math.round((category!.score ?? 0) * 100)}`);
}
console.log(`  metriche: ${first.metrics.map((m) => `${m.id}=${m.displayValue}`).join(", ")}`);

const failing = first.audits.filter((a) => a.isFailing);
const withSavings = first.audits.filter((a) => a.metricSavings);
const withTables = first.audits.filter((a) => a.table);
console.log(`  da correggere: ${failing.length} · con metricSavings: ${withSavings.length} · con tabella: ${withTables.length}`);
assert.ok(failing.length > 0, "almeno un audit fallito");
assert.ok(withSavings.length > 0, "almeno un audit con metricSavings");
assert.ok(withTables.length > 0, "almeno un audit con tabella di dettaglio");

// Nessuna tabella deve superare il tetto di righe imposto dalla normalizzazione.
for (const audit of withTables) {
  assert.ok(audit.table!.items.length <= 10, `${audit.id}: righe entro il cap`);
}

// Ogni categoria con pesi deve sommare a 1 sulle proprie appartenenze:
// è la prova che nessun audit viene perso quando appartiene a più categorie.
for (const categoryId of ["accessibility", "seo", "best-practices"] as const) {
  const sum = first.audits.reduce(
    (total, audit) => total + (membershipIn(audit, categoryId)?.weightPct ?? 0),
    0,
  );
  assert.ok(Math.abs(sum - 1) < 0.001, `${categoryId}: pesi sommano a 1 (${sum})`);
  console.log(`  pesi ${categoryId}: somma ${sum.toFixed(4)}`);
}

// Gli audit condivisi fra categorie devono risultare in entrambe.
const shared = first.audits.filter((a) => a.memberships.length > 1);
assert.ok(shared.length > 0, "almeno un audit condiviso fra categorie");
console.log(
  `  audit in più categorie: ${shared.length} (es. ${shared
    .slice(0, 3)
    .map((a) => `${a.id}→${a.memberships.map((m) => m.category).join("+")}`)
    .join(", ")})`,
);

/* 3. Piano d'azione --------------------------------------------------- */

section("Piano d'azione");
const plan = buildActionPlan(runs);
assert.equal(plan.totalPages, 3, "3 pagine distinte");
assert.ok(plan.items.length > 0, "piano non vuoto");

// Nessuna metrica deve finire tra le azioni: sono sintomi, non interventi.
for (const item of plan.items) {
  assert.ok(
    !["largest-contentful-paint", "total-blocking-time", "speed-index"].includes(item.auditId),
    `${item.auditId} non deve comparire nel piano`,
  );
}
// Il punteggio deve essere ordinato in modo decrescente.
for (let i = 1; i < plan.items.length; i += 1) {
  assert.ok(
    plan.items[i - 1].priorityScore >= plan.items[i].priorityScore,
    "ordinamento decrescente",
  );
}

const quantified = plan.items.filter((item) => !item.impactEstimated);
assert.ok(quantified.length > 0, "almeno un'azione con impatto calcolato");
console.log(`${plan.items.length} azioni · ${quantified.length} con impatto calcolato`);
console.log(
  `fasce: ${["Critica", "Alta", "Media", "Bassa"]
    .map((band) => `${band} ${plan.items.filter((i) => i.priorityBand === band).length}`)
    .join(" · ")}`,
);
console.log("\nTop 10:");
for (const [index, item] of plan.items.slice(0, 10).entries()) {
  const points = item.impactEstimated ? "  stim." : `+${item.avgPointsRecoverable.toFixed(1)}`;
  console.log(
    `${String(index + 1).padStart(2)}. [${item.priorityBand.padEnd(7)}] ${points}  ${item.category.padEnd(14)} ${item.title.slice(0, 62)}`,
  );
}

/* 4. Payload di export ------------------------------------------------ */

section("Payload di export");
const payload = toExportPayload(runs);
assert.ok(payload.every((run) => run.screenshot === null), "screenshot rimossi");
assert.ok(payload.every((run) => run.audits.every((a) => a.isFailing)), "solo audit falliti");

// Il limite Vercel è 4,5 MB sul corpo della richiesta. Il caso peggiore
// ammesso dalla UI è 50 pagine × 2 strategie = 100 run: lo simuliamo davvero,
// replicando i run su URL distinti, e verifichiamo la dimensione compressa.
const WORST_CASE_RUNS = 100;
const worstCase: RunResult[] = Array.from({ length: WORST_CASE_RUNS }, (_, index) => {
  const source = payload[index % payload.length];
  const url = `https://esempio.it/categoria-${Math.floor(index / 2)}/pagina-dettaglio`;
  return { ...source, key: `${url}::${source.strategy}`, requestedUrl: url };
});

const plainBytes = Buffer.byteLength(JSON.stringify({ runs: worstCase }));
const gzipBytes = gzipSync(Buffer.from(JSON.stringify({ runs: worstCase }))).byteLength;
const LIMIT = 4.5 * 1024 * 1024;

console.log(`${runs.length} run reali → ${(Buffer.byteLength(JSON.stringify({ runs: payload })) / 1024).toFixed(0)} KiB`);
console.log(`caso peggiore ${WORST_CASE_RUNS} run:`);
console.log(`  JSON in chiaro ${(plainBytes / 1024 / 1024).toFixed(2)} MiB  ${plainBytes > LIMIT ? "✗ oltre il limite" : "✓"}`);
console.log(`  gzip           ${(gzipBytes / 1024 / 1024).toFixed(2)} MiB  ${gzipBytes > LIMIT ? "✗ oltre il limite" : "✓"} (rapporto ${(plainBytes / gzipBytes).toFixed(1)}×)`);
assert.ok(gzipBytes < LIMIT, "payload compresso entro il limite Vercel");

// Il percorso di decompressione del server deve restituire i dati intatti.
const roundTrip = JSON.parse(
  gunzipSync(gzipSync(Buffer.from(JSON.stringify({ runs: payload })))).toString("utf8"),
) as { runs: RunResult[] };
assert.equal(roundTrip.runs.length, payload.length, "round-trip gzip integro");
assert.equal(roundTrip.runs[0].audits.length, payload[0].audits.length, "audit integri dopo gzip");
console.log("  round-trip gzip verificato");

/* 5. Generazione Excel ------------------------------------------------ */

section("Generazione Excel");
const workbook = buildAuditWorkbook({
  runs: payload,
  templates: [],
  competitors: [],
  formFactor: "PHONE",
});
const buffer = await workbook.xlsx.writeBuffer();
const outPath = join(here, "..", "smoke-output.xlsx");
writeFileSync(outPath, Buffer.from(buffer as ArrayBuffer));
console.log(`scritto ${outPath} (${(Buffer.byteLength(Buffer.from(buffer as ArrayBuffer)) / 1024).toFixed(0)} KiB)`);

// Rileggiamo il file: se exceljs lo riapre, Excel lo aprirà.
const reread = new ExcelJS.Workbook();
await reread.xlsx.readFile(outPath);
const expectedSheets = [
  "Template (dati reali)",
  "Piano d'azione",
  "Riepilogo pagine",
  "Dettaglio per pagina",
  "Risorse da correggere",
  "Dati reali utenti (CrUX)",
  "Metodologia",
];
for (const name of expectedSheets) {
  const sheet = reread.getWorksheet(name);
  assert.ok(sheet, `foglio "${name}" presente`);
  assert.ok(sheet.rowCount > 1, `foglio "${name}" popolato`);
  console.log(`  ${name.padEnd(26)} ${sheet.rowCount - 1} righe · ${sheet.columnCount} colonne`);
}

// Il primo intervento del piano deve corrispondere alla prima riga del foglio.
const planSheet = reread.getWorksheet("Piano d'azione")!;
const firstTitle = planSheet.getRow(2).getCell(5).value;
assert.equal(firstTitle, plan.items[0].title, "prima riga allineata al piano");
console.log(`  prima azione nel file: "${String(firstTitle).slice(0, 60)}"`);

section("Tutti i controlli superati");

/**
 * Controlla a occhio il raggruppamento per template su sitemap reali.
 * Uso: npx tsx scripts/template-check.mts [url-sitemap ...]
 */
import { groupByTemplate, sampleSize } from "@/lib/templates";

const DEFAULTS = [
  "https://vercel.com/sitemap.xml",
  "https://www.smashingmagazine.com/sitemap.xml",
];

const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)]
    .map((m) => m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim())
    .filter((u) => /^https?:\/\//i.test(u));
}

for (const target of targets) {
  console.log(`\n${"═".repeat(78)}\n${target}`);

  let urls: string[] = [];
  try {
    const xml = await (await fetch(target)).text();
    const locs = extractLocs(xml);
    if (/<sitemapindex[\s>]/i.test(xml)) {
      // È un indice: scendiamo nelle prime sotto-sitemap.
      for (const child of locs.slice(0, 3)) {
        const childXml = await (await fetch(child)).text();
        urls.push(...extractLocs(childXml));
      }
    } else {
      urls = locs;
    }
  } catch (error) {
    console.log(`  impossibile leggere la sitemap: ${String(error)}`);
    continue;
  }

  urls = [...new Set(urls)].slice(0, 500);
  const templates = groupByTemplate(urls, { samplesPerTemplate: 3 });

  console.log(
    `${urls.length} URL → ${templates.length} template → ${sampleSize(templates)} analisi (${(
      (sampleSize(templates) / urls.length) * 100
    ).toFixed(0)}% del totale)\n`,
  );

  console.log("  URL  pattern                                   etichetta");
  for (const t of templates.slice(0, 18)) {
    console.log(
      `  ${String(t.urls.length).padStart(4)}  ${t.pattern.slice(0, 42).padEnd(42)} ${t.label}`,
    );
  }
  if (templates.length > 18) {
    const rest = templates.slice(18);
    console.log(
      `  … altri ${rest.length} template per ${rest.reduce((s, t) => s + t.urls.length, 0)} URL`,
    );
  }

  const biggest = templates[0];
  console.log(`\n  campione del template più grande (${biggest.pattern}):`);
  for (const url of biggest.sample) console.log(`    ${url}`);
}

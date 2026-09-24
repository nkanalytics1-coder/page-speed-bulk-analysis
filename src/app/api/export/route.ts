import { gunzipSync } from "node:zlib";
import { NextResponse } from "next/server";
import { buildAuditWorkbook, type CompetitorExport } from "@/lib/excel";
import { PAYLOAD_ENCODING_HEADER } from "@/lib/export-payload";
import type { TemplateSummary } from "@/lib/template-summary";
import type { RunResult } from "@/lib/types";

interface ExportBody {
  runs?: unknown;
  templates?: unknown;
  competitors?: unknown;
  formFactor?: unknown;
  site?: unknown;
}

export const runtime = "nodejs";
export const maxDuration = 60;

/** Tetto sul corpo decompresso, per non farsi saturare la memoria. */
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get(PAYLOAD_ENCODING_HEADER) !== "gzip") {
    return await request.json();
  }
  const compressed = Buffer.from(await request.arrayBuffer());
  const raw = gunzipSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  return JSON.parse(raw.toString("utf8"));
}

export async function POST(request: Request) {
  let body: ExportBody;
  try {
    body = (await readBody(request)) as ExportBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Corpo della richiesta non valido." },
      { status: 400 },
    );
  }

  const runs = Array.isArray(body.runs) ? (body.runs as RunResult[]) : [];
  const templates = Array.isArray(body.templates)
    ? (body.templates as TemplateSummary[])
    : [];
  const competitors = Array.isArray(body.competitors)
    ? (body.competitors as CompetitorExport[])
    : [];

  // L'export ha senso anche con la sola scansione dei dati di campo: la
  // diagnosi Lighthouse è un passaggio facoltativo e successivo.
  if (runs.length === 0 && templates.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Nessun risultato da esportare." },
      { status: 400 },
    );
  }

  const workbook = buildAuditWorkbook({
    runs,
    templates,
    competitors,
    formFactor: typeof body.formFactor === "string" ? body.formFactor : "PHONE",
  });
  const buffer = await workbook.xlsx.writeBuffer();

  const site =
    typeof body.site === "string" && body.site
      ? body.site.replace(/[^a-z0-9.-]/gi, "-").slice(0, 40)
      : "sito";
  const date = new Date().toISOString().slice(0, 10);
  const filename = `velocita-${site}-${date}.xlsx`;

  return new NextResponse(new Uint8Array(buffer as ArrayBuffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

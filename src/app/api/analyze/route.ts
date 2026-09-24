import { NextResponse } from "next/server";
import { PsiError, fetchPsi, normalizeRun } from "@/lib/psi";
import type { AnalyzeResponse, Strategy } from "@/lib/types";

export const runtime = "nodejs";
/** Una singola analisi PSI può richiedere 30-50s: serve il massimo su Vercel. */
export const maxDuration = 60;

/** Lasciamo un margine sotto maxDuration per restituire un errore pulito. */
const PSI_TIMEOUT_MS = 55_000;

function badRequest(message: string): NextResponse<AnalyzeResponse> {
  return NextResponse.json(
    { ok: false, error: message, status: 400, retryable: false },
    { status: 400 },
  );
}

export async function POST(request: Request) {
  let body: { url?: unknown; strategy?: unknown; locale?: unknown };
  try {
    body = await request.json();
  } catch {
    return badRequest("Corpo della richiesta non valido.");
  }

  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (!rawUrl) return badRequest("URL mancante.");

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return badRequest(`URL non valido: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return badRequest("Sono ammessi solo URL http e https.");
  }

  const strategy: Strategy = body.strategy === "desktop" ? "desktop" : "mobile";
  const locale = typeof body.locale === "string" ? body.locale : "it";
  const apiKey = process.env.PAGESPEED_API_KEY;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PSI_TIMEOUT_MS);

  try {
    const response = await fetchPsi(
      parsed.toString(),
      strategy,
      locale,
      apiKey,
      controller.signal,
    );
    const result = normalizeRun(response, parsed.toString(), strategy);
    return NextResponse.json({ ok: true, result } satisfies AnalyzeResponse);
  } catch (error) {
    if (error instanceof PsiError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          status: error.status,
          retryable: error.retryable,
        } satisfies AnalyzeResponse,
        // 502: il fallimento è a monte, non nella nostra richiesta.
        { status: error.status === 400 ? 400 : 502 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Errore inatteso in analisi.",
        status: null,
        retryable: true,
      } satisfies AnalyzeResponse,
      { status: 500 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

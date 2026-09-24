import { NextResponse } from "next/server";
import { queryCrux } from "@/lib/crux";
import type { CruxOutcome, FormFactor } from "@/lib/crux";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Quante URL per richiesta. CrUX risponde in meno di un secondo, quindi un
 * blocco da 40 sta comodamente dentro i 60 secondi della funzione anche
 * contando il ripiego sull'origin, che raddoppia le chiamate.
 */
const MAX_BATCH = 40;

/**
 * Richieste CrUX contemporanee dentro un singolo blocco. La quota è di 150
 * query al minuto: con 10 in parallelo e risposte sotto il secondo restiamo
 * sotto il limite senza rallentare.
 */
const CONCURRENCY = 10;

const REQUEST_TIMEOUT_MS = 50_000;

interface Target {
  url: string;
  formFactor: FormFactor;
}

function parseTargets(value: unknown): Target[] {
  if (!Array.isArray(value)) return [];
  const targets: Target[] = [];

  for (const entry of value.slice(0, MAX_BATCH)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { url, formFactor } = entry as { url?: unknown; formFactor?: unknown };
    if (typeof url !== "string") continue;

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      targets.push({
        url: parsed.toString(),
        formFactor: formFactor === "DESKTOP" ? "DESKTOP" : "PHONE",
      });
    } catch {
      // URL non valido: lo scartiamo silenziosamente, il client lo vedrà mancante
    }
  }

  return targets;
}

/** Esegue le richieste a gruppi, per non superare la quota al minuto. */
async function runPool(
  targets: Target[],
  worker: (target: Target) => Promise<CruxOutcome>,
): Promise<CruxOutcome[]> {
  const results: CruxOutcome[] = new Array(targets.length);
  let cursor = 0;

  const runners = Array.from(
    { length: Math.min(CONCURRENCY, targets.length) },
    async () => {
      while (cursor < targets.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(targets[index]);
      }
    },
  );

  await Promise.all(runners);
  return results;
}

export async function POST(request: Request) {
  const apiKey = process.env.PAGESPEED_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Chiave API non configurata: l'API CrUX la richiede sempre, anche per una sola richiesta.",
      },
      { status: 503 },
    );
  }

  let body: { targets?: unknown; allowOriginFallback?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Corpo della richiesta non valido." },
      { status: 400 },
    );
  }

  const targets = parseTargets(body.targets);
  if (targets.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Nessuna URL valida da interrogare." },
      { status: 400 },
    );
  }

  const allowOriginFallback = body.allowOriginFallback !== false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const outcomes = await runPool(targets, (target) =>
      queryCrux(target.url, target.formFactor, apiKey, {
        allowOriginFallback,
        signal: controller.signal,
      }),
    );

    return NextResponse.json({
      ok: true,
      results: outcomes.filter((o) => o.ok).map((o) => (o.ok ? o.result : null)),
      misses: outcomes.filter((o) => !o.ok).map((o) => (o.ok ? null : o.miss)),
    });
  } finally {
    clearTimeout(timeout);
  }
}

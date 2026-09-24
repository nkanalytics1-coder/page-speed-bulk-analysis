import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Tetto agli URL restituiti: oltre, l'analisi diventa ingestibile e costosa. */
const MAX_URLS = 300;
/** Quante sotto-sitemap seguire da un indice. */
const MAX_CHILD_SITEMAPS = 10;
const FETCH_TIMEOUT_MS = 10_000;

const USER_AGENT =
  "Mozilla/5.0 (compatible; LighthouseBatchAudit/1.0; +https://vercel.com)";

/**
 * L'endpoint scarica URL forniti dal client, quindi è una potenziale leva SSRF.
 * Blocchiamo loopback e spazi di indirizzamento privati: una sitemap legittima
 * non vive mai lì.
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "[::1]" || host === "::1") return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

function assertSafeUrl(value: string): URL {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Sono ammessi solo URL http e https.");
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error("Host non consentito.");
  }
  return parsed;
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractLocs(xml: string): string[] {
  const matches = xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi);
  const out: string[] = [];
  for (const match of matches) {
    const value = match[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&")
      .trim();
    if (value) out.push(value);
  }
  return out;
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

/** Estrae le direttive `Sitemap:` da un robots.txt. */
function sitemapsFromRobots(robots: string): string[] {
  const out: string[] = [];
  for (const line of robots.split(/\r?\n/)) {
    const match = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (match) out.push(match[1]);
  }
  return out;
}

async function collectUrls(sitemapUrl: string): Promise<string[]> {
  const xml = await fetchText(sitemapUrl);
  if (!xml) return [];

  const locs = extractLocs(xml);
  if (!isSitemapIndex(xml)) return locs;

  // È un indice: scendiamo di un livello nelle sotto-sitemap.
  const children = locs.slice(0, MAX_CHILD_SITEMAPS);
  const results = await Promise.all(
    children.map(async (child) => {
      try {
        assertSafeUrl(child);
      } catch {
        return [];
      }
      const childXml = await fetchText(child);
      return childXml ? extractLocs(childXml) : [];
    }),
  );
  return results.flat();
}

export async function POST(request: Request) {
  let body: { url?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Corpo della richiesta non valido." },
      { status: 400 },
    );
  }

  const raw = typeof body.url === "string" ? body.url.trim() : "";
  if (!raw) {
    return NextResponse.json(
      { ok: false, error: "Indica il dominio o l'URL della sitemap." },
      { status: 400 },
    );
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  let base: URL;
  try {
    base = assertSafeUrl(withProtocol);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "URL non valido.",
      },
      { status: 400 },
    );
  }

  // Candidati in ordine: la sitemap indicata, quelle dichiarate nel robots.txt,
  // infine il percorso convenzionale.
  const candidates: string[] = [];
  if (base.pathname.endsWith(".xml")) {
    candidates.push(base.toString());
  } else {
    const robots = await fetchText(new URL("/robots.txt", base).toString());
    if (robots) candidates.push(...sitemapsFromRobots(robots));
    candidates.push(new URL("/sitemap.xml", base).toString());
    candidates.push(new URL("/sitemap_index.xml", base).toString());
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    let safe: URL;
    try {
      safe = assertSafeUrl(candidate);
    } catch {
      continue;
    }

    const urls = await collectUrls(safe.toString());
    for (const url of urls) {
      if (seen.size >= MAX_URLS) break;
      if (/^https?:\/\//i.test(url)) seen.add(url);
    }
    if (seen.size > 0) {
      return NextResponse.json({
        ok: true,
        sitemap: safe.toString(),
        urls: [...seen],
        truncated: seen.size >= MAX_URLS,
      });
    }
  }

  return NextResponse.json(
    {
      ok: false,
      error:
        "Nessuna sitemap trovata. Prova a incollare direttamente l'URL del file .xml.",
    },
    { status: 404 },
  );
}

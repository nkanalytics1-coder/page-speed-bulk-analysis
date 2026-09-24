/**
 * Raggruppa le URL di un sito per template e ne campiona alcune per gruppo.
 *
 * Le pagine costruite dallo stesso template (schede prodotto, categorie,
 * articoli) hanno quasi sempre gli stessi problemi, perché il problema sta nel
 * template, non nella singola pagina. Analizzarne 3-5 per gruppo dà le stesse
 * informazioni di analizzarle tutte, e una correzione sul template le sistema
 * tutte insieme.
 *
 * Il raggruppamento non usa regole scritte a mano: costruisce l'albero dei
 * percorsi e collassa in `*` i punti dove compaiono troppi valori diversi.
 * È quello che distingue `/blog/primo-post`, `/blog/secondo-post`, … (un solo
 * template) da `/chi-siamo` e `/contatti` (due pagine uniche).
 */

/** Minimo di valori distinti perché un segmento possa essere variabile. */
const COLLAPSE_MIN_DISTINCT = 5;

/**
 * Quota di valori distinti sul totale delle URL che passano da quel punto,
 * oltre la quale il segmento è considerato variabile.
 *
 * È questo rapporto a distinguere un identificativo da una sezione: sotto
 * `/blog` ci sono 50 slug diversi per 50 URL (rapporto 1, variabile), mentre
 * alla radice ci sono 20 sezioni per 500 URL (rapporto 0,04, fisse). Contare
 * solo i valori distinti confonderebbe i due casi.
 */
const COLLAPSE_MIN_RATIO = 0.5;

/**
 * Oltre questo numero, le pagine con percorso unico vengono raccolte in un
 * gruppo solo. Sono il residuo lungo di ogni sito — pagine istituzionali,
 * landing, documenti sparsi — e tenerle una per una vanificherebbe il
 * campionamento.
 */
const SINGLETON_MERGE_THRESHOLD = 5;

/** Pattern convenzionale del gruppo che raccoglie le pagine uniche. */
export const SINGLETON_PATTERN = "(pagine singole)";

/** Un segmento tutto numerico non distingue mai un template: è una data o un id. */
function isNumericSegment(segment: string): boolean {
  return /^\d+$/.test(segment);
}

/**
 * Tipi di pagina proposti all'utente.
 *
 * Il tipo non serve al calcolo: serve a chi legge il report. "Tutte le schede
 * prodotto falliscono l'LCP" è una frase su cui si agisce, "il template /p/*
 * fallisce" no. Lo strumento lo indovina dall'URL e lascia correggere, perché
 * dal percorso non è sempre deducibile.
 */
export const PAGE_TYPES = [
  "Home",
  "Scheda prodotto",
  "Categoria / listing",
  "Articolo / blog",
  "Landing page",
  "Checkout / carrello",
  "Ricerca",
  "Documentazione",
  "Istituzionale",
  "Archivio (tag, autore)",
  "Altro",
] as const;

export type PageType = (typeof PAGE_TYPES)[number];

/** Quanto conta, per il business, che questo tipo di pagina sia veloce. */
export const IMPORTANCE_LEVELS = ["Alta", "Media", "Bassa"] as const;

export type Importance = (typeof IMPORTANCE_LEVELS)[number];

/**
 * Moltiplicatori applicati al punteggio di priorità.
 *
 * Servono a distinguere un secondo perso sul checkout da un secondo perso su
 * un archivio di tag: Lighthouse li tratta uguali, il fatturato no.
 */
export const IMPORTANCE_MULTIPLIERS: Record<Importance, number> = {
  Alta: 1.5,
  Media: 1,
  Bassa: 0.5,
};

/**
 * Importanza proposta per ciascun tipo di pagina.
 *
 * È un punto di partenza ragionevole per un sito che vende, non una verità:
 * su un editoriale l'articolo vale quanto la home. Va corretta dall'utente,
 * che è l'unico a sapere da dove arrivano i suoi soldi.
 */
export const DEFAULT_IMPORTANCE: Record<PageType, Importance> = {
  Home: "Alta",
  "Scheda prodotto": "Alta",
  "Categoria / listing": "Alta",
  "Checkout / carrello": "Alta",
  "Landing page": "Alta",
  "Articolo / blog": "Media",
  Ricerca: "Media",
  Documentazione: "Media",
  Istituzionale: "Bassa",
  "Archivio (tag, autore)": "Bassa",
  Altro: "Media",
};

/** Segmenti di percorso che rivelano il tipo di pagina. */
const SEGMENT_TYPES: Record<string, PageType> = {
  prodotto: "Scheda prodotto",
  prodotti: "Scheda prodotto",
  product: "Scheda prodotto",
  products: "Scheda prodotto",
  p: "Scheda prodotto",
  dp: "Scheda prodotto",
  annuncio: "Scheda prodotto",
  annunci: "Categoria / listing",
  categoria: "Categoria / listing",
  categorie: "Categoria / listing",
  category: "Categoria / listing",
  collections: "Categoria / listing",
  collection: "Categoria / listing",
  shop: "Categoria / listing",
  c: "Categoria / listing",
  blog: "Articolo / blog",
  news: "Articolo / blog",
  notizie: "Articolo / blog",
  articolo: "Articolo / blog",
  articoli: "Articolo / blog",
  post: "Articolo / blog",
  magazine: "Articolo / blog",
  changelog: "Articolo / blog",
  guide: "Documentazione",
  guida: "Documentazione",
  docs: "Documentazione",
  doc: "Documentazione",
  documentazione: "Documentazione",
  kb: "Documentazione",
  help: "Documentazione",
  supporto: "Documentazione",
  tag: "Archivio (tag, autore)",
  tags: "Archivio (tag, autore)",
  autore: "Archivio (tag, autore)",
  author: "Archivio (tag, autore)",
  archivio: "Archivio (tag, autore)",
  search: "Ricerca",
  ricerca: "Ricerca",
  cerca: "Ricerca",
  checkout: "Checkout / carrello",
  carrello: "Checkout / carrello",
  cart: "Checkout / carrello",
  ordine: "Checkout / carrello",
  servizi: "Landing page",
  servizio: "Landing page",
  services: "Landing page",
  chi_siamo: "Istituzionale",
  "chi-siamo": "Istituzionale",
  about: "Istituzionale",
  contatti: "Istituzionale",
  contact: "Istituzionale",
  legal: "Istituzionale",
  privacy: "Istituzionale",
};

/** Etichette descrittive, usate quando il tipo non è deducibile. */
const SEGMENT_LABELS: Record<string, string> = {
  prodotto: "Scheda prodotto",
  prodotti: "Scheda prodotto",
  product: "Scheda prodotto",
  products: "Scheda prodotto",
  categoria: "Categoria",
  categorie: "Categoria",
  category: "Categoria",
  collections: "Categoria",
  collection: "Categoria",
  blog: "Articolo",
  news: "Articolo",
  notizie: "Articolo",
  articolo: "Articolo",
  articoli: "Articolo",
  post: "Articolo",
  magazine: "Articolo",
  docs: "Documentazione",
  documentazione: "Documentazione",
  tag: "Tag",
  autore: "Autore",
  author: "Autore",
  search: "Ricerca",
  ricerca: "Ricerca",
};

/** Tipo di pagina dedotto dal percorso, da confermare o correggere. */
function suggestType(pattern: string): PageType {
  if (pattern === "/") return "Home";
  // Il gruppo residuo mette insieme pagine di natura diversa: qualsiasi tipo
  // gli si attribuisse sarebbe un'ipotesi non giustificata.
  if (pattern === SINGLETON_PATTERN) return "Altro";

  for (const part of pattern.split("/").filter(Boolean)) {
    if (part === "*") continue;
    const known = SEGMENT_TYPES[part.toLowerCase()];
    if (known) return known;
  }
  return "Altro";
}

export interface Template {
  /** Percorso normalizzato, es. "/blog/*". */
  pattern: string;
  /** Nome leggibile, es. "Articolo" o "Sezione /blog". */
  label: string;
  /** Tipo di pagina dedotto dal percorso, modificabile dall'utente. */
  suggestedType: PageType;
  /** Tutte le URL che ricadono in questo template. */
  urls: string[];
  /** Le URL scelte per l'analisi. */
  sample: string[];
}

interface TrieNode {
  children: Map<string, TrieNode>;
  /** URL che terminano esattamente qui. */
  terminal: string[];
  /** Quante URL attraversano questo nodo, incluse quelle nei rami sottostanti. */
  subtreeCount: number;
}

function newNode(): TrieNode {
  return { children: new Map(), terminal: [], subtreeCount: 0 };
}

/** Vero quando i figli di questo nodo sono identificativi, non sezioni. */
function childrenAreVariable(node: TrieNode): boolean {
  if (node.children.size < COLLAPSE_MIN_DISTINCT) return false;
  if (node.subtreeCount === 0) return false;
  return node.children.size / node.subtreeCount >= COLLAPSE_MIN_RATIO;
}

function segmentsOf(url: string): string[] {
  try {
    const { pathname } = new URL(url);
    return pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Percorre l'albero e costruisce il pattern di una URL, sostituendo con `*`
 * i segmenti che al loro livello hanno troppi fratelli diversi.
 */
function patternFor(root: TrieNode, segments: string[]): string {
  const parts: string[] = [];
  let node: TrieNode | undefined = root;

  for (const segment of segments) {
    if (!node) break;
    const variable = isNumericSegment(segment) || childrenAreVariable(node);
    parts.push(variable ? "*" : segment);
    node = node.children.get(segment);
  }

  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function labelFor(pattern: string, urlCount: number): string {
  if (pattern === "/") return "Home";
  if (pattern === SINGLETON_PATTERN) return "Pagine singole";

  const parts = pattern.split("/").filter(Boolean);
  // L'etichetta viene dal primo segmento fisso riconoscibile.
  for (const part of parts) {
    if (part === "*") continue;
    const known = SEGMENT_LABELS[part.toLowerCase()];
    if (known) return known;
  }

  const first = parts.find((part) => part !== "*");
  // Nessun segmento fisso: è un template di dettaglio, tipicamente articoli
  // con la data nel percorso o schede identificate da un codice.
  if (!first) {
    return `Pagine di dettaglio (${parts.length} livell${parts.length === 1 ? "o" : "i"})`;
  }

  // Una sola URL: è una pagina a sé, non un template.
  if (urlCount === 1 && !pattern.includes("*")) {
    return `Pagina /${parts.join("/")}`;
  }
  return `Sezione /${first}`;
}

export interface GroupOptions {
  /** Quante URL analizzare per ciascun template. */
  samplesPerTemplate?: number;
}

/**
 * Sceglie le URL rappresentative di un gruppo.
 *
 * Prende sempre la più corta, che nei siti reali è quasi sempre la pagina
 * canonica o di indice, poi distribuisce le altre uniformemente sull'elenco
 * ordinato per non pescarle tutte dalla stessa zona del sito.
 */
function pickSample(urls: string[], count: number): string[] {
  if (urls.length <= count) return [...urls];

  const sorted = [...urls].sort(
    (a, b) => a.length - b.length || a.localeCompare(b, "it"),
  );
  const picked = [sorted[0]];
  const rest = sorted.slice(1);
  const step = rest.length / (count - 1);

  for (let i = 0; i < count - 1; i += 1) {
    const candidate = rest[Math.min(rest.length - 1, Math.floor(i * step))];
    if (candidate && !picked.includes(candidate)) picked.push(candidate);
  }

  // Lo step può produrre duplicati su elenchi corti: completiamo in ordine.
  for (const url of rest) {
    if (picked.length >= count) break;
    if (!picked.includes(url)) picked.push(url);
  }

  return picked;
}

export function groupByTemplate(
  urls: string[],
  options: GroupOptions = {},
): Template[] {
  const samplesPerTemplate = Math.max(1, options.samplesPerTemplate ?? 3);

  const root = newNode();
  const parsed: { url: string; segments: string[] }[] = [];

  for (const url of urls) {
    const segments = segmentsOf(url);
    parsed.push({ url, segments });

    let node = root;
    node.subtreeCount += 1;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (!child) {
        child = newNode();
        node.children.set(segment, child);
      }
      child.subtreeCount += 1;
      node = child;
    }
    node.terminal.push(url);
  }

  const groups = new Map<string, string[]>();
  for (const { url, segments } of parsed) {
    const pattern = patternFor(root, segments);
    const bucket = groups.get(pattern);
    if (bucket) bucket.push(url);
    else groups.set(pattern, [url]);
  }

  // Le pagine dal percorso unico, se sono tante, finiscono in un gruppo solo.
  const singletons = [...groups.entries()].filter(
    ([pattern, list]) => list.length === 1 && pattern !== "/",
  );
  if (singletons.length > SINGLETON_MERGE_THRESHOLD) {
    const merged: string[] = [];
    for (const [pattern, list] of singletons) {
      merged.push(...list);
      groups.delete(pattern);
    }
    groups.set(SINGLETON_PATTERN, merged);
  }

  const templates: Template[] = [...groups.entries()].map(([pattern, list]) => {
    const unique = [...new Set(list)].sort((a, b) => a.localeCompare(b, "it"));
    // Il gruppo residuo è eterogeneo: merita qualche campione in più.
    const quota =
      pattern === SINGLETON_PATTERN
        ? Math.max(samplesPerTemplate, 5)
        : samplesPerTemplate;
    return {
      pattern,
      label: labelFor(pattern, unique.length),
      suggestedType: suggestType(pattern),
      urls: unique,
      sample: pickSample(unique, quota),
    };
  });

  // I template più numerosi per primi: sono quelli dove una correzione rende di più.
  templates.sort(
    (a, b) => b.urls.length - a.urls.length || a.pattern.localeCompare(b.pattern),
  );

  return templates;
}

/** Numero totale di URL da analizzare con il campionamento corrente. */
export function sampleSize(templates: Template[]): number {
  return templates.reduce((sum, template) => sum + template.sample.length, 0);
}

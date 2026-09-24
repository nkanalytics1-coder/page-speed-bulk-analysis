/**
 * Cache dei risultati nel browser, su IndexedDB.
 *
 * Rianalizzare la stessa URL entro poche ore non ha senso: i dati CrUX si
 * aggiornano una volta al giorno e coprono una finestra di 28 giorni, e una
 * scansione Lighthouse costa 30 secondi e una fetta di quota. La cache vive
 * solo su questo browser e non viene mai inviata al server.
 */

const DB_NAME = "lighthouse-batch-audit";
const DB_VERSION = 1;
const STORE = "results";

/** I dati CrUX cambiano al massimo una volta al giorno. */
export const CRUX_TTL_MS = 24 * 60 * 60 * 1000;

/** Le scansioni Lighthouse sono costose: le teniamo più a lungo. */
export const LIGHTHOUSE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheRecord<T> {
  key: string;
  value: T;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // In navigazione privata o con i dati dei siti bloccati l'apertura può
      // fallire subito: la cache diventa semplicemente inattiva.
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return dbPromise;
}

function promisify<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

export function cruxKey(url: string, formFactor: string): string {
  return `crux:${formFactor}:${url}`;
}

export function lighthouseKey(url: string, strategy: string): string {
  return `lh:${strategy}:${url}`;
}

export async function cacheGet<T>(
  key: string,
  ttlMs: number,
): Promise<{ value: T; savedAt: number } | null> {
  const db = await openDb();
  if (!db) return null;

  try {
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    const record = (await promisify(store.get(key))) as CacheRecord<T> | null;
    if (!record) return null;
    if (Date.now() - record.savedAt > ttlMs) return null;
    return { value: record.value, savedAt: record.savedAt };
  } catch {
    return null;
  }
}

export async function cacheSet<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  if (!db) return;

  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    store.put({ key, value, savedAt: Date.now() } satisfies CacheRecord<T>);
  } catch {
    // Quota del browser esaurita o store non disponibile: proseguiamo senza cache.
  }
}

export async function cacheClear(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction(STORE, "readwrite").objectStore(STORE).clear();
  } catch {
    // niente da fare: la cache resta com'è
  }
}

export async function cacheStats(): Promise<{ entries: number }> {
  const db = await openDb();
  if (!db) return { entries: 0 };
  try {
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    const count = await promisify(store.count());
    return { entries: count ?? 0 };
  } catch {
    return { entries: 0 };
  }
}

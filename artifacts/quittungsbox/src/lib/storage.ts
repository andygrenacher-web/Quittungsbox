// IndexedDB persistence for Quittungsbox receipts.

const DB_NAME    = "quittungsbox";
const DB_VERSION = 1;
const STORE      = "receipts";

export interface ReceiptRecord {
  id?: number;
  fileName:    string;
  folder:      string;      // e.g. "Archiv/2026/05 Mai" or "Prüfen/Kein Datum"
  pdfBlob:     Blob;
  createdAt:   string;      // ISO timestamp
  receiptDate: string | null; // YYYY-MM-DD from OCR
  amount:      string | null;
  paymentType: "Bar" | "Karte";
  ocrFailed:   boolean;
}

const MONTHS_DE = ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];

export function getFolder(receiptDate: string | null, ocrFailed: boolean): string {
  if (ocrFailed)      return "Prüfen/OCR Fehler";
  if (!receiptDate)   return "Prüfen/Kein Datum";
  const [y, m] = receiptDate.split("-");
  const mIdx = Math.max(0, parseInt(m) - 1);
  return `Archiv/${y}/${m} ${MONTHS_DE[mIdx]}`;
}

// ── DB helpers ─────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        s.createIndex("folder",    "folder",    { unique: false });
        s.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror   = ()  => reject(req.error);
  });
}

// ── public API ─────────────────────────────────────────────

export async function saveReceipt(record: Omit<ReceiptRecord, "id">): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readwrite").objectStore(STORE).add(record);
    req.onsuccess = () => resolve(req.result as number);
    req.onerror   = () => reject(req.error);
  });
}

export async function getAllReceipts(): Promise<ReceiptRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as ReceiptRecord[]);
    req.onerror   = () => reject(req.error);
  });
}

export async function deleteReceipt(id: number): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

export async function getPruefenCount(): Promise<number> {
  const all = await getAllReceipts();
  return all.filter(r => r.folder.startsWith("Prüfen")).length;
}

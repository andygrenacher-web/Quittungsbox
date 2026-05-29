// Unified storage layer.
// On Android (Capacitor native):
//   – PDFs   → Capacitor Filesystem  (Documents/Quittungsbox/…)
//   – Meta   → Capacitor Preferences (JSON array)
// On web / Replit PWA:
//   – everything stays in IndexedDB (original behaviour)

import { isNative } from "./platform";

// ── shared types ────────────────────────────────────────────────────────────

const MONTHS_DE = [
  "Januar","Februar","März","April","Mai","Juni",
  "Juli","August","September","Oktober","November","Dezember",
];

export interface ReceiptRecord {
  id:          string;
  fileName:    string;
  folder:      string;      // e.g. "Archiv/2026/05 Mai" or "Prüfen/Kein Datum"
  pdfBlob?:    Blob;        // present immediately on web; lazy on Android
  createdAt:   string;      // ISO timestamp
  receiptDate: string | null;
  amount:      string | null;
  paymentType: "Bar" | "Karte";
  ocrFailed:   boolean;
}

export function getFolder(receiptDate: string | null, ocrFailed: boolean): string {
  if (ocrFailed)    return "Prüfen/OCR Fehler";
  if (!receiptDate) return "Prüfen/Kein Datum";
  const [y, m] = receiptDate.split("-");
  const mIdx   = Math.max(0, parseInt(m) - 1);
  return `Archiv/${y}/${m} ${MONTHS_DE[mIdx]}`;
}

// ── folder structure initialisation ─────────────────────────────────────────
// Called once on app start. Creates the full visible folder tree in
// Documents/Quittungsbox/ so it appears in Android "Meine Dateien".

export async function initFolderStructure(): Promise<void> {
  if (!isNative()) return;
  const { Filesystem, Directory } = await import("@capacitor/filesystem");

  const year = new Date().getFullYear();
  const folders = [
    "Quittungsbox/Prüfen/Kein Datum",
    "Quittungsbox/Prüfen/Kein Betrag",
    "Quittungsbox/Prüfen/OCR Fehler",
    ...MONTHS_DE.map((name, i) => {
      const m = String(i + 1).padStart(2, "0");
      return `Quittungsbox/Archiv/${year}/${m} ${name}`;
    }),
  ];

  for (const folder of folders) {
    try {
      await Filesystem.mkdir({ path: folder, directory: Directory.Documents, recursive: true });
    } catch { /* folder already exists — ignore */ }
  }
}

// ── public API ───────────────────────────────────────────────────────────────

export async function saveReceipt(record: Omit<ReceiptRecord, "id"> & { pdfBlob: Blob }): Promise<string> {
  if (isNative()) return saveReceiptNative(record);
  return saveReceiptWeb(record);
}

export async function getAllReceipts(): Promise<ReceiptRecord[]> {
  if (isNative()) return getAllReceiptsNative();
  return getAllReceiptsWeb();
}

/** Load the PDF blob for a record. On web the blob is already present;
 *  on Android it reads from the Filesystem on demand. */
export async function loadReceiptBlob(record: ReceiptRecord): Promise<Blob> {
  if (record.pdfBlob) return record.pdfBlob;
  if (isNative()) {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    const result = await Filesystem.readFile({
      path:      `Quittungsbox/${record.folder}/${record.fileName}`,
      directory: Directory.Documents,
    });
    return base64ToBlob(
      typeof result.data === "string" ? result.data : await (result.data as Blob).text(),
      "application/pdf"
    );
  }
  throw new Error("pdfBlob missing from web record");
}

export async function deleteReceipt(id: string): Promise<void> {
  if (isNative()) return deleteReceiptNative(id);
  return deleteReceiptWeb(id);
}

export async function getPruefenCount(): Promise<number> {
  const all = await getAllReceipts();
  return all.filter(r => r.folder.startsWith("Prüfen")).length;
}

// ── Android / Capacitor ──────────────────────────────────────────────────────

const PREF_KEY = "receipts";

interface AndroidMeta {
  id:          string;
  fileName:    string;
  folder:      string;
  createdAt:   string;
  receiptDate: string | null;
  amount:      string | null;
  paymentType: "Bar" | "Karte";
  ocrFailed:   boolean;
}

async function getAndroidMeta(): Promise<AndroidMeta[]> {
  const { Preferences } = await import("@capacitor/preferences");
  const { value } = await Preferences.get({ key: PREF_KEY });
  if (!value) return [];
  try { return JSON.parse(value) as AndroidMeta[]; } catch { return []; }
}

async function setAndroidMeta(list: AndroidMeta[]): Promise<void> {
  const { Preferences } = await import("@capacitor/preferences");
  await Preferences.set({ key: PREF_KEY, value: JSON.stringify(list) });
}

async function saveReceiptNative(record: Omit<ReceiptRecord, "id"> & { pdfBlob: Blob }): Promise<string> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");

  const id       = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const pdfB64   = await blobToBase64(record.pdfBlob);
  const filePath = `Quittungsbox/${record.folder}/${record.fileName}`;

  await Filesystem.writeFile({
    path:      filePath,
    data:      pdfB64,
    directory: Directory.Documents,
    recursive: true,
  });

  const meta   = await getAndroidMeta();
  const newMeta: AndroidMeta = {
    id, fileName: record.fileName, folder: record.folder,
    createdAt: record.createdAt, receiptDate: record.receiptDate,
    amount: record.amount, paymentType: record.paymentType,
    ocrFailed: record.ocrFailed,
  };
  await setAndroidMeta([...meta, newMeta]);
  return id;
}

async function getAllReceiptsNative(): Promise<ReceiptRecord[]> {
  const metas = await getAndroidMeta();
  return metas.map(m => ({ ...m, pdfBlob: undefined }));
}

async function deleteReceiptNative(id: string): Promise<void> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");

  const meta    = await getAndroidMeta();
  const target  = meta.find(m => m.id === id);
  if (target) {
    try {
      await Filesystem.deleteFile({
        path:      `Quittungsbox/${target.folder}/${target.fileName}`,
        directory: Directory.Documents,
      });
    } catch { /* file may already be gone */ }
  }
  await setAndroidMeta(meta.filter(m => m.id !== id));
}

// ── Web / IndexedDB ──────────────────────────────────────────────────────────

const DB_NAME    = "quittungsbox";
const DB_VERSION = 1;
const STORE      = "receipts";

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

async function saveReceiptWeb(record: Omit<ReceiptRecord, "id"> & { pdfBlob: Blob }): Promise<string> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const { id: _id, ...data } = record as ReceiptRecord;
    void _id;
    const req = db.transaction(STORE, "readwrite").objectStore(STORE).add(data);
    req.onsuccess = () => resolve(String(req.result));
    req.onerror   = () => reject(req.error);
  });
}

async function getAllReceiptsWeb(): Promise<ReceiptRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => {
      const rows = req.result as Array<ReceiptRecord & { id: number }>;
      resolve(rows.map(r => ({ ...r, id: String(r.id) })));
    };
    req.onerror = () => reject(req.error);
  });
}

async function deleteReceiptWeb(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readwrite").objectStore(STORE).delete(Number(id));
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(b64: string, mimeType: string): Blob {
  const bytes  = atob(b64);
  const buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
  return new Blob([buffer], { type: mimeType });
}

// Unified storage layer.
//
// Architecture decision — single source of truth:
//   On Android: PDFs live in Documents/Quittungsbox/{folder}/{fileName}.
//               The app SCANS the filesystem on every archive load.
//               No separate Preferences store is needed — the file IS the record.
//               Metadata is reconstructed from path + filename.
//
//   On web: everything stays in IndexedDB (unchanged).
//
// Filename format (never changes — parsing depends on it):
//   {YYYY-MM-DD | unbekannt-{ts}}[_{amount}]_{Bar|Karte}.pdf
//   Examples:
//     2025-03-20_112.80_Bar.pdf
//     2025-03-20_Karte.pdf
//     unbekannt-1234567890_Bar.pdf

import { isNative } from "./platform";

// ── shared types ─────────────────────────────────────────────────────────────

const MONTHS_DE = [
  "Januar","Februar","März","April","Mai","Juni",
  "Juli","August","September","Oktober","November","Dezember",
];

export interface ReceiptRecord {
  id:          string;
  fileName:    string;
  folder:      string;      // e.g. "Archiv/2026/05 Mai" or "Prüfen/Kein Datum"
  pdfBlob?:    Blob;        // present on web (IndexedDB); never on Android (lazy)
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

// ── folder structure initialisation ──────────────────────────────────────────

export async function initFolderStructure(): Promise<void> {
  if (!isNative()) return;
  const { Filesystem, Directory } = await import("@capacitor/filesystem");

  const curr       = new Date().getFullYear();
  const validYears = [curr - 2, curr - 1, curr];

  const monthFolders = validYears.flatMap(year =>
    MONTHS_DE.map((name, i) => {
      const m = String(i + 1).padStart(2, "0");
      return `Quittungsbox/Archiv/${year}/${m} ${name}`;
    })
  );

  for (const folder of [
    "Quittungsbox/Prüfen/Kein Datum",
    "Quittungsbox/Prüfen/Kein Betrag",
    "Quittungsbox/Prüfen/OCR Fehler",
    ...monthFolders,
  ]) {
    try {
      await Filesystem.mkdir({ path: folder, directory: Directory.Documents, recursive: true });
    } catch { /* already exists */ }
  }
}

// ── public API ────────────────────────────────────────────────────────────────

export async function saveReceipt(
  record: Omit<ReceiptRecord, "id"> & { pdfBlob: Blob }
): Promise<string> {
  if (isNative()) return saveReceiptNative(record);
  return saveReceiptWeb(record);
}

export async function getAllReceipts(): Promise<ReceiptRecord[]> {
  if (isNative()) return scanFilesystem();
  return getAllReceiptsWeb();
}

/** Load the PDF blob for a record. On web the blob is in the record; on Android read from disk. */
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

/**
 * Move (rename) a receipt file after background AI improvement.
 * Writes to new path, then deletes the old file.
 * On web: no-op (IndexedDB records don't need moving).
 */
export async function moveReceiptFile(
  fromFolder:   string,
  fromFileName: string,
  toFolder:     string,
  toFileName:   string,
  pdfBlob:      Blob,
): Promise<void> {
  if (!isNative()) return;
  if (fromFolder === toFolder && fromFileName === toFileName) return;

  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const b64 = await blobToBase64(pdfBlob);

  await Filesystem.writeFile({
    path:      `Quittungsbox/${toFolder}/${toFileName}`,
    data:      b64,
    directory: Directory.Documents,
    recursive: true,
  });

  try {
    await Filesystem.deleteFile({
      path:      `Quittungsbox/${fromFolder}/${fromFileName}`,
      directory: Directory.Documents,
    });
  } catch { /* old file may be gone already */ }
}

// ── Android / Filesystem scan ────────────────────────────────────────────────
//
// Walk Documents/Quittungsbox/ up to 5 levels deep.
// Every .pdf file becomes a ReceiptRecord with metadata parsed from its path.
// This means the filesystem IS the archive — there is exactly one copy of each PDF.

async function saveReceiptNative(
  record: Omit<ReceiptRecord, "id"> & { pdfBlob: Blob }
): Promise<string> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const pdfB64 = await blobToBase64(record.pdfBlob);
  await Filesystem.writeFile({
    path:      `Quittungsbox/${record.folder}/${record.fileName}`,
    data:      pdfB64,
    directory: Directory.Documents,
    recursive: true,
  });
  // ID = relative path so it can be used directly for deletion / loading
  return `${record.folder}/${record.fileName}`;
}

async function scanFilesystem(): Promise<ReceiptRecord[]> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const results: ReceiptRecord[] = [];

  async function walkDir(absPath: string, relFolder: string, depth: number): Promise<void> {
    if (depth > 5) return;
    try {
      const { files } = await Filesystem.readdir({ path: absPath, directory: Directory.Documents });
      for (const entry of files) {
        const entryAbs = `${absPath}/${entry.name}`;
        if (entry.type === "file" && entry.name.toLowerCase().endsWith(".pdf")) {
          results.push(parseReceiptRecord(relFolder, entry.name));
        } else if (entry.type === "directory") {
          const childRel = relFolder ? `${relFolder}/${entry.name}` : entry.name;
          await walkDir(entryAbs, childRel, depth + 1);
        }
      }
    } catch { /* skip inaccessible dirs */ }
  }

  await walkDir("Quittungsbox", "", 0);
  return results;
}

/** Reconstruct a ReceiptRecord from folder path + filename alone. */
function parseReceiptRecord(folder: string, fileName: string): ReceiptRecord {
  const base  = fileName.replace(/\.pdf$/i, "");
  const parts = base.split("_");

  // Last segment is always the payment type
  const lastPart    = parts[parts.length - 1] ?? "";
  const paymentType: "Bar" | "Karte" = lastPart === "Karte" ? "Karte" : "Bar";

  // First segment is the date (YYYY-MM-DD) or "unbekannt-{timestamp}"
  let receiptDate: string | null = null;
  if (parts[0] && /^\d{4}-\d{2}-\d{2}$/.test(parts[0])) {
    receiptDate = parts[0];
  }

  // Middle segment (if present and numeric) is the amount
  let amount: string | null = null;
  if (parts.length >= 3) {
    const mid = parts[1];
    if (/^\d+[.,]\d{2}$/.test(mid)) {
      amount = mid.replace(",", ".");
    }
  }

  return {
    id:          `${folder}/${fileName}`,  // stable, path-derived
    fileName,
    folder,
    createdAt:   receiptDate
      ? `${receiptDate}T12:00:00.000Z`
      : new Date().toISOString(),
    receiptDate,
    amount,
    paymentType,
    ocrFailed:   folder.includes("OCR Fehler"),
  };
}

async function deleteReceiptNative(id: string): Promise<void> {
  // id is "folder/fileName" in the scan-based system
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  try {
    await Filesystem.deleteFile({
      path:      `Quittungsbox/${id}`,
      directory: Directory.Documents,
    });
  } catch { /* file may already be gone */ }
}

// ── Web / IndexedDB ───────────────────────────────────────────────────────────

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

async function saveReceiptWeb(
  record: Omit<ReceiptRecord, "id"> & { pdfBlob: Blob }
): Promise<string> {
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
    const req = db
      .transaction(STORE, "readwrite")
      .objectStore(STORE)
      .delete(Number(id));
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve((reader.result as string).split(",")[1]);
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

import Tesseract from "tesseract.js";

export interface OcrResult {
  vendor: string | null;
  amount: string | null;
  receiptDate: string | null; // YYYY-MM-DD extracted from receipt, or null
  rawText: string;
  ocrFailed: boolean;
}

// ── date extraction ────────────────────────────────────────
// Supports DD.MM.YYYY, DD.MM.YY, YYYY-MM-DD, DD/MM/YYYY

function extractDate(text: string): string | null {
  // DD.MM.YYYY  or  DD.MM.YY
  const dmy = /\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})\b/g;
  // YYYY-MM-DD
  const ymd = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;

  // ISO first
  for (const m of text.matchAll(ymd)) {
    const [, y, mo, d] = m;
    const date = new Date(+y, +mo - 1, +d);
    if (isValidDate(date)) return `${y}-${mo.padStart(2,"0")}-${d.padStart(2,"0")}`;
  }

  // DD.MM.YYYY / DD.MM.YY
  for (const m of text.matchAll(dmy)) {
    const [, d, mo, yRaw] = m;
    const y = yRaw.length === 2 ? (parseInt(yRaw) < 50 ? "20" : "19") + yRaw : yRaw;
    const date = new Date(+y, +mo - 1, +d);
    if (isValidDate(date)) {
      return `${y}-${mo.padStart(2,"0")}-${d.padStart(2,"0")}`;
    }
  }

  return null;
}

function isValidDate(d: Date): boolean {
  return d instanceof Date && !isNaN(d.getTime()) &&
    d.getFullYear() >= 2000 && d.getFullYear() <= 2099;
}

// ── amount extraction ──────────────────────────────────────
// Priority: lines with total-keywords.  Excluded: quantity/volume lines.

const TOTAL_KW = /\b(Total|Betrag|Summe|Rechnungsbetrag|Gesamtbetrag|Gesamt|Zu\s+bezahlen|Endbetrag|Zahlung|Grand\s+total)\b|(?<!\w)CHF(?!\w)/i;
const EXCL_KW  = /\b(Menge|Liter|Ltr\.?|(?<!\S)l(?!\S)|(?<!\d)l\b|kg\b|Stk\.?|St\.?\b|Anzahl|\/\s*l\b|Grundpreis|Einzel|Literpreis|pro\s+Ltr)/i;
const AMT_RE   = /\b(\d{1,6}[.,]\d{2})\b/;
const AMT_RE_G = /\b(\d{1,6}[.,]\d{2})\b/g;

function parseAmount(raw: string): number {
  return parseFloat(raw.replace(",", "."));
}

function extractAmount(text: string): string | null {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  // Pass 1: total-keyword lines (not excluded)
  for (const line of lines) {
    if (TOTAL_KW.test(line) && !EXCL_KW.test(line)) {
      const m = line.match(AMT_RE);
      if (m) {
        const v = parseAmount(m[1]);
        if (v > 0 && v < 100_000) return v.toFixed(2);
      }
    }
  }

  // Pass 2: all lines except excluded ones — take largest
  const candidates: number[] = [];
  for (const line of lines) {
    if (EXCL_KW.test(line)) continue;
    for (const m of line.matchAll(AMT_RE_G)) {
      const v = parseAmount(m[1]);
      if (v > 0 && v < 100_000) candidates.push(v);
    }
  }
  if (candidates.length) return Math.max(...candidates).toFixed(2);

  // Pass 3: absolutely anything (last resort)
  const all: number[] = [];
  for (const m of text.matchAll(AMT_RE_G)) {
    const v = parseAmount(m[1]);
    if (v > 0 && v < 100_000) all.push(v);
  }
  if (all.length) return Math.max(...all).toFixed(2);

  return null;
}

// ── vendor extraction ──────────────────────────────────────
// Look in first 8 lines for the most "name-like" line

const SKIP_KW = /\b(Quittung|Rechnung|Kassenbon|Kassenzettel|Beleg|Datum|Uhrzeit|Tel|Fax|www\.|http|MwSt|MWST|CHF|Str\.|Strasse|AG\b|GmbH\b|^\d+$)/i;

function extractVendor(text: string): string | null {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  for (const line of lines.slice(0, 8)) {
    // Must contain at least 2 consecutive letters
    if (!/[a-zA-ZäöüÄÖÜéàèâêîôûÉÀÈÂÊÎÔÛ]{2}/.test(line)) continue;
    // Skip obvious non-name lines
    if (SKIP_KW.test(line)) continue;
    // Must not be purely digits / symbols
    const letters = line.replace(/[^a-zA-ZäöüÄÖÜéàèâêîôûÉÀÈÂÊÎÔÛ\s]/g, "").trim();
    if (letters.length < 3) continue;

    // Take up to first 2 meaningful words, cleaned for filename
    const words = letters.split(/\s+/).filter(w => w.length >= 2);
    if (!words.length) continue;

    const name = words.slice(0, 2).join("").replace(/[^a-zA-ZäöüÄÖÜéàèâêîôûÉÀÈÂÊÎÔÛ0-9]/g, "").slice(0, 22);
    if (name.length >= 2) return name;
  }

  return null;
}

// ── parse all ─────────────────────────────────────────────

function parseOcrText(text: string): {
  vendor: string | null;
  amount: string | null;
  receiptDate: string | null;
} {
  return {
    vendor:      extractVendor(text),
    amount:      extractAmount(text),
    receiptDate: extractDate(text),
  };
}

// ── public API ─────────────────────────────────────────────

export async function runOcr(imageBlob: Blob): Promise<OcrResult> {
  try {
    const result = await Tesseract.recognize(imageBlob, "deu+eng", {
      logger: () => {},
    });
    const { vendor, amount, receiptDate } = parseOcrText(result.data.text);
    return { vendor, amount, receiptDate, rawText: result.data.text, ocrFailed: false };
  } catch {
    return { vendor: null, amount: null, receiptDate: null, rawText: "", ocrFailed: true };
  }
}

// ── filename builder ───────────────────────────────────────
// With amount:    YYYY-MM-DD_Betrag_Zahlungsart.pdf
// Without amount: YYYY-MM-DD_Zahlungsart.pdf
// Date: from receipt (OCR) or today's scan date as fallback.

export function buildFileName(
  paymentType: "Bar" | "Karte",
  _vendor: string | null,   // kept for API compatibility, not used in filename
  amount: string | null,
  receiptDate: string | null
): string {
  const now = new Date();
  const scanDate =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const date = receiptDate || scanDate;

  if (amount) {
    return `${date}_${amount}_${paymentType}.pdf`;
  }
  return `${date}_${paymentType}.pdf`;
}

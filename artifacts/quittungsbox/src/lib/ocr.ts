import Tesseract from "tesseract.js";

export interface OcrResult {
  vendor:      string | null;
  amount:      string | null;
  receiptDate: string | null; // YYYY-MM-DD extracted from receipt, or null
  rawText:     string;
  ocrFailed:   boolean;
}

// ── date extraction ─────────────────────────────────────────────────────────
// Handles DD.MM.YYYY, DD.MM.YY, YYYY-MM-DD, DD/MM/YYYY
// Also tolerates spaces Tesseract inserts around separators: "24 . 05 . 2026"

function extractDate(text: string): string | null {
  // Optional whitespace around each separator
  const SEP   = String.raw`\s*[.\-/]\s*`;
  // DD.MM.YYYY  or  DD.MM.YY (with optional spaces)
  const dmyRe = new RegExp(String.raw`\b(\d{1,2})${SEP}(\d{1,2})${SEP}(\d{2,4})\b`, "g");
  // YYYY-MM-DD (strict ISO)
  const ymdRe = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;

  // ISO format first (unambiguous)
  for (const m of text.matchAll(ymdRe)) {
    const [, y, mo, d] = m;
    const dt = new Date(+y, +mo - 1, +d);
    if (isValidDate(dt)) return `${y}-${mo.padStart(2,"0")}-${d.padStart(2,"0")}`;
  }

  // DD.MM.YYYY / DD.MM.YY (most common on Swiss receipts)
  for (const m of text.matchAll(dmyRe)) {
    const [, d, mo, yRaw] = m;
    const y = yRaw.length === 2
      ? (parseInt(yRaw) < 50 ? "20" : "19") + yRaw
      : yRaw;
    // Sanity: month 1–12, day 1–31
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) continue;
    const dt = new Date(+y, +mo - 1, +d);
    if (isValidDate(dt)) return `${y}-${mo.padStart(2,"0")}-${d.padStart(2,"0")}`;
  }

  return null;
}

function isValidDate(d: Date): boolean {
  return d instanceof Date && !isNaN(d.getTime()) &&
    d.getFullYear() >= 2000 && d.getFullYear() <= 2099;
}

// ── amount extraction ───────────────────────────────────────────────────────
// Strategy (in order):
//   Pass 1 — keyword line (Total / CHF / etc.) → LARGEST amount on that line
//   Pass 2 — bottom 40 % of lines (where totals live), non-excluded → largest
//   Pass 3 — all non-excluded lines → largest
//   Pass 4 — last resort: anything → largest
//
// "Largest wins" is intentional: on a receipt the grand total is always ≥
// any sub-amount (unit price, tax, etc.).

const TOTAL_KW = /\b(Total|TOTAL|Betrag|Summe|Rechnungsbetrag|Gesamtbetrag|Gesamt|Endbetrag|Zahlung|Zahlen|Grand\s+total|ZU\s+ZAHLEN|ZU\s+BEZAHLEN|zu\s+bezahlen|zu\s+zahlen|Zu\s+zahlen|BEZAHLT|Bezahlt|Kassiert)\b|(?<!\w)CHF(?!\w)/i;

// Lines that carry quantity / unit prices — amounts here are NOT totals
const EXCL_KW = /\b(Menge|Anzahl|Liter|Ltr\.?|kg|Stk\.?|Einzel|Grundpreis|Literpreis|Einheitspreis|MWST|MwSt)\b|\bpro\s+(kg|l|Ltr|Stk)\b|\/\s*(kg|l|Ltr)\b|\d+\s*[×xX*]\s*\d/i;

// Negative lookahead (?![.\-\/]\d) prevents matching "24.05" inside "24.05.2026"
const AMT_RE  = /\b(\d{1,6}[.,]\d{2})\b(?![.\-\/]\d)/;
const AMT_G   = /\b(\d{1,6}[.,]\d{2})\b(?![.\-\/]\d)/g;

function parseAmt(s: string): number { return parseFloat(s.replace(",", ".")); }

function allAmounts(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(AMT_G)) {
    const v = parseAmt(m[1]);
    if (v > 0.01 && v < 100_000) out.push(v);
  }
  return out;
}

function extractAmount(text: string): string | null {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  // ── Pass 1: keyword line → largest amount on that line ──────────────────
  for (const line of lines) {
    if (!TOTAL_KW.test(line)) continue;
    if (EXCL_KW.test(line)) continue;
    const amts = allAmounts(line);
    if (amts.length) return Math.max(...amts).toFixed(2);
  }

  // ── Pass 2: bottom 40 % of receipt, non-excluded → largest ──────────────
  const tail = lines.slice(Math.floor(lines.length * 0.60));
  const tailCands: number[] = [];
  for (const line of tail) {
    if (EXCL_KW.test(line)) continue;
    tailCands.push(...allAmounts(line));
  }
  if (tailCands.length) return Math.max(...tailCands).toFixed(2);

  // ── Pass 3: any non-excluded line → largest ──────────────────────────────
  const allCands: number[] = [];
  for (const line of lines) {
    if (EXCL_KW.test(line)) continue;
    allCands.push(...allAmounts(line));
  }
  if (allCands.length) return Math.max(...allCands).toFixed(2);

  // No unfiltered fallback — user explicitly prefers no amount over a wrong one.
  // A garbled or missing total → filename without amount (e.g. 2026-05-24_Karte.pdf).
  return null;
}

// ── vendor extraction ────────────────────────────────────────────────────────

const SKIP_KW = /\b(Quittung|Rechnung|Kassenbon|Kassenzettel|Beleg|Datum|Uhrzeit|Tel|Fax|www\.|http|MwSt|MWST|CHF|Str\.|Strasse|AG|GmbH)\b|^\d+$/i;

function extractVendor(text: string): string | null {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    if (!/[a-zA-ZäöüÄÖÜéàèâêîôûÉÀÈÂÊÎÔÛ]{2}/.test(line)) continue;
    if (SKIP_KW.test(line)) continue;
    const letters = line.replace(/[^a-zA-ZäöüÄÖÜéàèâêîôûÉÀÈÂÊÎÔÛ\s]/g, "").trim();
    if (letters.length < 3) continue;
    const words = letters.split(/\s+/).filter(w => w.length >= 2);
    if (!words.length) continue;
    const name = words.slice(0, 2).join("").replace(/[^a-zA-ZäöüÄÖÜéàèâêîôûÉÀÈÂÊÎÔÛ0-9]/g, "").slice(0, 22);
    if (name.length >= 2) return name;
  }
  return null;
}

// ── public parse + API ───────────────────────────────────────────────────────

function parseOcrText(text: string) {
  return {
    vendor:      extractVendor(text),
    amount:      extractAmount(text),
    receiptDate: extractDate(text),
  };
}

export async function runOcr(imageBlob: Blob): Promise<OcrResult> {
  try {
    const result = await Tesseract.recognize(imageBlob, "deu+eng", { logger: () => {} });
    const { vendor, amount, receiptDate } = parseOcrText(result.data.text);
    return { vendor, amount, receiptDate, rawText: result.data.text, ocrFailed: false };
  } catch {
    return { vendor: null, amount: null, receiptDate: null, rawText: "", ocrFailed: true };
  }
}

// ── filename builder ─────────────────────────────────────────────────────────
// YYYY-MM-DD_Betrag_Zahlungsart.pdf   — when date + amount found
// YYYY-MM-DD_Zahlungsart.pdf          — when date found, amount uncertain
// (never uses today's date as receipt date — only as archive fallback in storage.ts)

export function buildFileName(
  paymentType: "Bar" | "Karte",
  _vendor:     string | null,   // kept for API compat, excluded from filename
  amount:      string | null,
  receiptDate: string | null
): string {
  // Use today only when receipt date is genuinely missing
  const now = new Date();
  const scanDate = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");

  const date = receiptDate ?? scanDate;

  return amount
    ? `${date}_${amount}_${paymentType}.pdf`
    : `${date}_${paymentType}.pdf`;
}

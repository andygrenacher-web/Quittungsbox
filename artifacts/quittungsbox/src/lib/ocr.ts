// OCR layer — Tesseract.js on both web and Android.
//
// On Android, Tesseract runs on images that were already perspective-corrected
// and cropped by the ML Kit Document Scanner, giving significantly better
// recognition than running on raw uncorrected photos.

export interface OcrResult {
  vendor:      string | null;
  amount:      string | null;
  receiptDate: string | null; // YYYY-MM-DD, or null
  rawText:     string;
  ocrFailed:   boolean;
}

// ── date extraction ──────────────────────────────────────────────────────────
// Handles DD.MM.YYYY, DD.MM.YY, YYYY-MM-DD, DD/MM/YYYY.
// Allows optional spaces around separators ("24 . 05 . 2026").

function extractDate(text: string): string | null {
  const SEP   = String.raw`\s*[.\-/]\s*`;
  const dmyRe = new RegExp(String.raw`\b(\d{1,2})${SEP}(\d{1,2})${SEP}(\d{2,4})\b`, "g");
  const ymdRe = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;

  for (const m of text.matchAll(ymdRe)) {
    const [, y, mo, d] = m;
    const dt = new Date(+y, +mo - 1, +d);
    if (isValidDate(dt)) return `${y}-${mo.padStart(2,"0")}-${d.padStart(2,"0")}`;
  }

  for (const m of text.matchAll(dmyRe)) {
    const [, d, mo, yRaw] = m;
    const y = yRaw.length === 2
      ? (parseInt(yRaw) < 50 ? "20" : "19") + yRaw
      : yRaw;
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

// ── amount extraction ────────────────────────────────────────────────────────

const TOTAL_KW = /\b(Total|TOTAL|Betrag|Summe|Rechnungsbetrag|Gesamtbetrag|Gesamt|Endbetrag|Zahlung|Zahlen|Grand\s+total|ZU\s+ZAHLEN|ZU\s+BEZAHLEN|zu\s+bezahlen|zu\s+zahlen|Zu\s+zahlen|BEZAHLT|Bezahlt|Kassiert)\b|(?<!\w)CHF(?!\w)/i;
const EXCL_KW  = /\b(Menge|Anzahl|Liter|Ltr\.?|kg|Stk\.?|Einzel|Grundpreis|Literpreis|Einheitspreis|MWST|MwSt)\b|\bpro\s+(kg|l|Ltr|Stk)\b|\/\s*(kg|l|Ltr)\b|\d+\s*[×xX*]\s*\d/i;

// Negative lookahead prevents "24.05" inside "24.05.2026" from matching as amount
const AMT_G = /\b(\d{1,6}[.,]\d{2})\b(?![.\-\/]\d)/g;

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

  // Pass 1: keyword line → largest amount on that line
  for (const line of lines) {
    if (!TOTAL_KW.test(line)) continue;
    if (EXCL_KW.test(line))   continue;
    const amts = allAmounts(line);
    if (amts.length) return Math.max(...amts).toFixed(2);
  }

  // Pass 2: bottom 40 % of receipt, non-excluded → largest
  const tail      = lines.slice(Math.floor(lines.length * 0.60));
  const tailCands = tail.flatMap(l => EXCL_KW.test(l) ? [] : allAmounts(l));
  if (tailCands.length) return Math.max(...tailCands).toFixed(2);

  // Pass 3: any non-excluded line → largest
  const allCands = lines.flatMap(l => EXCL_KW.test(l) ? [] : allAmounts(l));
  if (allCands.length) return Math.max(...allCands).toFixed(2);

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

// ── shared text parser (also exported for tests) ─────────────────────────────

export function parseOcrText(text: string) {
  return {
    vendor:      extractVendor(text),
    amount:      extractAmount(text),
    receiptDate: extractDate(text),
  };
}

// ── public OCR API ───────────────────────────────────────────────────────────
// Tesseract runs on both web and Android.
// On Android, images come pre-corrected from ML Kit Document Scanner so OCR
// quality is significantly better than raw camera shots.

export async function runOcr(imageBlob: Blob): Promise<OcrResult> {
  try {
    const Tesseract = (await import("tesseract.js")).default;
    const result    = await Tesseract.recognize(imageBlob, "deu+eng", { logger: () => {} });
    const { vendor, amount, receiptDate } = parseOcrText(result.data.text);
    return { vendor, amount, receiptDate, rawText: result.data.text, ocrFailed: false };
  } catch {
    return { vendor: null, amount: null, receiptDate: null, rawText: "", ocrFailed: true };
  }
}

// ── filename builder ─────────────────────────────────────────────────────────

export function buildFileName(
  paymentType: "Bar" | "Karte",
  _vendor:     string | null,
  amount:      string | null,
  receiptDate: string | null,
): string {
  const now      = new Date();
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

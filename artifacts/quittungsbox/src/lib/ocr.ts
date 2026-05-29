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
  if (!(d instanceof Date) || isNaN(d.getTime())) return false;
  const y    = d.getFullYear();
  const curr = new Date().getFullYear();
  return y >= curr - 2 && y <= curr;
}

// ── amount extraction ────────────────────────────────────────────────────────

// Highest priority: unambiguous invoice-total lines
const STRONG_TOTAL = /\b(Rechnungstotal|Gesamttotal|Totalbetrag|Gesamtbetrag|Endbetrag|Rechnungsbetrag|Brutto|Bruttobetrag|ZU\s+ZAHLEN|ZU\s+BEZAHLEN|zu\s+bezahlen|zu\s+zahlen|Zu\s+zahlen|Zu\s+bezahlen|dankend\s+erhalten|inkl\.?\s*MWST|inkl\.?\s*MwSt)\b/i;

// Standard total keywords (lower priority than STRONG_TOTAL)
const TOTAL_KW = /\b(Total|Summe|Betrag|Gesamt|Grand\s+total)\b|(?<!\w)CHF(?!\w)/i;

// Lines to EXCLUDE from amount detection.
// ── Cash-flow lines (NOT the invoice amount) ──
//   Rückgeld / Wechselgeld / Retourgeld = change given back
//   Bargeld / Bargeld erhalten / Geldeinwurf = cash tendered by customer
//   Bezahlt / Kassiert = payment tender (can exceed invoice when paying with note)
//   Ausbezahlt / Rückgabe / Retoure = refund / return
// ── Net / pre-tax amounts ──
//   Netto / Warenwert / Grundbetrag = subtotals before tax
// ── Tax component lines ──
//   MWST / USt / Steuer = VAT amount (not the gross total)
// ── Quantities & units ── (prevents picking up weights, litres, etc.)
// ── Unit prices, reference numbers, discounts ──
const EXCL_KW = new RegExp(
  String.raw`\b(` +
    // Cash-flow / change / tender lines
    String.raw`Rückgeld|Wechselgeld|Retourgeld|Ausbezahlt|Rückgabe|Retoure|` +
    String.raw`Geldeinwurf|Bargeld|` +
    String.raw`Bezahlt|Kassiert|` +
    // Net / pre-tax amounts
    String.raw`Netto|Nettobetrag|Nettosumme|Warenwert|Grundbetrag|` +
    // Tax lines
    String.raw`MWST|MwSt|USt|Ust\.|Steuer|` +
    // Quantities & units
    String.raw`Menge|Anzahl|Liter|Ltr\.?|kg|Stk\.?|Stück|` +
    // Unit prices
    String.raw`Einzel|Einzelpreis|Grundpreis|Literpreis|Einheitspreis|` +
    // Tank / fuel
    String.raw`Tankautomat|Zapfpunkt|Zapfsäule|` +
    // Reference numbers
    String.raw`Beleg[-\s]*Nr\.?|Art[-\s]*Nr\.?|Bon[-\s]*Nr\.?|` +
    // Discount / deposit
    String.raw`Rabatt|Pfand` +
  String.raw`)\b` +
  // Unit-price patterns: /l, /kg, pro l
  String.raw`|\bpro\s+(kg|l|Ltr|Stk)\b` +
  String.raw`|\/\s*(kg|l|Ltr)\b` +
  String.raw`|\bPreis\s*\/` +
  // Multiplication: "3 × 4.50"
  String.raw`|\d+\s*[×xX\*]\s*\d`,
  "i"
);

// Negative lookahead prevents "24.05" inside "24.05.2026" from matching as amount
const AMT_G = /\b(\d{1,6}[.,]\d{2})\b(?![.\-\/]\d)/g;

function parseAmt(s: string): number { return parseFloat(s.replace(",", ".")); }

function amountsOnLine(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(AMT_G)) {
    const v = parseAmt(m[1]);
    if (v >= 0.10 && v < 100_000) out.push(v);
  }
  return out;
}

function extractAmount(text: string): string | null {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  // Collect keyword-matching candidates with a priority score:
  //   2 = strong total keyword (Gesamttotal, Zu bezahlen, …)
  //   1 = standard keyword (Total, Betrag, CHF, …)
  interface Candidate { priority: number; amounts: number[] }
  const candidates: Candidate[] = [];

  for (const line of lines) {
    if (EXCL_KW.test(line)) continue;
    const amts = amountsOnLine(line);
    if (!amts.length) continue;

    if (STRONG_TOTAL.test(line)) {
      candidates.push({ priority: 2, amounts: amts });
    } else if (TOTAL_KW.test(line)) {
      candidates.push({ priority: 1, amounts: amts });
    }
  }

  if (candidates.length) {
    // Prefer strong-total lines; among equals take the LAST one
    // (last "Total" line on a receipt is usually the final payable amount).
    const best = candidates.filter(c => c.priority === Math.max(...candidates.map(x => x.priority)));
    const pick = best[best.length - 1];
    return Math.max(...pick.amounts).toFixed(2);
  }

  // Pass 2: bottom 40% of receipt, non-excluded → largest amount.
  // Only use this if we find amounts on at most 3 distinct lines
  // (avoids guessing when the tail is full of item prices).
  const tail      = lines.slice(Math.floor(lines.length * 0.60));
  const tailLines = tail.filter(l => !EXCL_KW.test(l) && amountsOnLine(l).length > 0);
  if (tailLines.length > 0 && tailLines.length <= 4) {
    const allAmts = tailLines.flatMap(l => amountsOnLine(l));
    return Math.max(...allAmts).toFixed(2);
  }

  // Pass 3: too many candidates → don't guess, leave blank
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
// Format: YYYY-MM-DD_Betrag_Zahlungsart.pdf   (when amount known)
//         YYYY-MM-DD_Zahlungsart.pdf           (when amount unknown)
// If no receipt date: use today's scan date and route to Prüfen/Kein Datum.

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

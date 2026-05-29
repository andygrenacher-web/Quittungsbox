import Tesseract from "tesseract.js";

export interface OcrResult {
  vendor: string | null;
  amount: string | null;
  rawText: string;
}

function parseOcrText(text: string): { vendor: string | null; amount: string | null } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Find amounts — match patterns like 87.40, 87,40, CHF 87.40, Fr. 12.50
  const amountRegex = /\b(\d{1,6}[.,]\d{2})\b/g;
  const amounts: number[] = [];
  for (const match of text.matchAll(amountRegex)) {
    const val = parseFloat(match[1].replace(",", "."));
    if (val > 0 && val < 100000) amounts.push(val);
  }
  // Largest amount is most likely the total
  const maxAmount = amounts.length > 0 ? Math.max(...amounts) : null;
  const amountStr = maxAmount !== null ? maxAmount.toFixed(2) : null;

  // Find vendor — first line with at least 2 letters, in first 6 lines
  let vendor: string | null = null;
  for (const line of lines.slice(0, 6)) {
    const onlyLetters = line.replace(/[^a-zA-ZäöüÄÖÜéàèâêîôûÉÀÈÂÊÎÔÛ\s&+\-'.]/g, "").trim();
    if (onlyLetters.length >= 3 && /[a-zA-Z]{2}/.test(onlyLetters)) {
      vendor = onlyLetters
        .split(/\s+/)
        .slice(0, 2)
        .join(" ")
        .replace(/[^a-zA-ZäöüÄÖÜéàèâêîôûÉÀÈÂÊÎÔÛ0-9]/g, "")
        .slice(0, 20);
      if (vendor.length >= 2) break;
      vendor = null;
    }
  }

  return { vendor: vendor || null, amount: amountStr };
}

export async function runOcr(imageBlob: Blob): Promise<OcrResult> {
  try {
    const result = await Tesseract.recognize(imageBlob, "deu+eng", {
      logger: () => {},
    });
    const { vendor, amount } = parseOcrText(result.data.text);
    return { vendor, amount, rawText: result.data.text };
  } catch {
    return { vendor: null, amount: null, rawText: "" };
  }
}

export function buildFileName(
  paymentType: "Bar" | "Karte",
  vendor: string | null,
  amount: string | null
): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");

  const parts: string[] = [`${yyyy}-${mm}-${dd}`, `${hh}-${min}`];

  if (vendor && vendor.length >= 2) {
    parts.push(vendor);
  }
  if (amount) {
    parts.push(amount);
  }
  parts.push(paymentType);

  return parts.join("_") + ".pdf";
}

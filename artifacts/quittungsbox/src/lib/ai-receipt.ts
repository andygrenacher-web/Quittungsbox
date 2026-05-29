// AI-powered receipt analysis via OpenAI (vision).
//
// When AI is enabled and a key is present, the ORIGINAL receipt image is sent
// to OpenAI. The model reads the receipt itself and returns only:
//   - date (Belegdatum)
//   - amount (Totalbetrag inkl. MWST — the real payable amount)
//   - paymentType (Bar / Karte)
// The app always saves locally first; AI only decides the final name/folder.
// Falls back gracefully when offline, no key, or API error (returns null).

export interface AiReceiptResult {
  date:        string | null;          // YYYY-MM-DD
  amount:      string | null;          // e.g. "82.10" — total incl. VAT
  paymentType: "Bar" | "Karte" | null; // detected payment method, may be null
  confidence:  "high" | "low";         // high = date AND amount both clearly found
}

const SYSTEM_PROMPT = `Du bist Experte für Schweizer Kassenzettel und Rechnungen.
Du bekommst ein Foto eines Belegs und liest es selbst — du verlässt dich NICHT auf OCR.

Gib ausschliesslich dieses JSON zurück (kein Markdown, kein Kommentar):
{
  "date": "YYYY-MM-DD oder null",
  "amount": "Totalbetrag inkl. MWST, exakt 2 Dezimalstellen als String, z.B. \"82.10\", oder null",
  "paymentType": "Bar, Karte oder null",
  "confidence": "high oder low"
}

DATUM:
- Belegdatum / Kaufdatum verwenden (nicht ein Fälligkeits- oder Scan-Datum)
- Format YYYY-MM-DD
- Erlaubte Jahre: aktuelles Jahr und die zwei Vorjahre
- Unklar → null

BETRAG (der echte, zu bezahlende Rechnungsbetrag inkl. MWST):
VERWENDEN:
- Total, Rechnungstotal, Gesamttotal, Gesamtbetrag, Endbetrag, Total CHF, Brutto
- "inkl. MWST", "Total inkl. MWST"
- "Zu bezahlen", "Zu zahlen", "Betrag dankend erhalten", Grand Total
- Bei mehreren Beträgen: der ENDGÜLTIGE zu zahlende Totalbetrag inkl. MWST
NIEMALS VERWENDEN:
- Rückgeld, Wechselgeld, Retourgeld
- erhaltenes Bargeld, Gegeben, Bar gegeben, Geldeinwurf
- Netto, Nettobetrag, Warenwert (Betrag vor MWST)
- MWST-Betrag / Steueranteil allein
- Liter, kg, Stück, Menge, Anzahl
- Einzelpreis, Grundpreis, Literpreis
- Wenn kein klares Total erkennbar → null

ZAHLUNGSART:
- "Karte" bei: EC, Maestro, Mastercard, Visa, Kreditkarte, Debit, kontaktlos, TWINT, Postcard
- "Bar" bei: Bar, BAR, Barzahlung, Bargeld, oder wenn Rückgeld/Wechselgeld ausgewiesen ist
- Nicht erkennbar → null

confidence = "high" NUR wenn Datum UND Betrag klar und eindeutig erkannt sind.
confidence = "low" wenn eines fehlt oder mehrdeutig ist.`;

export async function analyzeReceiptWithAi(
  imageDataUrl: string,   // JPEG/PNG data URL of the receipt — the AI reads this directly
  apiKey:       string,
): Promise<AiReceiptResult | null> {
  if (!imageDataUrl) return null;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:                "gpt-4o-mini",
        response_format:      { type: "json_object" },
        max_completion_tokens: 200,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text",      text: "Lies diesen Beleg und gib das JSON zurück." },
              { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) return null;

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) return null;

    const parsed = JSON.parse(text) as Record<string, unknown>;

    const date = typeof parsed.date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) &&
      isAllowedYear(parsed.date)
        ? parsed.date : null;

    const amount = typeof parsed.amount === "string" &&
      /^\d{1,6}\.\d{2}$/.test(parsed.amount) &&
      parseFloat(parsed.amount) > 0
        ? parsed.amount : null;

    const paymentType: "Bar" | "Karte" | null =
      parsed.paymentType === "Bar"   ? "Bar"   :
      parsed.paymentType === "Karte" ? "Karte" : null;

    const confidence: "high" | "low" =
      parsed.confidence === "high" && date !== null && amount !== null
        ? "high"
        : "low";

    return { date, amount, paymentType, confidence };
  } catch {
    return null;   // network error, timeout, parse error — all handled gracefully
  }
}

function isAllowedYear(dateStr: string): boolean {
  const year = parseInt(dateStr.slice(0, 4));
  const curr = new Date().getFullYear();
  return year >= curr - 2 && year <= curr;
}

// ── Connectivity / key test ──────────────────────────────────────────────────
// Makes a minimal real request so the user can see EXACTLY why AI fails:
// missing key, invalid key, no quota, network/CORS, or timeout.

export interface AiTestResult {
  ok:      boolean;
  message: string;
}

export async function testOpenAiKey(apiKey: string): Promise<AiTestResult> {
  const key = apiKey.trim();
  if (!key) return { ok: false, message: "Kein API-Key eingegeben." };
  if (!key.startsWith("sk-")) {
    return { ok: false, message: 'API-Key sieht ungültig aus (muss mit "sk-" beginnen).' };
  }
  if (!navigator.onLine) {
    return { ok: false, message: "Keine Internetverbindung." };
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({
        model:                "gpt-4o-mini",
        max_completion_tokens: 5,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) {
      return { ok: true, message: "KI funktioniert ✓ — Key gültig, Verbindung OK." };
    }

    let detail = "";
    try {
      const err = await res.json() as { error?: { message?: string } };
      detail = err.error?.message ?? "";
    } catch { /* non-JSON error body */ }

    if (res.status === 401) return { ok: false, message: "Ungültiger API-Key (401). Bitte Key prüfen." };
    if (res.status === 429) return { ok: false, message: "Kein Guthaben oder Limit erreicht (429). OpenAI-Konto / Billing prüfen." };
    if (res.status === 403) return { ok: false, message: "Zugriff verweigert (403). Key-Berechtigung prüfen." };
    if (res.status === 404) return { ok: false, message: "Modell nicht verfügbar (404)." };
    return { ok: false, message: `Fehler ${res.status}${detail ? ": " + detail : ""}` };

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort|timeout|time/i.test(msg)) {
      return { ok: false, message: "Zeitüberschreitung — keine Antwort von OpenAI." };
    }
    return {
      ok: false,
      message: "Netzwerkfehler — keine Verbindung zu OpenAI (Internet/CORS/Firewall).",
    };
  }
}

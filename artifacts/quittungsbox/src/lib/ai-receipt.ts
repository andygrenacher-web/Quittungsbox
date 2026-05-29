// Optional AI-powered receipt analysis via OpenAI.
//
// Uses the OCR text already extracted locally — no image is sent to the server.
// The app always saves locally first; AI is only used to improve filename/folder.
// Falls back gracefully when offline, no key, or API error.

export interface AiReceiptResult {
  date:       string | null;   // YYYY-MM-DD
  amount:     string | null;   // e.g. "82.10"
  confidence: "high" | "low";  // high = date AND amount both clearly found
}

const SYSTEM_PROMPT = `Du analysierst OCR-Text von Schweizer Kassenzetteln und Rechnungen.

Gib ausschliesslich dieses JSON zurück (kein Markdown, kein Kommentar):
{
  "date": "YYYY-MM-DD oder null",
  "amount": "Zahl mit exakt 2 Dezimalstellen als String, z.B. \"82.10\", oder null",
  "confidence": "high oder low"
}

Regeln für "date":
- Belegdatum verwenden (nicht Scan-Datum)
- Format: YYYY-MM-DD
- Erlaubte Jahre: aktuelles Jahr und die zwei Vorjahre
- Bei Unklarheit: null

Regeln für "amount" — VERWENDEN:
- Total, Rechnungstotal, Gesamtbetrag, Total CHF, inkl. MWST, Brutto, Bruttobetrag
- Zu bezahlen, Zu zahlen, ZU ZAHLEN, ZU BEZAHLEN
- Betrag dankend erhalten
- Grand Total

Regeln für "amount" — IGNORIEREN:
- Rückgeld, Wechselgeld, Retourgeld → nicht der Rechnungsbetrag
- Bargeld erhalten, Geldeinwurf, Bezahlt, Kassiert → Zahlungsmittel, nicht Betrag
- MWST-Betrag, Steuerbetrag → nur der Steueranteil, nicht Total
- Netto, Nettobetrag, Warenwert, Grundbetrag → Betrag vor MWST
- Menge, Liter, kg, Stk, Einzelpreis → keine Geldbeträge
- Wenn Total UND Rückgeld vorhanden: immer Total verwenden
- Wenn unsicher oder mehrere Beträge ohne klares Total: null

confidence = "high" wenn Datum UND Betrag klar und eindeutig erkannt wurden.
confidence = "low" wenn eines davon fehlt oder mehrdeutig ist.`;

export async function analyzeReceiptWithAi(
  ocrText: string,
  apiKey:  string,
): Promise<AiReceiptResult | null> {
  if (!ocrText.trim()) return null;

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
        max_completion_tokens: 150,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user",   content: `OCR-Text:\n${ocrText.slice(0, 4000)}` },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
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

    const confidence: "high" | "low" =
      parsed.confidence === "high" && date !== null && amount !== null
        ? "high"
        : "low";

    return { date, amount, confidence };
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

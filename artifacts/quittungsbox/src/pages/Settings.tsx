import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { getOpenAiKey, setOpenAiKey, isAiEnabled, setAiEnabled } from "@/lib/settings";

export default function Settings() {
  const [, setLocation] = useLocation();

  const [apiKey,    setApiKey]    = useState("");
  const [aiOn,      setAiOn]      = useState(true);
  const [showKey,   setShowKey]   = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [savedMsg,  setSavedMsg]  = useState("");

  useEffect(() => {
    getOpenAiKey().then(k => setApiKey(k ?? ""));
    isAiEnabled().then(setAiOn);
  }, []);

  async function handleSave() {
    setSaving(true);
    await setOpenAiKey(apiKey.trim() || null);
    await setAiEnabled(aiOn);
    setSaving(false);
    setSavedMsg("Gespeichert ✓");
    setTimeout(() => setSavedMsg(""), 2500);
  }

  async function handleClear() {
    setApiKey("");
    await setOpenAiKey(null);
    setSavedMsg("API-Key gelöscht");
    setTimeout(() => setSavedMsg(""), 2500);
  }

  const hasKey = apiKey.trim().length > 0;

  return (
    <div className="flex flex-col min-h-dvh bg-background">

      {/* Header */}
      <header className="px-4 pt-6 pb-4 flex items-center gap-3">
        <button
          onClick={() => setLocation("/")}
          className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center active:bg-accent shrink-0"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/>
            <polyline points="12,19 5,12 12,5"/>
          </svg>
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-foreground leading-none">Einstellungen</h1>
          <p className="text-xs text-muted-foreground mt-0.5">KI-Auswertung konfigurieren</p>
        </div>
      </header>

      <main className="flex-1 px-4 pb-10 flex flex-col gap-6">

        {/* KI toggle */}
        <section className="rounded-2xl border border-border bg-card p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-semibold text-sm text-foreground">KI-Auswertung</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Datum und Betrag werden optional per KI verbessert
              </p>
            </div>
            <button
              onClick={() => setAiOn(v => !v)}
              className="relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0"
              style={{ background: aiOn ? "hsl(142 55% 36%)" : "hsl(0 0% 80%)" }}
            >
              <span
                className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200"
                style={{ transform: aiOn ? "translateX(20px)" : "translateX(0)" }}
              />
            </button>
          </div>

          {aiOn && (
            <div className="rounded-xl px-3 py-2 text-xs leading-relaxed"
              style={{ background: "hsl(142 55% 36% / 0.08)", color: "hsl(142 55% 28%)" }}>
              <strong>Wie es funktioniert:</strong> Nach der lokalen OCR-Erkennung wird der
              Belegtext an OpenAI gesendet (nur bei Internetverbindung). Die App speichert
              den Beleg immer lokal – KI verbessert nur Dateiname und Ordner.
            </div>
          )}
        </section>

        {/* API Key */}
        {aiOn && (
          <section className="rounded-2xl border border-border bg-card p-4 flex flex-col gap-3">
            <div>
              <p className="font-semibold text-sm text-foreground">OpenAI API-Key</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Dein eigener Key von{" "}
                <span className="font-mono">platform.openai.com</span>
              </p>
            </div>

            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full pr-10 pl-3 py-2.5 rounded-xl border border-input bg-background text-sm font-mono text-foreground focus:outline-none focus:ring-2"
                style={{ "--tw-ring-color": "hsl(142 55% 36% / 0.4)" } as React.CSSProperties}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <button
                onClick={() => setShowKey(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground"
              >
                {showKey ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                )}
              </button>
            </div>

            {/* Status indicator */}
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full shrink-0"
                style={{ background: hasKey ? "hsl(142 55% 36%)" : "hsl(0 0% 70%)" }} />
              <span className="text-xs text-muted-foreground">
                {hasKey ? "API-Key vorhanden" : "Kein API-Key — KI deaktiviert"}
              </span>
            </div>

            {/* Pricing note */}
            <p className="text-xs text-muted-foreground leading-relaxed">
              Kosten: ca. 0.001–0.003 CHF pro Beleg (OpenAI gpt-4o-mini).
              Wird nur bei Internetverbindung verwendet.
            </p>
          </section>
        )}

        {/* What AI looks for */}
        {aiOn && (
          <section className="rounded-2xl border border-border bg-card p-4 flex flex-col gap-2">
            <p className="font-semibold text-sm text-foreground mb-1">KI-Regeln (automatisch)</p>
            <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              <div className="flex gap-2">
                <span className="text-green-600 shrink-0">✓</span>
                <span>Total, Rechnungstotal, Gesamtbetrag, inkl. MWST, Zu bezahlen</span>
              </div>
              <div className="flex gap-2">
                <span className="text-red-500 shrink-0">✗</span>
                <span>Rückgeld, Bargeld erhalten, Bezahlt, MWST-Betrag, Netto, Menge, Liter</span>
              </div>
              <div className="flex gap-2">
                <span className="shrink-0">→</span>
                <span>Bei niedrigem Vertrauen: Beleg in «Prüfen» ablegen</span>
              </div>
            </div>
          </section>
        )}

        {/* Save / Clear buttons */}
        <div className="flex flex-col gap-2 mt-auto">
          {savedMsg && (
            <p className="text-center text-sm font-medium" style={{ color: "hsl(142 55% 36%)" }}>
              {savedMsg}
            </p>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full py-4 rounded-2xl text-white text-base font-semibold flex items-center justify-center gap-2 active:scale-[0.97] transition-transform shadow-md disabled:opacity-50"
            style={{ background: "hsl(142 55% 36%)" }}
          >
            {saving ? "Wird gespeichert …" : "Speichern"}
          </button>
          {hasKey && (
            <button
              onClick={handleClear}
              className="w-full py-3.5 rounded-2xl bg-muted text-muted-foreground text-sm font-medium active:scale-[0.97] transition-transform"
            >
              API-Key löschen
            </button>
          )}
        </div>
      </main>
    </div>
  );
}

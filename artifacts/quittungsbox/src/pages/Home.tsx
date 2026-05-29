import { useRef, useState } from "react";
import { scanImage, canvasToBlob, canvasToDataUrl } from "@/lib/scanner";
import { runOcr, buildFileName } from "@/lib/ocr";
import { generatePdfFromCanvas } from "@/lib/pdf";

type PaymentType = "Bar" | "Karte";
type AppMode = "idle" | "scanning" | "preview" | "processing" | "done" | "error";

interface DoneState {
  fileName: string;
  pdfBlob: Blob;
}

export default function Home() {
  const [mode, setMode] = useState<AppMode>("idle");
  const [paymentType, setPaymentType] = useState<PaymentType | null>(null);
  const [scanStatus, setScanStatus] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [corrected, setCorrected] = useState(false);
  const [done, setDone] = useState<DoneState | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  // Store the scanned canvas between preview → processing
  const scannedCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const barRef  = useRef<HTMLInputElement>(null);
  const karteRef = useRef<HTMLInputElement>(null);

  // ── capture ────────────────────────────────────────────────

  async function handleCapture(pt: PaymentType, file: File) {
    setPaymentType(pt);
    setMode("scanning");
    setScanStatus("Beleg wird erkannt …");

    try {
      const imageBlob = new Blob([file], { type: file.type });
      const { canvas, corrected: cor } = await scanImage(imageBlob);

      scannedCanvasRef.current = canvas;
      setCorrected(cor);
      setPreviewUrl(canvasToDataUrl(canvas));
      setMode("preview");
    } catch {
      setErrorMsg("Scan fehlgeschlagen. Bitte nochmal versuchen.");
      setMode("error");
    }
  }

  // ── save (OCR + PDF) ───────────────────────────────────────

  async function handleSave() {
    const canvas = scannedCanvasRef.current;
    if (!canvas || !paymentType) return;

    setMode("processing");
    setScanStatus("OCR läuft …");

    try {
      const imgBlob = await canvasToBlob(canvas);

      const ocrResult = await runOcr(imgBlob);

      setScanStatus("PDF wird erstellt …");
      const pdfBlob = await generatePdfFromCanvas(canvas, ocrResult.rawText);
      const fileName = buildFileName(paymentType, ocrResult.vendor, ocrResult.amount);

      setDone({ fileName, pdfBlob });
      setMode("done");
    } catch {
      setErrorMsg("PDF konnte nicht erstellt werden.");
      setMode("error");
    }
  }

  // ── actions ────────────────────────────────────────────────

  function downloadPdf() {
    if (!done) return;
    const url = URL.createObjectURL(done.pdfBlob);
    const a = document.createElement("a");
    a.href = url; a.download = done.fileName; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function sharePdf() {
    if (!done) return;
    const file = new File([done.pdfBlob], done.fileName, { type: "application/pdf" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: done.fileName }); return; }
      catch { /* fall through */ }
    }
    downloadPdf();
  }

  function reset() {
    scannedCanvasRef.current = null;
    setMode("idle");
    setDone(null);
    setPreviewUrl("");
    setPaymentType(null);
    setErrorMsg("");
  }

  function onFileChange(pt: PaymentType) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = "";
      handleCapture(pt, file);
    };
  }

  // ── render ─────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-dvh bg-background select-none">

      {/* Header */}
      <header className="px-5 pt-6 pb-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shadow-sm" style={{ background: "hsl(142 55% 36%)" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14,2 14,8 20,8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground leading-none">Quittungsbox</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Beleg fotografieren, fertig.</p>
        </div>
      </header>

      <main className="flex-1 flex flex-col justify-center px-5 gap-4 pb-8">

        {/* ── IDLE ── */}
        {mode === "idle" && (
          <>
            <p className="text-center text-sm text-muted-foreground mb-2">Womit wurde bezahlt?</p>

            <button
              onClick={() => barRef.current?.click()}
              className="w-full flex-1 max-h-[38vh] min-h-[160px] rounded-2xl flex flex-col items-center justify-center gap-3 active:scale-[0.97] transition-transform duration-100 shadow-md"
              style={{ background: "hsl(142 55% 36%)" }}
            >
              <div className="w-16 h-16 rounded-2xl bg-white/20 flex items-center justify-center">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="6" width="20" height="12" rx="2"/>
                  <circle cx="12" cy="12" r="2"/>
                  <path d="M6 12h.01M18 12h.01"/>
                </svg>
              </div>
              <span className="text-white text-3xl font-bold tracking-wide">Bar</span>
              <span className="text-white/70 text-sm">Bargeld</span>
            </button>

            <button
              onClick={() => karteRef.current?.click()}
              className="w-full flex-1 max-h-[38vh] min-h-[160px] rounded-2xl flex flex-col items-center justify-center gap-3 active:scale-[0.97] transition-transform duration-100 shadow-md"
              style={{ background: "hsl(221 80% 52%)" }}
            >
              <div className="w-16 h-16 rounded-2xl bg-white/20 flex items-center justify-center">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="4" width="22" height="16" rx="2"/>
                  <line x1="1" y1="10" x2="23" y2="10"/>
                </svg>
              </div>
              <span className="text-white text-3xl font-bold tracking-wide">Karte</span>
              <span className="text-white/70 text-sm">EC / Kredit</span>
            </button>

            <input ref={barRef}   type="file" accept="image/*" className="hidden" onChange={onFileChange("Bar")} />
            <input ref={karteRef} type="file" accept="image/*" className="hidden" onChange={onFileChange("Karte")} />
          </>
        )}

        {/* ── SCANNING / PROCESSING ── */}
        {(mode === "scanning" || mode === "processing") && (
          <div className="flex flex-col items-center justify-center gap-6 py-12">
            <div className="relative w-24 h-24">
              <svg className="animate-spin w-24 h-24" viewBox="0 0 96 96" fill="none">
                <circle cx="48" cy="48" r="40" stroke="hsl(142 55% 36% / 0.15)" strokeWidth="8"/>
                <path d="M48 8 a40 40 0 0 1 40 40" stroke="hsl(142 55% 36%)" strokeWidth="8" strokeLinecap="round"/>
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                {mode === "scanning" ? (
                  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="hsl(142 55% 36%)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="5,3 5,21 19,3 19,21"/>
                    <line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                ) : (
                  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="hsl(142 55% 36%)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14,2 14,8 20,8"/>
                  </svg>
                )}
              </div>
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold text-foreground">{scanStatus}</p>
              <p className="text-sm text-muted-foreground mt-1">Bitte warten …</p>
            </div>
          </div>
        )}

        {/* ── PREVIEW ── */}
        {mode === "preview" && previewUrl && (
          <div className="flex flex-col gap-4">
            {/* Badge */}
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-foreground">Vorschau</p>
              {corrected && (
                <span className="text-xs font-medium px-2.5 py-1 rounded-full" style={{ background: "hsl(142 55% 36% / 0.12)", color: "hsl(142 55% 30%)" }}>
                  ✦ Perspektive korrigiert
                </span>
              )}
            </div>

            {/* Scanned image */}
            <div className="rounded-2xl overflow-hidden border border-border shadow-sm bg-card max-h-[55vh] flex items-center justify-center">
              <img
                src={previewUrl}
                alt="Scan-Vorschau"
                className="max-w-full max-h-[55vh] object-contain"
                style={{ display: "block" }}
              />
            </div>

            {/* Action buttons */}
            <button
              onClick={handleSave}
              className="w-full py-4 rounded-2xl text-white text-lg font-semibold flex items-center justify-center gap-2.5 active:scale-[0.97] transition-transform shadow-md"
              style={{ background: "hsl(142 55% 36%)" }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                <polyline points="17,21 17,13 7,13 7,21"/>
                <polyline points="7,3 7,8 15,8"/>
              </svg>
              Speichern
            </button>

            <button
              onClick={reset}
              className="w-full py-3.5 rounded-2xl bg-muted text-muted-foreground text-base font-medium active:scale-[0.97] transition-transform flex items-center justify-center gap-2"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1,4 1,10 7,10"/>
                <path d="M3.51 15a9 9 0 1 0 .49-3.51"/>
              </svg>
              Neu aufnehmen
            </button>
          </div>
        )}

        {/* ── DONE ── */}
        {mode === "done" && done && (
          <div className="flex flex-col items-center gap-6 py-8">
            <div className="w-24 h-24 rounded-full flex items-center justify-center shadow-lg" style={{ background: "hsl(142 55% 36%)" }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20,6 9,17 4,12"/>
              </svg>
            </div>

            <div className="text-center">
              <p className="text-3xl font-bold text-foreground">Abgelegt</p>
              <p className="text-xs text-muted-foreground mt-3 break-all px-4 font-mono leading-relaxed">{done.fileName}</p>
            </div>

            <div className="w-full flex flex-col gap-3 mt-2">
              <button
                onClick={sharePdf}
                className="w-full py-4 rounded-2xl text-white text-lg font-semibold flex items-center justify-center gap-2.5 active:scale-[0.97] transition-transform shadow-md"
                style={{ background: "hsl(221 80% 52%)" }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
                  <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                </svg>
                Teilen
              </button>

              <button
                onClick={downloadPdf}
                className="w-full py-4 rounded-2xl text-lg font-semibold flex items-center justify-center gap-2.5 active:scale-[0.97] transition-transform border-2"
                style={{ borderColor: "hsl(142 55% 36%)", color: "hsl(142 55% 36%)" }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7,10 12,15 17,10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Herunterladen
              </button>

              <button onClick={reset} className="w-full py-4 rounded-2xl bg-muted text-muted-foreground text-lg font-semibold active:scale-[0.97] transition-transform">
                Neue Quittung
              </button>
            </div>
          </div>
        )}

        {/* ── ERROR ── */}
        {mode === "error" && (
          <div className="flex flex-col items-center gap-6 py-12">
            <div className="w-24 h-24 rounded-full flex items-center justify-center shadow" style={{ background: "hsl(0 84% 60%)" }}>
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </div>
            <div className="text-center">
              <p className="text-xl font-bold text-foreground">Fehler</p>
              <p className="text-sm text-muted-foreground mt-2 px-6">{errorMsg}</p>
            </div>
            <button onClick={reset} className="w-full py-4 rounded-2xl text-white text-lg font-semibold active:scale-[0.97] transition-transform shadow-md" style={{ background: "hsl(142 55% 36%)" }}>
              Nochmal versuchen
            </button>
          </div>
        )}

      </main>

      {mode === "idle" && (
        <footer className="px-5 pb-6 text-center">
          <p className="text-xs text-muted-foreground">Alles lokal · Kein Server · Kein Konto</p>
        </footer>
      )}
    </div>
  );
}

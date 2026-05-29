import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { scanImage, prepareScannedImage, canvasToBlob, canvasToDataUrl, canvasToCompressedDataUrl, applyOriginal, applyGrau, applyScan } from "@/lib/scanner";
import { runOcr, buildFileName } from "@/lib/ocr";
import { generatePdfFromCanvas } from "@/lib/pdf";
import { saveReceipt, getPruefenCount, getFolder, initFolderStructure, moveReceiptFile } from "@/lib/storage";
import { capturePhoto } from "@/lib/capture";
import { isNative } from "@/lib/platform";
import { getOpenAiKey, isAiEnabled } from "@/lib/settings";
import { analyzeReceiptWithAi } from "@/lib/ai-receipt";

type PaymentType  = "Bar" | "Karte";
type AppMode      = "idle" | "scanning" | "preview" | "processing" | "done" | "error";
type DisplayMode  = "original" | "grau" | "scan";

interface DoneState {
  fileName: string;
  folder:   string;
  pdfBlob:  Blob;
}

const MODES: { id: DisplayMode; label: string; hint: string }[] = [
  { id: "original", label: "Original",    hint: "Farbbild" },
  { id: "grau",     label: "Graustufen",  hint: "Standard" },
  { id: "scan",     label: "Scan",        hint: "Höherer Kontrast" },
];

type AiStatus = "off" | "analyzing" | "done" | "uncertain";

// ── Component ─────────────────────────────────────────────────────────────────

export default function Home() {
  const [, setLocation] = useLocation();

  const [appMode,      setAppMode]      = useState<AppMode>("idle");
  const [paymentType,  setPaymentType]  = useState<PaymentType | null>(null);
  const [scanStatus,   setScanStatus]   = useState("");
  const [previewUrl,   setPreviewUrl]   = useState("");
  const [corrected,    setCorrected]    = useState(false);
  const [displayMode,  setDisplayMode]  = useState<DisplayMode>("grau");
  const [done,         setDone]         = useState<DoneState | null>(null);
  const [errorMsg,     setErrorMsg]     = useState("");
  const [pruefenCount, setPruefenCount] = useState(0);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [aiStatus,     setAiStatus]     = useState<AiStatus>("off");

  const rawCanvasRef     = useRef<HTMLCanvasElement | null>(null);
  const ocrCanvasRef     = useRef<HTMLCanvasElement | null>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const barRef           = useRef<HTMLInputElement>(null);
  const karteRef         = useRef<HTMLInputElement>(null);
  const saveTokenRef     = useRef(0);   // guards against stale AI completions after reset

  async function loadPruefenCount() {
    try { setPruefenCount(await getPruefenCount()); } catch { /* ignore */ }
  }

  useEffect(() => {
    loadPruefenCount();
    initFolderStructure().catch(() => {});
    getOpenAiKey().then(k => setAiConfigured(!!k));
  }, []);

  // ── display mode switching ────────────────────────────────

  function switchMode(mode: DisplayMode) {
    if (!rawCanvasRef.current) return;
    let c: HTMLCanvasElement;
    if      (mode === "original") c = applyOriginal(rawCanvasRef.current);
    else if (mode === "grau")     c = ocrCanvasRef.current!;
    else                          c = applyScan(rawCanvasRef.current);
    displayCanvasRef.current = c;
    setPreviewUrl(canvasToDataUrl(c));
    setDisplayMode(mode);
  }

  // ── capture ───────────────────────────────────────────────

  async function handleCapture(pt: PaymentType, imageBlob: Blob, alreadyCorrected = false) {
    setPaymentType(pt);
    setAppMode("scanning");
    setScanStatus(alreadyCorrected ? "Bild wird verarbeitet …" : "Beleg wird erkannt …");
    try {
      const { rawCanvas, canvas: grauCanvas, corrected: cor } = alreadyCorrected
        ? await prepareScannedImage(imageBlob)
        : await scanImage(imageBlob);

      rawCanvasRef.current     = rawCanvas;
      ocrCanvasRef.current     = grauCanvas;
      displayCanvasRef.current = grauCanvas;
      setCorrected(cor);
      setDisplayMode("grau");
      setPreviewUrl(canvasToDataUrl(grauCanvas));
      setAppMode("preview");
    } catch {
      setErrorMsg("Scan fehlgeschlagen. Bitte nochmal versuchen.");
      setAppMode("error");
    }
  }

  async function captureNative(pt: PaymentType) {
    try {
      const result = await capturePhoto();
      if (!result) return;
      handleCapture(pt, result.blob, result.alreadyCorrected);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/cancelled|cancel|dismiss/i.test(msg)) return;
      setErrorMsg("Kamera-Fehler: " + msg);
      setAppMode("error");
    }
  }

  function onFileChange(pt: PaymentType) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]; if (!file) return;
      e.target.value = "";
      handleCapture(pt, new Blob([file], { type: file.type }));
    };
  }

  function triggerCapture(pt: PaymentType) {
    if (isNative()) captureNative(pt);
    else if (pt === "Bar") barRef.current?.click();
    else                   karteRef.current?.click();
  }

  // ── save — OCR → PDF → persist → done → AI in background ─

  async function handleSave() {
    if (!displayCanvasRef.current || !paymentType) return;
    const token = ++saveTokenRef.current;
    setAppMode("processing");

    try {
      // Decide upfront whether AI is the analyzer for this receipt.
      const [apiKey, aiOn] = await Promise.all([getOpenAiKey(), isAiEnabled()]);
      const useAi = !!apiKey && aiOn && navigator.onLine;

      if (useAi) {
        await saveWithAi(token, apiKey!);
      } else {
        await saveWithOcr(token);
      }
    } catch {
      setErrorMsg("PDF konnte nicht erstellt werden.");
      setAppMode("error");
    }
  }

  // ── AI path — image is the source of truth ───────────────────────
  // 1. Save the PDF locally FIRST (into Prüfen) so nothing is ever lost.
  // 2. Show the done screen immediately — the app never blocks.
  // 3. Send the image to the AI; it reads date + amount itself.
  //    confident  → rename + move into the correct Archiv folder.
  //    unsure     → leave it in Prüfen for manual review.
  async function saveWithAi(token: number, apiKey: string) {
    const pt = paymentType!;
    setScanStatus("PDF wird erstellt …");
    const pdfBlob = await generatePdfFromCanvas(displayCanvasRef.current!, "");

    // Provisional local save — unique name so quick successive scans don't collide.
    const provFileName = `unbekannt-${Date.now()}_${pt}.pdf`;
    const provFolder   = "Prüfen/Kein Datum";
    await saveReceipt({
      fileName: provFileName, folder: provFolder, pdfBlob,
      createdAt:   new Date().toISOString(),
      receiptDate: null,
      amount:      null,
      paymentType: pt,
      ocrFailed:   false,
    });

    await loadPruefenCount();
    setDone({ fileName: provFileName, folder: provFolder, pdfBlob });
    setAiStatus("analyzing");
    setAppMode("done");

    // ── Post-save phase ──────────────────────────────────────────────
    // The receipt is already safely on disk. From here on nothing may throw
    // to the global handler — a failure must never show the error screen or
    // lose the file. Worst case the receipt simply stays in Prüfen.
    try {
      const aiImage = canvasToCompressedDataUrl(rawCanvasRef.current ?? displayCanvasRef.current!);
      const ai = await analyzeReceiptWithAi(aiImage, apiKey);

      // Ignore if the user already started a new receipt.
      if (saveTokenRef.current !== token) return;

      if (ai && ai.confidence === "high" && ai.date && ai.amount) {
        // The user's tap (Bar/Karte) is authoritative for payment type —
        // it is real intent the user entered, not a guess from the image.
        const finalFolder   = getFolder(ai.date, false);
        const finalFileName = buildFileName(pt, null, ai.amount, ai.date);
        await moveReceiptFile(provFolder, provFileName, finalFolder, finalFileName, pdfBlob);
        if (saveTokenRef.current !== token) return;
        await loadPruefenCount();
        setDone({ fileName: finalFileName, folder: finalFolder, pdfBlob });
        setAiStatus("done");
      } else {
        // Unsure — keep in Prüfen, but use whatever AI did read for a better name/subfolder.
        const date         = ai?.date ?? null;
        const amount       = ai?.amount ?? null;
        const reviewFolder = !date ? "Prüfen/Kein Datum" : "Prüfen/Kein Betrag";
        const reviewName   = buildFileName(pt, null, amount, date);
        await moveReceiptFile(provFolder, provFileName, reviewFolder, reviewName, pdfBlob);
        if (saveTokenRef.current !== token) return;
        await loadPruefenCount();
        setDone({ fileName: reviewName, folder: reviewFolder, pdfBlob });
        setAiStatus("uncertain");
      }
    } catch {
      // AI or move failed — the receipt stays safely in Prüfen as provisionally saved.
      if (saveTokenRef.current !== token) return;
      setAiStatus("uncertain");
    }
  }

  // ── OCR fallback — used only when AI is off, no key, or offline ───
  async function saveWithOcr(token: number) {
    if (!ocrCanvasRef.current) return;
    const pt = paymentType!;
    setAiStatus("off");
    setScanStatus("Beleg wird gelesen …");

    const ocrBlob   = await canvasToBlob(ocrCanvasRef.current);
    const ocrResult = await runOcr(ocrBlob);

    setScanStatus("PDF wird erstellt …");
    const pdfBlob  = await generatePdfFromCanvas(displayCanvasRef.current!, ocrResult.rawText);
    const fileName = buildFileName(pt, ocrResult.vendor, ocrResult.amount, ocrResult.receiptDate);
    const folder   = getFolder(ocrResult.receiptDate, ocrResult.ocrFailed);

    await saveReceipt({
      fileName, folder, pdfBlob,
      createdAt:   new Date().toISOString(),
      receiptDate: ocrResult.receiptDate,
      amount:      ocrResult.amount,
      paymentType: pt,
      ocrFailed:   ocrResult.ocrFailed,
    });

    if (saveTokenRef.current !== token) return;
    await loadPruefenCount();
    setDone({ fileName, folder, pdfBlob });
    setAppMode("done");
  }

  // ── download / share ──────────────────────────────────────

  function downloadPdf() {
    if (!done) return;
    const url = URL.createObjectURL(done.pdfBlob);
    const a = document.createElement("a"); a.href = url; a.download = done.fileName; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function sharePdf() {
    if (!done) return;
    const file = new File([done.pdfBlob], done.fileName, { type: "application/pdf" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: done.fileName }); return; } catch {}
    }
    downloadPdf();
  }

  function reset() {
    saveTokenRef.current++;   // any in-flight AI completion is now ignored
    rawCanvasRef.current = null; ocrCanvasRef.current = null; displayCanvasRef.current = null;
    setAppMode("idle"); setDone(null); setPreviewUrl(""); setPaymentType(null); setErrorMsg("");
    setDisplayMode("grau"); setAiStatus("off");
  }

  // ── render ────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-dvh bg-background select-none">

      {/* Header */}
      <header className="px-5 pt-6 pb-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shadow-sm shrink-0"
          style={{ background: "hsl(142 55% 36%)" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14,2 14,8 20,8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-foreground leading-none">Quittungsbox</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isNative() ? "Android · ML Kit OCR · Lokal" : "Beleg fotografieren, fertig."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setLocation("/einstellungen")}
            className="relative w-9 h-9 rounded-xl bg-muted flex items-center justify-center active:bg-accent"
            title="Einstellungen">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            {aiConfigured && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full border-2 border-background"
                style={{ background: "hsl(142 55% 36%)" }} />
            )}
          </button>
          <button onClick={() => setLocation("/archiv")}
            className="relative h-9 px-3 rounded-xl bg-muted flex items-center gap-1.5 active:bg-accent text-sm font-medium text-foreground">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="21,8 21,21 3,21 3,8"/><rect x="1" y="3" width="22" height="5"/>
              <line x1="10" y1="12" x2="14" y2="12"/>
            </svg>
            Archiv
            {pruefenCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] rounded-full text-[10px] font-bold flex items-center justify-center px-1"
                style={{ background: "hsl(30 90% 55%)", color: "white" }}>
                {pruefenCount}
              </span>
            )}
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col justify-center px-5 gap-4 pb-8">

        {/* ── IDLE ── */}
        {appMode === "idle" && (
          <>
            <p className="text-center text-sm text-muted-foreground mb-2">Womit wurde bezahlt?</p>

            <button onClick={() => triggerCapture("Bar")}
              className="w-full flex-1 max-h-[38vh] min-h-[160px] rounded-2xl flex flex-col items-center justify-center gap-3 active:scale-[0.97] transition-transform duration-100 shadow-md"
              style={{ background: "hsl(142 55% 36%)" }}>
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

            <button onClick={() => triggerCapture("Karte")}
              className="w-full flex-1 max-h-[38vh] min-h-[160px] rounded-2xl flex flex-col items-center justify-center gap-3 active:scale-[0.97] transition-transform duration-100 shadow-md"
              style={{ background: "hsl(221 80% 52%)" }}>
              <div className="w-16 h-16 rounded-2xl bg-white/20 flex items-center justify-center">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="4" width="22" height="16" rx="2"/>
                  <line x1="1" y1="10" x2="23" y2="10"/>
                </svg>
              </div>
              <span className="text-white text-3xl font-bold tracking-wide">Karte</span>
              <span className="text-white/70 text-sm">EC / Kredit</span>
            </button>

            {!isNative() && (
              <>
                <input ref={barRef}   type="file" accept="image/*" capture="environment" className="hidden" onChange={onFileChange("Bar")} />
                <input ref={karteRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFileChange("Karte")} />
              </>
            )}
          </>
        )}

        {/* ── SCANNING / PROCESSING ── */}
        {(appMode === "scanning" || appMode === "processing") && (
          <div className="flex flex-col items-center justify-center gap-6 py-12">
            <div className="relative w-24 h-24">
              <svg className="animate-spin w-24 h-24" viewBox="0 0 96 96" fill="none">
                <circle cx="48" cy="48" r="40" stroke="hsl(142 55% 36% / 0.15)" strokeWidth="8"/>
                <path d="M48 8 a40 40 0 0 1 40 40" stroke="hsl(142 55% 36%)" strokeWidth="8" strokeLinecap="round"/>
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="hsl(142 55% 36%)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14,2 14,8 20,8"/>
                </svg>
              </div>
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold text-foreground">{scanStatus}</p>
              <p className="text-sm text-muted-foreground mt-1">Bitte warten …</p>
            </div>
          </div>
        )}

        {/* ── PREVIEW ── */}
        {appMode === "preview" && previewUrl && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-1 p-1 rounded-xl bg-muted">
              {MODES.map(m => (
                <button key={m.id} onClick={() => switchMode(m.id)}
                  className="flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150"
                  style={displayMode === m.id
                    ? { background: "white", color: "hsl(142 55% 30%)", boxShadow: "0 1px 3px rgba(0,0,0,0.15)" }
                    : { color: "hsl(0 0% 45%)" }}>
                  {m.label}
                </button>
              ))}
            </div>

            <div className="rounded-2xl overflow-hidden border border-border shadow-sm bg-card max-h-[52vh] flex items-center justify-center">
              <img src={previewUrl} alt="Scan-Vorschau" className="max-w-full max-h-[52vh] object-contain block" />
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {corrected && (
                <span className="text-xs font-medium px-2.5 py-1 rounded-full"
                  style={{ background: "hsl(142 55% 36% / 0.12)", color: "hsl(142 55% 30%)" }}>
                  ✦ Perspektive korrigiert
                </span>
              )}
              {isNative() && (
                <span className="text-xs font-medium px-2.5 py-1 rounded-full"
                  style={{ background: "hsl(221 80% 52% / 0.10)", color: "hsl(221 80% 40%)" }}>
                  ML Kit OCR
                </span>
              )}
              <span className="text-xs text-muted-foreground px-2.5 py-1 rounded-full bg-muted">
                {MODES.find(m => m.id === displayMode)?.hint}
              </span>
            </div>

            <button onClick={handleSave}
              className="w-full py-4 rounded-2xl text-white text-lg font-semibold flex items-center justify-center gap-2.5 active:scale-[0.97] transition-transform shadow-md"
              style={{ background: "hsl(142 55% 36%)" }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                <polyline points="17,21 17,13 7,13 7,21"/>
                <polyline points="7,3 7,8 15,8"/>
              </svg>
              Speichern
            </button>
            <button onClick={reset}
              className="w-full py-3.5 rounded-2xl bg-muted text-muted-foreground text-base font-medium active:scale-[0.97] transition-transform flex items-center justify-center gap-2">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1,4 1,10 7,10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/>
              </svg>
              Neu aufnehmen
            </button>
          </div>
        )}

        {/* ── DONE ── */}
        {appMode === "done" && done && (
          <div className="flex flex-col items-center gap-5 py-6">
            <div className="w-24 h-24 rounded-full flex items-center justify-center shadow-lg"
              style={{ background: "hsl(142 55% 36%)" }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20,6 9,17 4,12"/>
              </svg>
            </div>
            <div className="text-center">
              <p className="text-3xl font-bold text-foreground">Gespeichert</p>
              <p className="text-xs text-muted-foreground mt-2 px-4 font-mono break-all">{done.fileName}</p>
              <div className="inline-flex items-center gap-1.5 mt-2 px-3 py-1 rounded-full"
                style={{
                  background: done.folder.startsWith("Prüfen") ? "hsl(45 100% 93%)" : "hsl(142 55% 36% / 0.1)",
                  color:      done.folder.startsWith("Prüfen") ? "hsl(30 80% 35%)"  : "hsl(142 55% 28%)",
                }}>
                <span className="text-xs">{done.folder.startsWith("Prüfen") ? "⚠️" : "📁"}</span>
                <span className="text-xs font-medium">{done.folder}</span>
              </div>

              {aiStatus === "analyzing" && (
                <p className="text-[11px] text-muted-foreground mt-2 flex items-center justify-center gap-1.5">
                  <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3"/>
                    <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
                  </svg>
                  KI liest den Beleg …
                </p>
              )}
              {aiStatus === "done" && (
                <p className="text-[11px] mt-2" style={{ color: "hsl(142 55% 30%)" }}>
                  ✓ Von KI erkannt und einsortiert
                </p>
              )}
              {aiStatus === "uncertain" && (
                <p className="text-[11px] mt-2" style={{ color: "hsl(30 80% 35%)" }}>
                  KI war unsicher — bitte im Archiv unter „Prüfen“ kontrollieren.
                </p>
              )}

              {isNative() && (
                <p className="text-xs text-muted-foreground mt-1">
                  Dokumente/Quittungsbox/{done.folder}/
                </p>
              )}
            </div>
            <div className="w-full flex flex-col gap-3 mt-1">
              <button onClick={sharePdf}
                className="w-full py-4 rounded-2xl text-white text-lg font-semibold flex items-center justify-center gap-2.5 active:scale-[0.97] transition-transform shadow-md"
                style={{ background: "hsl(221 80% 52%)" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                </svg>
                Teilen
              </button>
              <button onClick={downloadPdf}
                className="w-full py-4 rounded-2xl text-lg font-semibold flex items-center justify-center gap-2.5 active:scale-[0.97] transition-transform border-2"
                style={{ borderColor: "hsl(142 55% 36%)", color: "hsl(142 55% 36%)" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Herunterladen
              </button>
              <button onClick={reset}
                className="w-full py-4 rounded-2xl bg-muted text-muted-foreground text-lg font-semibold active:scale-[0.97] transition-transform">
                Neue Quittung
              </button>
            </div>
          </div>
        )}

        {/* ── ERROR ── */}
        {appMode === "error" && (
          <div className="flex flex-col items-center gap-6 py-12">
            <div className="w-24 h-24 rounded-full flex items-center justify-center shadow" style={{ background: "hsl(0 84% 60%)" }}>
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </div>
            <div className="text-center">
              <p className="text-xl font-bold text-foreground">Fehler</p>
              <p className="text-sm text-muted-foreground mt-2 px-6">{errorMsg}</p>
            </div>
            <button onClick={reset}
              className="w-full py-4 rounded-2xl text-white text-lg font-semibold active:scale-[0.97] transition-transform shadow-md"
              style={{ background: "hsl(142 55% 36%)" }}>
              Nochmal versuchen
            </button>
          </div>
        )}

      </main>

      {appMode === "idle" && (
        <footer className="px-5 pb-6 text-center">
          <p className="text-xs text-muted-foreground">
            {aiConfigured
              ? "KI-Auswertung aktiv · Alles lokal · Kein Konto"
              : isNative()
                ? "Alles lokal · Android APK · ML Kit OCR"
                : "Alles lokal · Kein Server · Kein Konto"}
          </p>
        </footer>
      )}
    </div>
  );
}

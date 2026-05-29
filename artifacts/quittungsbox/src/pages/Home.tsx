import { useRef, useState } from "react";
import { runOcr, buildFileName } from "@/lib/ocr";
import { generatePdf } from "@/lib/pdf";

type PaymentType = "Bar" | "Karte";
type AppMode = "idle" | "processing" | "done" | "error";

interface DoneState {
  fileName: string;
  pdfBlob: Blob;
}

const STEPS = [
  "Bild wird geladen …",
  "OCR läuft …",
  "PDF wird erstellt …",
  "Wird abgelegt …",
];

export default function Home() {
  const [mode, setMode] = useState<AppMode>("idle");
  const [stepIndex, setStepIndex] = useState(0);
  const [done, setDone] = useState<DoneState | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const barRef = useRef<HTMLInputElement>(null);
  const karteRef = useRef<HTMLInputElement>(null);

  async function handleCapture(paymentType: PaymentType, file: File) {
    try {
      setMode("processing");
      setStepIndex(0);

      const imageBlob = new Blob([file], { type: file.type });

      setStepIndex(1);
      const ocrResult = await runOcr(imageBlob);

      setStepIndex(2);
      const pdfBlob = await generatePdf(imageBlob, ocrResult.rawText);

      setStepIndex(3);
      const fileName = buildFileName(paymentType, ocrResult.vendor, ocrResult.amount);

      setDone({ fileName, pdfBlob });
      setMode("done");
    } catch (e) {
      console.error(e);
      setErrorMsg("Etwas ist schiefgelaufen. Bitte nochmal versuchen.");
      setMode("error");
    }
  }

  function onFileChange(paymentType: PaymentType) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = "";
      handleCapture(paymentType, file);
    };
  }

  function downloadPdf() {
    if (!done) return;
    const url = URL.createObjectURL(done.pdfBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = done.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function sharePdf() {
    if (!done) return;
    const file = new File([done.pdfBlob], done.fileName, { type: "application/pdf" });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: done.fileName });
      } catch {
        downloadPdf();
      }
    } else {
      downloadPdf();
    }
  }

  function reset() {
    setMode("idle");
    setDone(null);
    setStepIndex(0);
    setErrorMsg("");
  }

  return (
    <div className="flex flex-col min-h-dvh bg-background select-none">
      {/* Header */}
      <header className="pt-safe px-5 pt-6 pb-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center shadow-sm">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14,2 14,8 20,8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10,9 9,9 8,9" />
          </svg>
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground leading-none">Quittungsbox</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Beleg fotografieren, fertig.</p>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex flex-col justify-center px-5 gap-4 pb-8">

        {/* IDLE — two big buttons */}
        {mode === "idle" && (
          <>
            <p className="text-center text-sm text-muted-foreground mb-2">
              Womit wurde bezahlt?
            </p>

            {/* BAR button */}
            <button
              onClick={() => barRef.current?.click()}
              className="w-full flex-1 max-h-[38vh] min-h-[160px] rounded-2xl flex flex-col items-center justify-center gap-3 active:scale-[0.97] transition-transform duration-100 shadow-md"
              style={{ background: "hsl(142 55% 36%)" }}
            >
              <div className="w-16 h-16 rounded-2xl bg-white/20 flex items-center justify-center">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="6" width="20" height="12" rx="2" />
                  <circle cx="12" cy="12" r="2" />
                  <path d="M6 12h.01M18 12h.01" />
                </svg>
              </div>
              <span className="text-white text-3xl font-bold tracking-wide">Bar</span>
              <span className="text-white/70 text-sm">Bargeld</span>
            </button>

            {/* KARTE button */}
            <button
              onClick={() => karteRef.current?.click()}
              className="w-full flex-1 max-h-[38vh] min-h-[160px] rounded-2xl flex flex-col items-center justify-center gap-3 active:scale-[0.97] transition-transform duration-100 shadow-md"
              style={{ background: "hsl(221 80% 52%)" }}
            >
              <div className="w-16 h-16 rounded-2xl bg-white/20 flex items-center justify-center">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="4" width="22" height="16" rx="2" />
                  <line x1="1" y1="10" x2="23" y2="10" />
                </svg>
              </div>
              <span className="text-white text-3xl font-bold tracking-wide">Karte</span>
              <span className="text-white/70 text-sm">EC / Kredit</span>
            </button>

            {/* Hidden file inputs */}
            <input
              ref={barRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onFileChange("Bar")}
            />
            <input
              ref={karteRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onFileChange("Karte")}
            />
          </>
        )}

        {/* PROCESSING */}
        {mode === "processing" && (
          <div className="flex flex-col items-center justify-center gap-6 py-12">
            <div className="relative w-24 h-24">
              <svg className="animate-spin w-24 h-24" viewBox="0 0 96 96" fill="none">
                <circle cx="48" cy="48" r="40" stroke="hsl(142 55% 36% / 0.15)" strokeWidth="8" />
                <path
                  d="M48 8 a40 40 0 0 1 40 40"
                  stroke="hsl(142 55% 36%)"
                  strokeWidth="8"
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="hsl(142 55% 36%)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 7l-7 5 7 5V7z" />
                  <rect x="1" y="5" width="15" height="14" rx="2" />
                </svg>
              </div>
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold text-foreground">{STEPS[stepIndex]}</p>
              <p className="text-sm text-muted-foreground mt-1">Bitte warten …</p>
            </div>
            <div className="flex gap-1.5 mt-2">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  className="h-1.5 rounded-full transition-all duration-300"
                  style={{
                    width: i === stepIndex ? "2rem" : "0.5rem",
                    background: i <= stepIndex ? "hsl(142 55% 36%)" : "hsl(220 14% 88%)",
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* DONE */}
        {mode === "done" && done && (
          <div className="flex flex-col items-center gap-6 py-8">
            {/* Success icon */}
            <div
              className="w-24 h-24 rounded-full flex items-center justify-center shadow-lg"
              style={{ background: "hsl(142 55% 36%)" }}
            >
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20,6 9,17 4,12" />
              </svg>
            </div>

            <div className="text-center">
              <p className="text-3xl font-bold text-foreground">Abgelegt</p>
              <p className="text-xs text-muted-foreground mt-3 break-all px-4 font-mono leading-relaxed">
                {done.fileName}
              </p>
            </div>

            {/* Action buttons */}
            <div className="w-full flex flex-col gap-3 mt-2">
              <button
                onClick={sharePdf}
                className="w-full py-4 rounded-2xl text-white text-lg font-semibold flex items-center justify-center gap-2.5 active:scale-[0.97] transition-transform shadow-md"
                style={{ background: "hsl(221 80% 52%)" }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="18" cy="5" r="3" />
                  <circle cx="6" cy="12" r="3" />
                  <circle cx="18" cy="19" r="3" />
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                  <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                </svg>
                Teilen
              </button>

              <button
                onClick={downloadPdf}
                className="w-full py-4 rounded-2xl text-lg font-semibold flex items-center justify-center gap-2.5 active:scale-[0.97] transition-transform border-2"
                style={{ borderColor: "hsl(142 55% 36%)", color: "hsl(142 55% 36%)" }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7,10 12,15 17,10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Herunterladen
              </button>

              <button
                onClick={reset}
                className="w-full py-4 rounded-2xl bg-muted text-muted-foreground text-lg font-semibold active:scale-[0.97] transition-transform"
              >
                Neue Quittung
              </button>
            </div>
          </div>
        )}

        {/* ERROR */}
        {mode === "error" && (
          <div className="flex flex-col items-center gap-6 py-12">
            <div
              className="w-24 h-24 rounded-full flex items-center justify-center shadow"
              style={{ background: "hsl(0 84% 60%)" }}
            >
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-xl font-bold text-foreground">Fehler</p>
              <p className="text-sm text-muted-foreground mt-2 px-6">{errorMsg}</p>
            </div>
            <button
              onClick={reset}
              className="w-full py-4 rounded-2xl text-white text-lg font-semibold active:scale-[0.97] transition-transform shadow-md"
              style={{ background: "hsl(142 55% 36%)" }}
            >
              Nochmal versuchen
            </button>
          </div>
        )}
      </main>

      {/* Footer */}
      {mode === "idle" && (
        <footer className="pb-safe px-5 pb-6 text-center">
          <p className="text-xs text-muted-foreground">
            Alles lokal · Kein Server · Kein Konto
          </p>
        </footer>
      )}
    </div>
  );
}

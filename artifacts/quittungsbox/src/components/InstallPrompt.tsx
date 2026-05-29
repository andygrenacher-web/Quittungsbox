import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [show, setShow] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Don't show if already installed (running in standalone mode)
    if (window.matchMedia("(display-mode: standalone)").matches) return;
    // Don't show if already dismissed this session
    if (sessionStorage.getItem("pwa-install-dismissed")) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShow(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  async function handleInstall() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") setShow(false);
    setDeferredPrompt(null);
  }

  function handleDismiss() {
    sessionStorage.setItem("pwa-install-dismissed", "1");
    setDismissed(true);
    setShow(false);
  }

  if (!show || dismissed) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 px-4 pb-6 pt-2 safe-area-inset-bottom">
      <div
        className="rounded-2xl shadow-xl p-4 flex items-center gap-3 border border-border"
        style={{ background: "hsl(0 0% 100%)" }}
      >
        {/* Icon */}
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 shadow-sm"
          style={{ background: "#2d8a4e" }}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14,2 14,8 20,8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
        </div>

        {/* Text */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground leading-tight">App installieren</p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-tight">
            Auf Homescreen – läuft offline
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleDismiss}
            className="px-3 py-2 rounded-xl text-xs font-medium text-muted-foreground bg-muted active:bg-accent"
          >
            Nicht jetzt
          </button>
          <button
            onClick={handleInstall}
            className="px-3 py-2 rounded-xl text-xs font-semibold text-white shadow-sm active:scale-95 transition-transform"
            style={{ background: "#2d8a4e" }}
          >
            Installieren
          </button>
        </div>
      </div>
    </div>
  );
}

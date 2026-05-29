import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { getAllReceipts, deleteReceipt, type ReceiptRecord } from "@/lib/storage";
import { isNative } from "@/lib/platform";
import { openPdf, sharePdf } from "@/lib/pdf-actions";

// ── folder tree helpers ────────────────────────────────────

interface FolderNode {
  label:    string;
  fullPath: string;
  receipts: ReceiptRecord[];
  children: FolderNode[];
}

function buildTree(records: ReceiptRecord[]): FolderNode[] {
  const roots: Record<string, FolderNode> = {};

  for (const r of records) {
    const parts = r.folder.split("/");
    let level = roots;
    let parent: FolderNode | null = null;

    for (let i = 0; i < parts.length; i++) {
      const seg  = parts[i];
      const path = parts.slice(0, i + 1).join("/");
      if (!level[seg]) {
        const node: FolderNode = { label: seg, fullPath: path, receipts: [], children: [] };
        level[seg] = node;
        parent?.children.push(node);
        if (i === 0) roots[seg] = node;
      }
      if (i === parts.length - 1) level[seg].receipts.push(r);
      // @ts-expect-error – build children map on the fly
      level = level[seg]._childMap ??= {};
      parent = level[seg] ?? roots[seg];
    }
  }

  return Object.values(roots).sort((a, b) => {
    if (a.label === "Prüfen") return 1;
    if (b.label === "Prüfen") return -1;
    return a.label.localeCompare(b.label);
  });
}

function countReceipts(node: FolderNode): number {
  return node.receipts.length + node.children.reduce((s, c) => s + countReceipts(c), 0);
}

// ── receipt actions ────────────────────────────────────────

// openPdf / sharePdf imported from @/lib/pdf-actions
// They handle the Android content:// URI + FileProvider flow.

async function exportToFolder(r: ReceiptRecord) {
  try {
    if (isNative()) {
      const { Filesystem, Directory } = await import("@capacitor/filesystem");
      const { loadReceiptBlob }       = await import("@/lib/storage");
      const blob = await loadReceiptBlob(r);
      const reader = new FileReader();
      const b64 = await new Promise<string>((res, rej) => {
        reader.onload  = () => res((reader.result as string).split(",")[1]);
        reader.onerror = () => rej(reader.error);
        reader.readAsDataURL(blob);
      });
      await Filesystem.writeFile({
        path:      `Quittungsbox/${r.folder}/${r.fileName}`,
        data:      b64,
        directory: Directory.Documents,
        recursive: true,
      });
      alert(`Gespeichert unter:\nDokumente/Quittungsbox/${r.folder}/`);
    } else {
      const { loadReceiptBlob } = await import("@/lib/storage");
      const blob = await loadReceiptBlob(r);
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement("a"), { href: url, download: r.fileName });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    }
  } catch {
    alert("Fehler beim Speichern. Bitte nochmal versuchen.");
  }
}

// ── sub-components ─────────────────────────────────────────

type Action = "open" | "share" | "export";

function ActionBtn({
  icon, label, busy, onClick,
}: {
  icon: React.ReactNode;
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="flex-1 flex flex-col items-center gap-0.5 py-2 rounded-xl active:bg-accent disabled:opacity-40 transition-opacity"
      style={{ background: "hsl(0 0% 96%)" }}
    >
      {busy ? (
        <svg className="animate-spin w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4" strokeDashoffset="10"/>
        </svg>
      ) : icon}
      <span className="text-[10px] font-medium text-muted-foreground leading-none">{label}</span>
    </button>
  );
}

function ReceiptRow({ r, onDelete }: { r: ReceiptRecord; onDelete: () => void }) {
  const [busy, setBusy] = useState<Action | null>(null);

  async function run(action: Action, fn: () => Promise<void>) {
    setBusy(action);
    try { await fn(); } finally { setBusy(null); }
  }

  const isPrüfen = r.folder.startsWith("Prüfen");

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden mb-2">
      {/* File info */}
      <div className="px-3 pt-2.5 pb-2 flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-mono text-foreground truncate leading-tight">{r.fileName}</p>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {r.amount && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                {r.amount} CHF
              </span>
            )}
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
              {r.paymentType}
            </span>
            {isPrüfen && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                style={{ background: "hsl(45 100% 93%)", color: "hsl(30 80% 35%)" }}>
                ⚠️ Zu prüfen
              </span>
            )}
          </div>
        </div>
        {/* Delete */}
        <button
          onClick={onDelete}
          className="p-1.5 rounded-lg active:bg-muted text-muted-foreground shrink-0 mt-0.5"
          title="Löschen"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3,6 5,6 21,6"/>
            <path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4h6v2"/>
          </svg>
        </button>
      </div>

      {/* Action buttons */}
      <div className="flex gap-1 px-2 pb-2">
        <ActionBtn
          label="Öffnen"
          busy={busy === "open"}
          onClick={() => run("open", async () => {
            try { await openPdf(r); }
            catch { alert("PDF konnte nicht geöffnet werden."); }
          })}
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14,2 14,8 20,8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
            </svg>
          }
        />
        <ActionBtn
          label="Teilen"
          busy={busy === "share"}
          onClick={() => run("share", async () => {
            try { await sharePdf(r); }
            catch { alert("Teilen fehlgeschlagen."); }
          })}
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
          }
        />
        <ActionBtn
          label={isNative() ? "In Ordner" : "Download"}
          busy={busy === "export"}
          onClick={() => run("export", () => exportToFolder(r))}
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7,10 12,15 17,10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          }
        />
      </div>
    </div>
  );
}

function FolderSection({
  node, depth = 0, onDelete,
}: {
  node: FolderNode; depth?: number; onDelete: (id: string) => void;
}) {
  const total    = countReceipts(node);
  const isPrüfen = node.fullPath.startsWith("Prüfen");
  const [open, setOpen] = useState(depth < 2);

  return (
    <div className={depth === 0 ? "mb-4" : "mt-1"}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-1 py-1.5 rounded-lg active:bg-muted text-left"
      >
        {depth > 0 && <span style={{ width: depth * 14 }} className="shrink-0" />}

        <span className="text-base shrink-0">
          {depth === 0 && isPrüfen ? "⚠️" : depth === 0 ? "🗄️" : depth === 1 ? "📅" : "📁"}
        </span>

        <span className={`flex-1 font-semibold truncate ${
          isPrüfen && depth === 0 ? "text-amber-600" : "text-foreground"
        } ${depth === 0 ? "text-base" : depth === 1 ? "text-sm" : "text-xs"}`}>
          {node.label}
        </span>

        <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full shrink-0 ${
          isPrüfen ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"
        }`}>
          {total}
        </span>

        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 transition-transform duration-200 text-muted-foreground ${open ? "rotate-180" : ""}`}
        >
          <polyline points="6,9 12,15 18,9"/>
        </svg>
      </button>

      {open && (
        <div className={depth === 0 ? "mt-1" : ""}>
          {node.children.map(child => (
            <FolderSection key={child.fullPath} node={child} depth={depth + 1} onDelete={onDelete} />
          ))}
          {node.receipts.length > 0 && (
            <div className="mt-1" style={{ paddingLeft: (depth + 1) * 14 + 8 }}>
              {node.receipts
                .slice()
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map(r => (
                  <ReceiptRow
                    key={r.id}
                    r={r}
                    onDelete={() => onDelete(r.id)}
                  />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── main page ──────────────────────────────────────────────

export default function Archive() {
  const [, setLocation]  = useLocation();
  const [records, setRecords] = useState<ReceiptRecord[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setRecords(await getAllReceipts());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(id: string) {
    await deleteReceipt(id);
    setRecords(prev => prev.filter(r => r.id !== id));
  }

  const tree        = useMemo(() => buildTree(records), [records]);
  const total       = records.length;
  const prüfenCount = records.filter(r => r.folder.startsWith("Prüfen")).length;

  return (
    <div className="flex flex-col min-h-dvh bg-background">

      {/* Header */}
      <header className="px-4 pt-6 pb-3 flex items-center gap-3">
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
          <h1 className="text-xl font-bold text-foreground leading-none">Archiv</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {total === 0 ? "Keine Belege" : `${total} Beleg${total !== 1 ? "e" : ""}`}
            {prüfenCount > 0 && ` · ${prüfenCount} zu prüfen`}
          </p>
        </div>
        <button
          onClick={load}
          className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center active:bg-accent shrink-0"
          title="Aktualisieren"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1,4 1,10 7,10"/>
            <path d="M3.51 15a9 9 0 1 0 .49-3.51"/>
          </svg>
        </button>
      </header>

      {/* Alert bar for "Zu prüfen" */}
      {prüfenCount > 0 && (
        <div className="mx-4 mb-3 px-4 py-3 rounded-2xl flex items-center gap-3"
          style={{ background: "hsl(45 100% 95%)", border: "1px solid hsl(45 80% 80%)" }}>
          <span className="text-xl">⚠️</span>
          <div className="flex-1">
            <p className="text-sm font-semibold" style={{ color: "hsl(30 80% 35%)" }}>
              Zu prüfen: {prüfenCount} Beleg{prüfenCount !== 1 ? "e" : ""}
            </p>
            <p className="text-xs mt-0.5" style={{ color: "hsl(30 60% 45%)" }}>
              Datum oder OCR nicht erkannt — PDF trotzdem gespeichert
            </p>
          </div>
        </div>
      )}

      {/* Content */}
      <main className="flex-1 px-4 pb-8">
        {loading ? (
          <div className="flex justify-center pt-16">
            <svg className="animate-spin w-8 h-8 text-muted-foreground" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4" strokeDashoffset="10"/>
            </svg>
          </div>
        ) : total === 0 ? (
          <div className="flex flex-col items-center justify-center pt-20 gap-3 text-center">
            <span className="text-5xl">📭</span>
            <p className="text-base font-medium text-foreground">Noch keine Belege</p>
            <p className="text-sm text-muted-foreground px-8">Fotografiere deinen ersten Beleg mit dem Button auf der Startseite.</p>
          </div>
        ) : (
          <div className="pt-2">
            {tree.map(node => (
              <FolderSection key={node.fullPath} node={node} depth={0} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

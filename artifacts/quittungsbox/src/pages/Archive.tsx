import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { getAllReceipts, deleteReceipt, type ReceiptRecord } from "@/lib/storage";

// ── folder tree helpers ────────────────────────────────────

interface FolderNode {
  label:    string;
  fullPath: string;
  receipts: ReceiptRecord[];
  children: FolderNode[];
}

function buildTree(records: ReceiptRecord[]): FolderNode[] {
  // root nodes keyed by first path segment ("Archiv" | "Prüfen")
  const roots: Record<string, FolderNode> = {};

  for (const r of records) {
    const parts = r.folder.split("/"); // ["Archiv","2026","05 Mai"] or ["Prüfen","Kein Datum"]
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

  // Sort: Archiv before Prüfen; within Archiv: descending year/month
  return Object.values(roots).sort((a, b) => {
    if (a.label === "Prüfen") return 1;
    if (b.label === "Prüfen") return -1;
    return a.label.localeCompare(b.label);
  });
}

function countReceipts(node: FolderNode): number {
  return node.receipts.length + node.children.reduce((s, c) => s + countReceipts(c), 0);
}

// ── download / share ───────────────────────────────────────

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function shareOrDownload(r: ReceiptRecord) {
  const file = new File([r.pdfBlob], r.fileName, { type: "application/pdf" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: r.fileName }); return; } catch { /* fall through */ }
  }
  downloadBlob(r.pdfBlob, r.fileName);
}

// ── sub-components ─────────────────────────────────────────

function ReceiptRow({ r, onDelete }: { r: ReceiptRecord; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-2 py-2.5 px-3 rounded-xl bg-muted/60 border border-border">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-mono text-foreground truncate">{r.fileName}</p>
        {r.amount && (
          <p className="text-xs text-muted-foreground mt-0.5">
            {r.amount} CHF · {r.paymentType}
          </p>
        )}
      </div>
      <button
        onClick={() => shareOrDownload(r)}
        className="p-2 rounded-lg active:bg-muted text-muted-foreground shrink-0"
        title="Herunterladen / Teilen"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7,10 12,15 17,10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </button>
      <button
        onClick={onDelete}
        className="p-2 rounded-lg active:bg-muted text-muted-foreground shrink-0"
        title="Löschen"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3,6 5,6 21,6"/>
          <path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
      </button>
    </div>
  );
}

function FolderSection({
  node, depth = 0, onDelete,
}: {
  node: FolderNode; depth?: number; onDelete: (id: number) => void;
}) {
  const total    = countReceipts(node);
  const isPrüfen = node.fullPath.startsWith("Prüfen");
  const [open, setOpen] = useState(depth < 2); // auto-open top two levels

  return (
    <div className={depth === 0 ? "mb-4" : "mt-1"}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-1 py-1.5 rounded-lg active:bg-muted text-left"
      >
        {/* indent */}
        {depth > 0 && <span style={{ width: depth * 14 }} className="shrink-0" />}

        {/* icon */}
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
          {/* child folders */}
          {node.children.map(child => (
            <FolderSection key={child.fullPath} node={child} depth={depth + 1} onDelete={onDelete} />
          ))}
          {/* receipts at this level */}
          {node.receipts.length > 0 && (
            <div className="flex flex-col gap-1.5 mt-1" style={{ paddingLeft: (depth + 1) * 14 + 22 }}>
              {node.receipts
                .slice()
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map(r => (
                  <ReceiptRow
                    key={r.id}
                    r={r}
                    onDelete={() => r.id != null && onDelete(r.id)}
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

  async function handleDelete(id: number) {
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
              Datum oder OCR nicht erkannt
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

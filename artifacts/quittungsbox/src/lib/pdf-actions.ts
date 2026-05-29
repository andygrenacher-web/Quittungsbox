// Native-compatible PDF open and share.
//
// Problem with WebView on Android:
//   – blob: / object URLs cannot cross the WebView boundary
//   – navigator.share(File) has no effect in Capacitor WebView
//   – window.open(url, "_blank") is silently blocked
//
// Solution:
//   1. Write the PDF to the app-private Cache directory
//      (Capacitor's FileProvider already exposes this directory)
//   2. Obtain a content:// URI via Filesystem.getUri()
//   3. Open  → FileOpener.open()  triggers Android's intent system
//   4. Share → Share.share()      triggers Android's share sheet
//
// On web (Replit / PWA) we fall back to the blob URL / navigator.share approach.

import { isNative } from "./platform";
import { loadReceiptBlob, type ReceiptRecord } from "./storage";

const CACHE_DIR = "quittungsbox_share";

/** Write blob into app cache and return its content:// URI */
async function toCacheUri(blob: Blob, fileName: string): Promise<string> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");

  // base64-encode
  const b64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  const path = `${CACHE_DIR}/${fileName}`;

  await Filesystem.writeFile({
    path,
    data:      b64,
    directory: Directory.Cache,
    recursive: true,
  });

  const { uri } = await Filesystem.getUri({
    path,
    directory: Directory.Cache,
  });

  return uri;   // content://... — fully accessible to other Android apps
}

// ── public actions ─────────────────────────────────────────────────────────

export async function openPdfNative(record: ReceiptRecord): Promise<void> {
  const blob = await loadReceiptBlob(record);
  const uri  = await toCacheUri(blob, record.fileName);

  const { FileOpener } = await import("@capacitor-community/file-opener");
  await FileOpener.open({
    filePath:    uri,
    contentType: "application/pdf",
  });
}

export async function sharePdfNative(record: ReceiptRecord): Promise<void> {
  const blob = await loadReceiptBlob(record);
  const uri  = await toCacheUri(blob, record.fileName);

  const { Share } = await import("@capacitor/share");
  await Share.share({
    title: record.fileName,
    files: [uri],
  });
}

// ── web fallbacks ──────────────────────────────────────────────────────────

function openPdfWeb(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function sharePdfWeb(blob: Blob, fileName: string): Promise<void> {
  const file = new File([blob], fileName, { type: "application/pdf" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return;
    } catch { /* user cancelled or not supported — fall through */ }
  }
  // Last resort: trigger browser download
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement("a"), { href: url, download: fileName });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

// ── unified entry points (used by Archive.tsx) ─────────────────────────────

export async function openPdf(record: ReceiptRecord): Promise<void> {
  if (isNative()) {
    await openPdfNative(record);
  } else {
    const blob = await loadReceiptBlob(record);
    openPdfWeb(blob);
  }
}

export async function sharePdf(record: ReceiptRecord): Promise<void> {
  if (isNative()) {
    await sharePdfNative(record);
  } else {
    const blob = await loadReceiptBlob(record);
    await sharePdfWeb(blob, record.fileName);
  }
}

// Camera + document capture abstraction.
//
// On Android (Capacitor native):
//   Uses ML Kit Document Scanner — opens native camera UI with automatic edge
//   detection and perspective correction. Returns a pre-cropped image.
//   Fallback: plain camera if the document scanner is unavailable.
//
// On web / Replit PWA:
//   Returns null; Home.tsx uses <input type="file"> as fallback.

import { Capacitor } from "@capacitor/core";
import { isNative } from "./platform";

export interface CaptureResult {
  blob:             Blob;
  mimeType:         string;
  /** true when ML Kit Document Scanner already corrected perspective & cropping */
  alreadyCorrected: boolean;
}

/**
 * Capture a receipt photo.
 * Returns null on web (caller uses <input> fallback).
 * Throws if the user cancels — caller should catch silently.
 */
export async function capturePhoto(): Promise<CaptureResult | null> {
  if (!isNative()) return null;

  // Try ML Kit Document Scanner first (best quality)
  try {
    return await captureWithDocumentScanner();
  } catch (err) {
    // If document scanner is unavailable (no Play Services, old device, etc.),
    // fall back to plain camera.
    const msg = err instanceof Error ? err.message : String(err);
    if (/cancelled|cancel/i.test(msg)) throw err; // propagate cancellations
    console.warn("[capture] Document scanner failed, falling back to camera:", msg);
    return captureWithCamera();
  }
}

// ── ML Kit Document Scanner ───────────────────────────────────────────────────

async function captureWithDocumentScanner(): Promise<CaptureResult | null> {
  const { DocumentScanner } = await import("@capacitor-mlkit/document-scanner");

  const { scannedImages } = await DocumentScanner.scanDocument({
    pageLimit:            1,
    galleryImportAllowed: true,
  });

  if (!scannedImages?.length) return null;

  const filePath = scannedImages[0]; // e.g. file:///data/.../cache/...jpg

  // Read via Filesystem plugin (most reliable on Android — no WebView CORS issues)
  try {
    const { Filesystem } = await import("@capacitor/filesystem");
    const { data } = await Filesystem.readFile({ path: filePath });
    const blob = base64ToBlob(
      typeof data === "string" ? data : await (data as Blob).text(),
      "image/jpeg"
    );
    return { blob, mimeType: "image/jpeg", alreadyCorrected: true };
  } catch {
    // Fallback: load via WebView URL
    const webUri = Capacitor.convertFileSrc(filePath);
    return loadImageToBlob(webUri, true);
  }
}

// ── Plain camera fallback ─────────────────────────────────────────────────────

async function captureWithCamera(): Promise<CaptureResult | null> {
  const { Camera, CameraResultType, CameraSource } = await import("@capacitor/camera");

  const photo = await Camera.getPhoto({
    quality:            90,
    allowEditing:       false,
    resultType:         CameraResultType.DataUrl,
    source:             CameraSource.Camera,
    correctOrientation: true,
    presentationStyle:  "fullscreen",
  });

  if (!photo.dataUrl) return null;
  const blob = dataUrlToBlob(photo.dataUrl);
  return { blob, mimeType: "image/jpeg", alreadyCorrected: false };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function loadImageToBlob(src: string, alreadyCorrected: boolean): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")!.drawImage(img, 0, 0);
      canvas.toBlob(
        blob => blob
          ? resolve({ blob, mimeType: "image/jpeg", alreadyCorrected })
          : reject(new Error("canvas.toBlob returned null")),
        "image/jpeg",
        0.92
      );
    };
    img.onerror = () => reject(new Error("Failed to load captured image from: " + src));
    img.src = src;
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, b64] = dataUrl.split(",");
  const mime   = header.match(/:(.*?);/)?.[1] ?? "image/jpeg";
  const bytes  = atob(b64);
  const buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
  return new Blob([buffer], { type: mime });
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const b64 = base64.includes(",") ? base64.split(",")[1] : base64;
  const bytes  = atob(b64);
  const buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
  return new Blob([buffer], { type: mimeType });
}

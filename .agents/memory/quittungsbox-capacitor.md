---
name: Quittungsbox Capacitor ML Kit packages
description: Which @capacitor-mlkit packages exist on npm, Capacitor 8 versions, and the alreadyCorrected capture pattern
---

## Available @capacitor-mlkit packages (as of 2026-05)

These exist at version 8.1.0 under `@capacitor-mlkit/` scope:
- `@capacitor-mlkit/document-scanner` ✅ (camera + edge detection + perspective correction)
- `@capacitor-mlkit/barcode-scanning` ✅
- `@capacitor-mlkit/face-detection` ✅
- `@capacitor-mlkit/translation` ✅

**Why:** `@capacitor-mlkit/text-recognition` does NOT exist as a free npm package. ML Kit Text Recognition from capawesome appears to be a paid "Insider" plugin. Tesseract.js is used instead.

## Capacitor 8 stable versions (2026-05)

- `@capacitor/core`: 8.3.4
- `@capacitor/cli`: 8.3.4
- `@capacitor/camera`: 8.2.0
- `@capacitor/filesystem`: 8.1.2
- `@capacitor/preferences`: 8.0.1
- `@capacitor/android`: 8.x

## alreadyCorrected pattern

`CaptureResult.alreadyCorrected = true` when ML Kit Document Scanner returned the image (perspective already fixed). Home.tsx calls `prepareScannedImage()` (skips document detection) instead of `scanImage()`.

**Why:** Running our canvas-based document detection on an already-corrected image can degrade quality (double warp).

**How to apply:** Any new capture source that does its own perspective correction should set `alreadyCorrected: true` in the returned `CaptureResult`.

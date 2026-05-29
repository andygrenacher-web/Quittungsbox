import { jsPDF } from "jspdf";

const A4_W = 210; // mm
const A4_H = 297; // mm

function fitToA4(imgW: number, imgH: number): { w: number; h: number; x: number; y: number } {
  const imgAspect = imgW / imgH;
  const a4Aspect  = A4_W / A4_H;
  let w: number, h: number;
  if (imgAspect > a4Aspect) {
    w = A4_W; h = A4_W / imgAspect;
  } else {
    h = A4_H; w = A4_H * imgAspect;
  }
  return { w, h, x: (A4_W - w) / 2, y: (A4_H - h) / 2 };
}

function addInvisibleText(pdf: jsPDF, text: string): void {
  if (!text.trim()) return;
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(3);
  let y = 2;
  for (const line of text.split("\n").filter(Boolean)) {
    if (y > A4_H - 2) break;
    pdf.text(line.slice(0, 200), 1, y);
    y += 1.4;
  }
}

// Accept a pre-processed canvas (from scanner.ts)
export async function generatePdfFromCanvas(
  canvas: HTMLCanvasElement,
  ocrText: string
): Promise<Blob> {
  const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
  const { w, h, x, y } = fitToA4(canvas.width, canvas.height);

  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  pdf.setFillColor(255, 255, 255);
  pdf.rect(0, 0, A4_W, A4_H, "F");
  pdf.addImage(dataUrl, "JPEG", x, y, w, h);
  addInvisibleText(pdf, ocrText);

  return pdf.output("blob");
}

// Legacy: accept a raw image blob (kept for compatibility)
export async function generatePdf(imageBlob: Blob, ocrText: string): Promise<Blob> {
  const url = URL.createObjectURL(imageBlob);
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => { URL.revokeObjectURL(url); res(i); };
    i.onerror = rej;
    i.src = url;
  });

  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 2480 / Math.max(img.width, img.height));
  canvas.width  = Math.round(img.width  * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);

  return generatePdfFromCanvas(canvas, ocrText);
}

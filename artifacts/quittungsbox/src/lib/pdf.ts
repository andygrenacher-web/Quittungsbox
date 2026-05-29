import { jsPDF } from "jspdf";

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = reject;
    img.src = url;
  });
}

function imageToDataUrl(img: HTMLImageElement, maxDimension = 2480): string {
  const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.82);
}

export async function generatePdf(imageBlob: Blob, ocrText: string): Promise<Blob> {
  const img = await loadImage(imageBlob);
  const dataUrl = imageToDataUrl(img);

  const A4_W = 210;
  const A4_H = 297;

  const imgAspect = img.width / img.height;
  const a4Aspect = A4_W / A4_H;

  let imgW: number, imgH: number, offsetX: number, offsetY: number;
  if (imgAspect > a4Aspect) {
    imgW = A4_W;
    imgH = A4_W / imgAspect;
    offsetX = 0;
    offsetY = (A4_H - imgH) / 2;
  } else {
    imgH = A4_H;
    imgW = A4_H * imgAspect;
    offsetX = (A4_W - imgW) / 2;
    offsetY = 0;
  }

  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  // White background
  pdf.setFillColor(255, 255, 255);
  pdf.rect(0, 0, A4_W, A4_H, "F");

  // Receipt image
  pdf.addImage(dataUrl, "JPEG", offsetX, offsetY, imgW, imgH);

  // Invisible OCR text layer for searchability
  if (ocrText.trim()) {
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(4);
    const lines = ocrText.split("\n").filter(Boolean);
    let y = 2;
    for (const line of lines) {
      if (y > A4_H - 2) break;
      pdf.text(line, 1, y);
      y += 1.5;
    }
  }

  return pdf.output("blob");
}

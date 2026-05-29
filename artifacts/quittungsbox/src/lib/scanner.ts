// Pure-canvas document scanner:
//  1. Load image
//  2. Edge detection on downsampled copy → find document quad
//  3. Perspective-correct the full-res copy
//  4. Enhance contrast (grayscale + S-curve)
//  Falls back gracefully if detection fails.

export interface ScanResult {
  canvas: HTMLCanvasElement;
  corrected: boolean;
}

interface Pt { x: number; y: number }
type Quad = [Pt, Pt, Pt, Pt]; // TL, TR, BR, BL

// ── helpers ────────────────────────────────────────────────

function loadImg(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = rej;
    img.src = url;
  });
}

function imgToCanvas(img: HTMLImageElement, maxDim: number): HTMLCanvasElement {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d")!.drawImage(img, 0, 0, w, h);
  return c;
}

// ── grayscale ──────────────────────────────────────────────

function toGray(data: Uint8ClampedArray, n: number): Uint8Array {
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    g[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return g;
}

// ── 5×5 Gaussian blur ──────────────────────────────────────

const GAUSS5 = [1,4,6,4,1, 4,16,24,16,4, 6,24,36,24,6, 4,16,24,16,4, 1,4,6,4,1];
const GAUSS5_SUM = 256;

function blur5(g: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(g.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ny = Math.max(0, Math.min(h - 1, y + dy));
          const nx = Math.max(0, Math.min(w - 1, x + dx));
          s += g[ny * w + nx] * GAUSS5[(dy + 2) * 5 + (dx + 2)];
        }
      }
      o[y * w + x] = s / GAUSS5_SUM;
    }
  }
  return o;
}

// ── Sobel edges ────────────────────────────────────────────

function sobel(g: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(g.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const tl = g[(y-1)*w+(x-1)], t = g[(y-1)*w+x], tr = g[(y-1)*w+(x+1)];
      const ml = g[y*w+(x-1)],                         mr = g[y*w+(x+1)];
      const bl = g[(y+1)*w+(x-1)], b = g[(y+1)*w+x], br = g[(y+1)*w+(x+1)];
      const gx = -tl - 2*ml - bl + tr + 2*mr + br;
      const gy = -tl - 2*t  - tr + bl + 2*b  + br;
      o[y * w + x] = Math.min(255, Math.sqrt(gx*gx + gy*gy));
    }
  }
  return o;
}

// ── dilate 3×3 ─────────────────────────────────────────────

function dilate(src: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(src.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const v = src[(y+dy)*w+(x+dx)];
          if (v > m) m = v;
        }
      o[y * w + x] = m;
    }
  }
  return o;
}

// ── document quad detection ────────────────────────────────

function dist(a: Pt, b: Pt) { return Math.hypot(a.x-b.x, a.y-b.y); }

function detectQuad(edges: Uint8Array, w: number, h: number): Quad | null {
  // Collect edge pixels at every step-th pixel (keep ≤5000 pts for speed)
  const step = Math.max(1, Math.ceil(Math.sqrt(edges.length) / 70));
  const pts: Pt[] = [];
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step)
      if (edges[y * w + x] > 128) pts.push({ x, y });

  if (pts.length < 30) return null;

  // Centroid
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;

  // Farthest point per quadrant from centroid
  let tl = { x: cx, y: cy }, tr = { x: cx, y: cy };
  let bl = { x: cx, y: cy }, br = { x: cx, y: cy };
  let dlTL = 0, dlTR = 0, dlBL = 0, dlBR = 0;

  for (const p of pts) {
    const dx = p.x - cx, dy = p.y - cy;
    const d = dx*dx + dy*dy;
    if (dx <= 0 && dy <= 0 && d > dlTL) { tl = p; dlTL = d; }
    if (dx >= 0 && dy <= 0 && d > dlTR) { tr = p; dlTR = d; }
    if (dx <= 0 && dy >= 0 && d > dlBL) { bl = p; dlBL = d; }
    if (dx >= 0 && dy >= 0 && d > dlBR) { br = p; dlBR = d; }
  }

  // Shoelace area check
  const area = 0.5 * Math.abs(
    (tl.x*(tr.y-bl.y) + tr.x*(br.y-tl.y) + br.x*(bl.y-tr.y) + bl.x*(tl.y-br.y))
  );
  const imgArea = w * h;
  if (area < imgArea * 0.07 || area > imgArea * 0.95) return null;

  // Sanity: all four corners must be somewhat separated
  if (dist(tl,tr) < w*0.1 || dist(tl,bl) < h*0.1) return null;

  return [tl, tr, br, bl];
}

// ── homography (Gaussian elimination) ─────────────────────

function gaussElim(A: number[][], b: number[]): number[] {
  const n = b.length;
  const a = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let maxR = col;
    for (let r = col+1; r < n; r++)
      if (Math.abs(a[r][col]) > Math.abs(a[maxR][col])) maxR = r;
    [a[col], a[maxR]] = [a[maxR], a[col]];
    const pivot = a[col][col];
    if (Math.abs(pivot) < 1e-10) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col] / pivot;
      for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

function homography(src: Quad, dst: Quad): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]; const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u*x, -u*y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v*x, -v*y]); b.push(v);
  }
  const h = gaussElim(A, b);
  return [...h, 1];
}

function applyH(H: number[], x: number, y: number): Pt {
  const w = H[6]*x + H[7]*y + H[8];
  return { x: (H[0]*x + H[1]*y + H[2]) / w, y: (H[3]*x + H[4]*y + H[5]) / w };
}

// ── perspective warp ───────────────────────────────────────

function warp(src: HTMLCanvasElement, quad: Quad, procScale: number): HTMLCanvasElement {
  // Scale quad from proc-canvas coords → full-res coords
  const s = 1 / procScale;
  const [tl, tr, br, bl] = quad.map(p => ({ x: p.x * s, y: p.y * s })) as Quad;

  const W = Math.round(Math.max(dist(tl,tr), dist(bl,br)));
  const H = Math.round(Math.max(dist(tl,bl), dist(tr,br)));
  if (W < 50 || H < 50) throw new Error("warp too small");

  const dstQuad: Quad = [{ x:0,y:0 }, { x:W,y:0 }, { x:W,y:H }, { x:0,y:H }];
  const Hinv = homography(dstQuad, [tl, tr, br, bl]);

  const sw = src.width, sh = src.height;
  const srcData = src.getContext("2d")!.getImageData(0, 0, sw, sh).data;

  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const outCtx = out.getContext("2d")!;
  const outImg = outCtx.createImageData(W, H);
  const od = outImg.data;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const { x: sx, y: sy } = applyH(Hinv, x, y);
      const di = (y * W + x) * 4;
      if (sx < 0 || sx >= sw - 1 || sy < 0 || sy >= sh - 1) {
        od[di] = od[di+1] = od[di+2] = 255; od[di+3] = 255;
        continue;
      }
      const x0 = sx | 0, y0 = sy | 0;
      const fx = sx - x0, fy = sy - y0;
      const x1 = x0 + 1, y1 = y0 + 1;
      for (let c = 0; c < 3; c++) {
        const v00 = srcData[(y0*sw+x0)*4+c], v10 = srcData[(y0*sw+x1)*4+c];
        const v01 = srcData[(y1*sw+x0)*4+c], v11 = srcData[(y1*sw+x1)*4+c];
        od[di+c] = ((v00*(1-fx)*(1-fy) + v10*fx*(1-fy) + v01*(1-fx)*fy + v11*fx*fy) | 0);
      }
      od[di+3] = 255;
    }
  }

  outCtx.putImageData(outImg, 0, 0);
  return out;
}

// ── scan enhancement ───────────────────────────────────────
// Uses adaptive thresholding (integral image → O(n) after O(n) setup).
// Each pixel is compared to its local neighbourhood mean minus a constant C.
// Result: clean black-on-white scan, dark backgrounds become white.

function adaptiveThreshold(
  gray: Uint8Array,
  w: number, h: number,
  blockSize = 31,  // odd, ~2% of typical receipt width
  C = 12,          // subtract from local mean before comparison
): Uint8Array {
  // Build summed-area table (integral image) with 1-pixel border
  const stride = w + 1;
  const II = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      II[(y + 1) * stride + (x + 1)] =
        gray[y * w + x] +
        II[y * stride + (x + 1)] +
        II[(y + 1) * stride + x] -
        II[y * stride + x];
    }
  }

  const out = new Uint8Array(w * h);
  const half = blockSize >> 1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half);
      const y1 = Math.max(0, y - half);
      const x2 = Math.min(w - 1, x + half);
      const y2 = Math.min(h - 1, y + half);
      const n = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum =
        II[(y2 + 1) * stride + (x2 + 1)] -
        II[y1 * stride + (x2 + 1)] -
        II[(y2 + 1) * stride + x1] +
        II[y1 * stride + x1];
      out[y * w + x] = gray[y * w + x] >= (sum / n - C) ? 255 : 0;
    }
  }
  return out;
}

function enhance(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const n = canvas.width * canvas.height;

  // Step 1 – grayscale
  const gray = new Uint8Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    gray[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }

  // Step 2 – adaptive threshold
  const bw = adaptiveThreshold(gray, canvas.width, canvas.height);

  // Step 3 – write back as greyscale (keeps JPEG encoder happy vs pure 1-bit)
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    d[i] = d[i + 1] = d[i + 2] = bw[j];
    d[i + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
}

// ── main ───────────────────────────────────────────────────

export async function scanImage(imageBlob: Blob): Promise<ScanResult> {
  try {
    const img = await loadImg(imageBlob);

    // Full-res canvas for the actual warp
    const fullCanvas = imgToCanvas(img, 1600);

    // Smaller canvas for edge detection (faster)
    const procCanvas = imgToCanvas(img, 700);
    const pw = procCanvas.width, ph = procCanvas.height;
    const procData = procCanvas.getContext("2d")!.getImageData(0, 0, pw, ph);

    const gray    = toGray(procData.data, pw * ph);
    const blurred = blur5(gray, pw, ph);
    const edges   = sobel(blurred, pw, ph);

    // Auto-threshold at top-30% of edge magnitudes
    const sorted = Array.from(edges).filter(v => v > 0).sort((a, b) => a - b);
    const thresh = sorted.length ? sorted[Math.floor(sorted.length * 0.70)] : 40;
    const binary = new Uint8Array(edges.length);
    for (let i = 0; i < edges.length; i++) binary[i] = edges[i] > thresh ? 255 : 0;

    const dilated = dilate(dilate(binary, pw, ph), pw, ph);

    const procScale = pw / fullCanvas.width; // proc-canvas / full-res
    const quad = detectQuad(dilated, pw, ph);

    let result: HTMLCanvasElement;
    let corrected = false;

    if (quad) {
      result = warp(fullCanvas, quad, procScale);
      corrected = true;
    } else {
      result = fullCanvas;
    }

    enhance(result);
    return { canvas: result, corrected };
  } catch {
    // Last-resort fallback
    const img = await loadImg(imageBlob);
    const c = imgToCanvas(img, 1600);
    enhance(c);
    return { canvas: c, corrected: false };
  }
}

export function canvasToBlob(canvas: HTMLCanvasElement, quality = 0.88): Promise<Blob> {
  return new Promise((res, rej) =>
    canvas.toBlob(b => b ? res(b) : rej(new Error("toBlob failed")), "image/jpeg", quality)
  );
}

export function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/jpeg", 0.82);
}

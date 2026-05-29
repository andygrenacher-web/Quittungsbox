// Pure-canvas document scanner
// Pipeline: load → resize → (try perspective warp) → apply chosen enhancement
// Quad detection is deliberately conservative: false-negative (no warp) is
// always better than a false-positive (wrong warp distorts the image).

export interface ScanResult {
  /** Color canvas, warped or full — keep as source for mode switching */
  rawCanvas: HTMLCanvasElement;
  /** Gentle grayscale version — default display & OCR input */
  canvas: HTMLCanvasElement;
  corrected: boolean;
}

interface Pt { x: number; y: number }
type Quad = [Pt, Pt, Pt, Pt]; // TL TR BR BL

// ── image helpers ───────────────────────────────────────────

function loadImg(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img  = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = rej;
    img.src = url;
  });
}

function imgToCanvas(img: HTMLImageElement, maxDim: number): HTMLCanvasElement {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width  * scale);
  const h = Math.round(img.height * scale);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d")!.drawImage(img, 0, 0, w, h);
  return c;
}

function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width; c.height = src.height;
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}

// ── grayscale ───────────────────────────────────────────────

function toGray(data: Uint8ClampedArray, n: number): Uint8Array {
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++)
    g[j] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
  return g;
}

// ── integral-image box blur ─────────────────────────────────

function boxBlur(src: Uint8Array, w: number, h: number, r: number): Float32Array {
  const stride = w + 1;
  const II = new Float32Array(stride * (h + 1));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      II[(y+1)*stride+(x+1)] = src[y*w+x] + II[y*stride+(x+1)] + II[(y+1)*stride+x] - II[y*stride+x];
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x-r), y1 = Math.max(0, y-r);
      const x2 = Math.min(w-1, x+r), y2 = Math.min(h-1, y+r);
      const cnt = (x2-x1+1) * (y2-y1+1);
      out[y*w+x] = (II[(y2+1)*stride+(x2+1)] - II[y1*stride+(x2+1)]
                  - II[(y2+1)*stride+x1]      + II[y1*stride+x1]) / cnt;
    }
  }
  return out;
}

// ── edge detection ──────────────────────────────────────────

const GAUSS5 = [1,4,6,4,1, 4,16,24,16,4, 6,24,36,24,6, 4,16,24,16,4, 1,4,6,4,1];
function blur5(g: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(g.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          s += g[Math.max(0,Math.min(h-1,y+dy))*w+Math.max(0,Math.min(w-1,x+dx))] * GAUSS5[(dy+2)*5+(dx+2)];
      o[y*w+x] = s / 256;
    }
  return o;
}

function sobel(g: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(g.length);
  for (let y = 1; y < h-1; y++)
    for (let x = 1; x < w-1; x++) {
      const tl=g[(y-1)*w+(x-1)], t=g[(y-1)*w+x], tr=g[(y-1)*w+(x+1)];
      const ml=g[y*w+(x-1)],                       mr=g[y*w+(x+1)];
      const bl=g[(y+1)*w+(x-1)], b=g[(y+1)*w+x], br=g[(y+1)*w+(x+1)];
      const gx = -tl-2*ml-bl+tr+2*mr+br;
      const gy = -tl-2*t -tr+bl+2*b +br;
      o[y*w+x] = Math.min(255, Math.sqrt(gx*gx+gy*gy));
    }
  return o;
}

function dilate(src: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(src.length);
  for (let y = 1; y < h-1; y++)
    for (let x = 1; x < w-1; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) { const v=src[(y+dy)*w+(x+dx)]; if (v>m) m=v; }
      o[y*w+x] = m;
    }
  return o;
}

// ── conservative quad detection ────────────────────────────
// Returns null whenever confidence is low.
// A missed detection is fine (full image used). A bad detection is not.

function dist(a: Pt, b: Pt) { return Math.hypot(a.x-b.x, a.y-b.y); }

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x-o.x)*(b.y-o.y) - (a.y-o.y)*(b.x-o.x);
}

function detectQuad(edges: Uint8Array, w: number, h: number): Quad | null {
  const step = Math.max(1, Math.ceil(Math.sqrt(edges.length) / 70));
  const pts: Pt[] = [];
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step)
      if (edges[y*w+x] > 128) pts.push({ x, y });

  if (pts.length < 60) return null;

  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;

  let tl=({x:cx,y:cy}), tr=({x:cx,y:cy}), bl=({x:cx,y:cy}), br=({x:cx,y:cy});
  let dlTL=0, dlTR=0, dlBL=0, dlBR=0;
  for (const p of pts) {
    const dx=p.x-cx, dy=p.y-cy, d=dx*dx+dy*dy;
    if (dx<=0&&dy<=0&&d>dlTL) { tl=p; dlTL=d; }
    if (dx>=0&&dy<=0&&d>dlTR) { tr=p; dlTR=d; }
    if (dx<=0&&dy>=0&&d>dlBL) { bl=p; dlBL=d; }
    if (dx>=0&&dy>=0&&d>dlBR) { br=p; dlBR=d; }
  }

  // ① All four corners must be well-separated from each other
  const minW = w * 0.25, minH = h * 0.25;
  if (dist(tl,tr) < minW || dist(bl,br) < minW) return null;
  if (dist(tl,bl) < minH || dist(tr,br) < minH) return null;
  if (dist(tl,br) < Math.hypot(minW,minH) * 0.8) return null;
  if (dist(tr,bl) < Math.hypot(minW,minH) * 0.8) return null;

  // ② Shoelace area: require 20 %–92 % of image (conservative floor)
  const area = 0.5 * Math.abs(
    tl.x*(tr.y-bl.y) + tr.x*(br.y-tl.y) + br.x*(bl.y-tr.y) + bl.x*(tl.y-br.y)
  );
  if (area < w*h*0.20 || area > w*h*0.92) return null;

  // ③ Convexity: all cross products of consecutive edges must have same sign
  const quad: Quad = [tl, tr, br, bl];
  const signs = [
    cross(tl, tr, br), cross(tr, br, bl), cross(br, bl, tl), cross(bl, tl, tr),
  ].map(v => Math.sign(v));
  if (signs.some(s => s !== signs[0])) return null;

  return quad;
}

// ── homography + warp ───────────────────────────────────────

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
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const {x,y}=src[i], {x:u,y:v}=dst[i];
    A.push([x,y,1,0,0,0,-u*x,-u*y]); b.push(u);
    A.push([0,0,0,x,y,1,-v*x,-v*y]); b.push(v);
  }
  return [...gaussElim(A, b), 1];
}

function applyH(H: number[], x: number, y: number): Pt {
  const w = H[6]*x + H[7]*y + H[8];
  return { x: (H[0]*x+H[1]*y+H[2])/w, y: (H[3]*x+H[4]*y+H[5])/w };
}

function warp(src: HTMLCanvasElement, quad: Quad, procScale: number): HTMLCanvasElement {
  const s = 1 / procScale;
  const [tl,tr,br,bl] = quad.map(p => ({ x: p.x*s, y: p.y*s })) as Quad;
  const W = Math.round(Math.max(dist(tl,tr), dist(bl,br)));
  const H = Math.round(Math.max(dist(tl,bl), dist(tr,br)));
  if (W < 80 || H < 80) throw new Error("warp too small");

  const dstQ: Quad = [{x:0,y:0},{x:W,y:0},{x:W,y:H},{x:0,y:H}];
  const Hinv = homography(dstQ, [tl,tr,br,bl]);
  const sw = src.width, sh = src.height;
  const srcData = src.getContext("2d")!.getImageData(0,0,sw,sh).data;

  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const outCtx = out.getContext("2d")!;
  const outImg = outCtx.createImageData(W, H);
  const od = outImg.data;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const {x:sx,y:sy} = applyH(Hinv, x, y);
      const di = (y*W+x)*4;
      if (sx<0||sx>=sw-1||sy<0||sy>=sh-1) { od[di]=od[di+1]=od[di+2]=255; od[di+3]=255; continue; }
      const x0=sx|0, y0=sy|0, fx=sx-x0, fy=sy-y0, x1=x0+1, y1=y0+1;
      for (let c = 0; c < 3; c++) {
        const v00=srcData[(y0*sw+x0)*4+c], v10=srcData[(y0*sw+x1)*4+c];
        const v01=srcData[(y1*sw+x0)*4+c], v11=srcData[(y1*sw+x1)*4+c];
        od[di+c] = (v00*(1-fx)*(1-fy)+v10*fx*(1-fy)+v01*(1-fx)*fy+v11*fx*fy)|0;
      }
      od[di+3] = 255;
    }
  }
  outCtx.putImageData(outImg, 0, 0);
  return out;
}

// ── enhancement modes ───────────────────────────────────────
// applyOriginal — colour, no processing (just return a clone)
// applyGrau     — natural grayscale + mild brightness + light sharpen (DEFAULT)
// applyScan     — grayscale + background normalisation + more sharpening

export function applyOriginal(src: HTMLCanvasElement): HTMLCanvasElement {
  return cloneCanvas(src);
}

export function applyGrau(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = cloneCanvas(src);
  const ctx  = out.getContext("2d")!;
  const { width: w, height: h } = out;
  const img  = ctx.getImageData(0, 0, w, h);
  const d    = img.data;
  const n    = w * h;

  // ① Grayscale
  const gray = toGray(d, n);

  // ② Mild gamma (0.92): makes paper slightly whiter without crushing shadows
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++)
    lut[v] = Math.round(Math.pow(v/255, 0.92) * 255);
  const bright = new Uint8Array(n);
  for (let i = 0; i < n; i++) bright[i] = lut[gray[i]];

  // ③ Light unsharp mask (radius 1, amount 0.7)
  const blurred = boxBlur(bright, w, h, 1);
  const result  = new Uint8Array(n);
  for (let i = 0; i < n; i++)
    result[i] = Math.max(0, Math.min(255, Math.round(bright[i] + 0.7*(bright[i]-blurred[i]))));

  // Write back
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    d[i] = d[i+1] = d[i+2] = result[j]; d[i+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

export function applyScan(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = cloneCanvas(src);
  const ctx  = out.getContext("2d")!;
  const { width: w, height: h } = out;
  const img  = ctx.getImageData(0, 0, w, h);
  const d    = img.data;
  const n    = w * h;

  // ① Grayscale
  const gray = toGray(d, n);

  // ② Background normalisation (gentle): pixel / max(bg, 90) × 235
  //    bg radius ~4% of shorter dimension — removes shadows, uneven light
  const bgR = Math.max(20, Math.round(Math.min(w,h) * 0.04));
  const bg   = boxBlur(gray, w, h, bgR);
  const norm = new Uint8Array(n);
  for (let i = 0; i < n; i++)
    norm[i] = Math.min(255, (gray[i] / Math.max(90, bg[i])) * 235) | 0;

  // ③ Histogram stretch — 5 %–95 % percentile, capped expansion
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[norm[i]]++;
  let lo = 0, hi = 255, cum = 0;
  for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum < n*0.05) lo = v; }
  cum = 0;
  for (let v = 255; v >= 0; v--) { cum += hist[v]; if (cum < n*0.05) hi = v; }
  const rng = Math.max(1, hi - lo);
  const stretched = new Uint8Array(n);
  for (let i = 0; i < n; i++)
    stretched[i] = Math.max(0, Math.min(255, ((norm[i]-lo)/rng*255)|0));

  // ④ Unsharp mask (radius 2, amount 1.2)
  const blurred = boxBlur(stretched, w, h, 2);
  const result  = new Uint8Array(n);
  for (let i = 0; i < n; i++)
    result[i] = Math.max(0, Math.min(255, Math.round(stretched[i] + 1.2*(stretched[i]-blurred[i]))));

  for (let i = 0, j = 0; j < n; i += 4, j++) {
    d[i] = d[i+1] = d[i+2] = result[j]; d[i+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

// ── main ────────────────────────────────────────────────────

export async function scanImage(imageBlob: Blob): Promise<ScanResult> {
  const img = await loadImg(imageBlob);

  // Full-res colour canvas (used for warp + kept as rawCanvas)
  const fullCanvas = imgToCanvas(img, 1600);

  // Smaller canvas just for edge detection
  const procCanvas = imgToCanvas(img, 700);
  const pw = procCanvas.width, ph = procCanvas.height;
  const procData = procCanvas.getContext("2d")!.getImageData(0, 0, pw, ph);

  const gray    = toGray(procData.data, pw*ph);
  const blurred = blur5(gray, pw, ph);
  const edges   = sobel(blurred, pw, ph);

  // Auto-threshold at top 30 % of edge magnitudes
  const sorted = Array.from(edges).filter(v => v > 0).sort((a,b) => a-b);
  const thresh = sorted.length ? sorted[Math.floor(sorted.length*0.70)] : 40;
  const binary = edges.map(v => v > thresh ? 255 : 0);
  const dilated = dilate(dilate(new Uint8Array(binary), pw, ph), pw, ph);

  const procScale = pw / fullCanvas.width;
  const quad      = detectQuad(dilated, pw, ph);

  let rawCanvas: HTMLCanvasElement;
  let corrected = false;

  if (quad) {
    try {
      rawCanvas = warp(fullCanvas, quad, procScale);
      corrected = true;
    } catch {
      rawCanvas = fullCanvas;
    }
  } else {
    rawCanvas = fullCanvas;
  }

  // Default: gentle grayscale (used for OCR and default display)
  const canvas = applyGrau(rawCanvas);
  return { rawCanvas, canvas, corrected };
}

// ── utilities ───────────────────────────────────────────────

export function canvasToBlob(canvas: HTMLCanvasElement, quality = 0.88): Promise<Blob> {
  return new Promise((res, rej) =>
    canvas.toBlob(b => b ? res(b) : rej(new Error("toBlob failed")), "image/jpeg", quality)
  );
}

export function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/jpeg", 0.82);
}

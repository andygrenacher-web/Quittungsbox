// Document scanner – pure canvas, no external CV library.
//
// Detection pipeline (two methods, best wins):
//   PRIMARY  — brightness thresholding (Otsu) + morphological close → bright region corners
//              Works when receipt is lighter than background (most phone photos).
//   FALLBACK — Sobel edges + corner extraction
//              Works when brightness contrast is low (light table, similar brightness).
//
// Corner extraction (both methods use this):
//   TL = min(x+y)  TR = max(x−y)  BR = max(x+y)  BL = min(x−y)
//   This is the standard approach used by Adobe Scan / Office Lens.
//
// Enhancement modes (exported, used by UI for mode switcher):
//   applyOriginal  — colour, no filter
//   applyGrau      — natural grayscale + mild gamma + light sharpen  ← DEFAULT
//   applyScan      — grayscale + background normalisation + more contrast

export interface ScanResult {
  rawCanvas: HTMLCanvasElement;  // warped colour — source for mode switching
  canvas:    HTMLCanvasElement;  // applyGrau result — default display + OCR input
  corrected: boolean;
}

interface Pt   { x: number; y: number }
type     Quad  = [Pt, Pt, Pt, Pt]        // TL TR BR BL

// ── image utilities ──────────────────────────────────────────────────────────

function loadImg(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = rej;
    img.src = url;
  });
}

function resizeToCanvas(img: HTMLImageElement, maxDim: number): HTMLCanvasElement {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width  = Math.round(img.width  * scale);
  c.height = Math.round(img.height * scale);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width; c.height = src.height;
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}

function toGray(data: Uint8ClampedArray, n: number): Uint8Array {
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++)
    g[j] = (0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2]) | 0;
  return g;
}

// ── integral-image box blur ──────────────────────────────────────────────────

function boxBlur(src: Uint8Array, w: number, h: number, r: number): Float32Array {
  const st = w + 1;
  const II = new Float32Array(st * (h + 1));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      II[(y+1)*st+(x+1)] = src[y*w+x] + II[y*st+(x+1)] + II[(y+1)*st+x] - II[y*st+x];
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x1=Math.max(0,x-r), y1=Math.max(0,y-r);
      const x2=Math.min(w-1,x+r), y2=Math.min(h-1,y+r);
      out[y*w+x] = (II[(y2+1)*st+(x2+1)] - II[y1*st+(x2+1)]
                  - II[(y2+1)*st+x1]      + II[y1*st+x1]) / ((x2-x1+1)*(y2-y1+1));
    }
  return out;
}

// ── morphological ops ────────────────────────────────────────────────────────
// Using repeated 3×3 kernels — simple, fast enough on 600px working canvas.

function dilate3(s: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(s.length);
  for (let y = 1; y < h-1; y++)
    for (let x = 1; x < w-1; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) { const v=s[(y+dy)*w+(x+dx)]; if (v>m) m=v; }
      o[y*w+x] = m;
    }
  return o;
}

function erode3(s: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(s.length);
  for (let y = 1; y < h-1; y++)
    for (let x = 1; x < w-1; x++) {
      let m = 255;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) { const v=s[(y+dy)*w+(x+dx)]; if (v<m) m=v; }
      o[y*w+x] = m;
    }
  return o;
}

// Morphological close (dilate n×, then erode n/2×) — fills holes in paper region
function morphClose(mask: Uint8Array, w: number, h: number, n: number): Uint8Array {
  let m = mask;
  for (let i = 0; i < n; i++)              m = dilate3(m, w, h);
  for (let i = 0; i < Math.ceil(n/2); i++) m = erode3(m, w, h);
  return m;
}

// ── Otsu's threshold ─────────────────────────────────────────────────────────

function otsu(gray: Uint8Array, n: number): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[gray[i]]++;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0, wB = 0, best = 0, thresh = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const var_ = (wB / n) * (wF / n) * (mB - mF) ** 2;
    if (var_ > best) { best = var_; thresh = v; }
  }
  return thresh;
}

// ── Gaussian 5×5 blur + Sobel edges ─────────────────────────────────────────

const G5 = [1,4,6,4,1, 4,16,24,16,4, 6,24,36,24,6, 4,16,24,16,4, 1,4,6,4,1];
function blur5(g: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(g.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          s += g[Math.max(0,Math.min(h-1,y+dy))*w+Math.max(0,Math.min(w-1,x+dx))] * G5[(dy+2)*5+(dx+2)];
      o[y*w+x] = s >> 8;
    }
  return o;
}

function sobelEdges(g: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(g.length);
  for (let y = 1; y < h-1; y++)
    for (let x = 1; x < w-1; x++) {
      const tl=g[(y-1)*w+(x-1)], t=g[(y-1)*w+x], tr=g[(y-1)*w+(x+1)];
      const ml=g[y*w+(x-1)],                       mr=g[y*w+(x+1)];
      const bl=g[(y+1)*w+(x-1)], b=g[(y+1)*w+x], br=g[(y+1)*w+(x+1)];
      o[y*w+x] = Math.min(255, Math.sqrt((-tl-2*ml-bl+tr+2*mr+br)**2 + (-tl-2*t-tr+bl+2*b+br)**2));
    }
  return o;
}

// ── corner extraction and quality checks ─────────────────────────────────────
// Standard min/max diagonal coordinate method.
// mask: binary 255/0 or edge 0-255, threshold: pixel must exceed this to count

function dist(a: Pt, b: Pt) { return Math.hypot(a.x-b.x, a.y-b.y); }
function cross(o: Pt, a: Pt, b: Pt) { return (a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x); }

function cornersFromMask(mask: Uint8Array, w: number, h: number, thresh = 128): Quad | null {
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  let tl: Pt={x:0,y:0}, tr: Pt={x:0,y:0}, br: Pt={x:0,y:0}, bl: Pt={x:0,y:0};
  const step = Math.max(1, (w * h / 50000) | 0); // sample ≤ 50 k pts

  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      if (mask[y*w+x] < thresh) continue;
      const sum = x+y, diff = x-y;
      if (sum  < minSum)  { minSum  = sum;  tl = {x, y}; }
      if (sum  > maxSum)  { maxSum  = sum;  br = {x, y}; }
      if (diff < minDiff) { minDiff = diff; bl = {x, y}; }
      if (diff > maxDiff) { maxDiff = diff; tr = {x, y}; }
    }

  if (minSum === Infinity) return null;
  return validateQuad([tl, tr, br, bl], w, h);
}

function validateQuad(q: Quad, w: number, h: number): Quad | null {
  const [tl, tr, br, bl] = q;

  // ① All sides must be meaningfully long (≥18% of image dimension)
  if (dist(tl,tr) < w*0.18 || dist(bl,br) < w*0.18) return null;
  if (dist(tl,bl) < h*0.18 || dist(tr,br) < h*0.18) return null;

  // ② Diagonals must cross (basic non-degenerate check)
  if (dist(tl,br) < Math.hypot(w,h)*0.20) return null;
  if (dist(tr,bl) < Math.hypot(w,h)*0.20) return null;

  // ③ Shoelace area: 15 %–93 % of image
  const area = 0.5 * Math.abs(
    tl.x*(tr.y-bl.y) + tr.x*(br.y-tl.y) + br.x*(bl.y-tr.y) + bl.x*(tl.y-br.y)
  );
  if (area < w*h*0.15 || area > w*h*0.93) return null;

  // ④ Convexity (all cross products same sign)
  const signs = [cross(tl,tr,br), cross(tr,br,bl), cross(br,bl,tl), cross(bl,tl,tr)].map(Math.sign);
  if (signs.some(s => s !== signs[0])) return null;

  return q;
}

// ── largest connected bright component ───────────────────────────────────────
// Finds the single largest 4-connected region of bright pixels and returns a
// mask containing only that region.  This is more robust than flood-filling
// from the image centre because receipts are often not perfectly centred.
// Assumption: the receipt is the largest bright object in the scene (true when
// the background is a darker table / mat and the flash/phone light is on).

function largestBrightComponent(mask: Uint8Array, w: number, h: number): Uint8Array {
  const n     = w * h;
  const compOf = new Int32Array(n).fill(-1); // which component each bright pixel belongs to
  const queue  = new Int32Array(n);          // reused across all BFS passes
  const sizes: number[] = [];

  for (let i = 0; i < n; i++) {
    if (!mask[i] || compOf[i] >= 0) continue;
    const id = sizes.length;
    sizes.push(0);
    queue[0] = i; compOf[i] = id;
    let head = 0, tail = 1;
    while (head < tail) {
      const idx = queue[head++];
      sizes[id]++;
      const y = (idx / w) | 0, x = idx % w;
      if (y > 0   && mask[idx-w] && compOf[idx-w] < 0) { compOf[idx-w] = id; queue[tail++] = idx-w; }
      if (y < h-1 && mask[idx+w] && compOf[idx+w] < 0) { compOf[idx+w] = id; queue[tail++] = idx+w; }
      if (x > 0   && mask[idx-1] && compOf[idx-1] < 0) { compOf[idx-1] = id; queue[tail++] = idx-1; }
      if (x < w-1 && mask[idx+1] && compOf[idx+1] < 0) { compOf[idx+1] = id; queue[tail++] = idx+1; }
    }
  }

  if (!sizes.length) return mask;
  const largest = sizes.indexOf(Math.max(...sizes));
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (compOf[i] === largest) out[i] = 255;
  return out;
}

// ── PRIMARY: bright-region detection (Otsu) ──────────────────────────────────

function detectByBrightness(gray: Uint8Array, w: number, h: number): Quad | null {
  const n = w * h;
  const thresh = otsu(gray, n);

  // Reject if Otsu threshold is extreme — indicates no clear paper/background split
  if (thresh < 60 || thresh > 210) return null;

  // Binary mask: bright = paper
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = gray[i] >= thresh ? 255 : 0;

  // Bright fraction check — if >85% bright, can't reliably segment (light background)
  const brightCount = mask.reduce((a, v) => a + (v > 0 ? 1 : 0), 0);
  if (brightCount / n > 0.85) return null;

  // Morphological close: fills text/holes inside paper, radius ≈ 6px on 600px canvas
  const closed = morphClose(mask, w, h, 6);

  // Isolate the receipt: keep only the largest connected bright region
  const isolated = largestBrightComponent(closed, w, h);

  return cornersFromMask(isolated, w, h, 200);
}

// ── FALLBACK: edge-based detection ──────────────────────────────────────────

function detectByEdges(gray: Uint8Array, w: number, h: number): Quad | null {
  const blurred = blur5(gray, w, h);
  const edges   = sobelEdges(blurred, w, h);

  // Auto-threshold: top 30% of edge magnitudes
  const sorted = Array.from(edges).filter(v => v > 0).sort((a, b) => a - b);
  if (sorted.length < 100) return null;
  const thresh = sorted[Math.floor(sorted.length * 0.70)];

  const binary = new Uint8Array(edges.length);
  for (let i = 0; i < edges.length; i++) binary[i] = edges[i] > thresh ? 255 : 0;

  // Dilate to connect nearby edges
  let dilated = dilate3(binary, w, h);
  dilated     = dilate3(dilated, w, h);

  return cornersFromMask(dilated, w, h, 200);
}

// ── document detection (tries both, picks result) ───────────────────────────

function detectDocument(gray: Uint8Array, w: number, h: number): Quad | null {
  return detectByBrightness(gray, w, h) ?? detectByEdges(gray, w, h);
}

// ── homography + perspective warp ────────────────────────────────────────────

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

function applyHmat(H: number[], x: number, y: number): Pt {
  const w = H[6]*x + H[7]*y + H[8];
  return { x: (H[0]*x+H[1]*y+H[2])/w, y: (H[3]*x+H[4]*y+H[5])/w };
}

function perspectiveWarp(src: HTMLCanvasElement, quad: Quad, procScale: number): HTMLCanvasElement {
  const s = 1 / procScale;
  const [tl,tr,br,bl] = quad.map(p => ({ x: p.x*s, y: p.y*s })) as Quad;

  const W = Math.round(Math.max(dist(tl,tr), dist(bl,br)));
  const H = Math.round(Math.max(dist(tl,bl), dist(tr,br)));
  if (W < 80 || H < 80) throw new Error("warp too small");

  const dstQ: Quad = [{x:0,y:0},{x:W,y:0},{x:W,y:H},{x:0,y:H}];
  const Hinv = homography(dstQ, [tl,tr,br,bl]);
  const sw = src.width, sh = src.height;
  const sd = src.getContext("2d")!.getImageData(0, 0, sw, sh).data;

  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const ctx = out.getContext("2d")!;
  const od  = ctx.createImageData(W, H);
  const d   = od.data;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const {x:sx, y:sy} = applyHmat(Hinv, x, y);
      const di = (y*W+x)*4;
      if (sx < 0 || sx >= sw-1 || sy < 0 || sy >= sh-1) {
        d[di]=d[di+1]=d[di+2]=255; d[di+3]=255; continue;
      }
      const x0=sx|0, y0=sy|0, fx=sx-x0, fy=sy-y0;
      for (let c = 0; c < 3; c++) {
        const v00=sd[(y0*sw+x0)*4+c], v10=sd[(y0*sw+(x0+1))*4+c];
        const v01=sd[((y0+1)*sw+x0)*4+c], v11=sd[((y0+1)*sw+(x0+1))*4+c];
        d[di+c] = (v00*(1-fx)*(1-fy) + v10*fx*(1-fy) + v01*(1-fx)*fy + v11*fx*fy) | 0;
      }
      d[di+3] = 255;
    }
  }

  ctx.putImageData(od, 0, 0);
  return out;
}

// ── enhancement modes (exported for UI mode switcher) ────────────────────────

export function applyOriginal(src: HTMLCanvasElement): HTMLCanvasElement {
  return cloneCanvas(src);
}

export function applyGrau(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = cloneCanvas(src);
  const ctx = out.getContext("2d")!;
  const { width: w, height: h } = out;
  const img = ctx.getImageData(0, 0, w, h);
  const d   = img.data;
  const n   = w * h;

  const gray = toGray(d, n);

  // Mild gamma (0.92) — paper slightly whiter, shadows not crushed
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(Math.pow(v/255, 0.92) * 255);
  const bright = new Uint8Array(n);
  for (let i = 0; i < n; i++) bright[i] = lut[gray[i]];

  // Light unsharp mask (radius 1, amount 0.7)
  const blurred = boxBlur(bright, w, h, 1);
  const result  = new Uint8Array(n);
  for (let i = 0; i < n; i++)
    result[i] = Math.max(0, Math.min(255, (bright[i] + 0.7*(bright[i]-blurred[i])) | 0));

  for (let i = 0, j = 0; j < n; i += 4, j++) {
    d[i] = d[i+1] = d[i+2] = result[j]; d[i+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

export function applyScan(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = cloneCanvas(src);
  const ctx = out.getContext("2d")!;
  const { width: w, height: h } = out;
  const img = ctx.getImageData(0, 0, w, h);
  const d   = img.data;
  const n   = w * h;

  const gray = toGray(d, n);

  // Gentle background normalisation (radius ~4% of shorter dim)
  const bgR  = Math.max(20, Math.round(Math.min(w,h)*0.04));
  const bg   = boxBlur(gray, w, h, bgR);
  const norm = new Uint8Array(n);
  for (let i = 0; i < n; i++) norm[i] = Math.min(255, (gray[i] / Math.max(90, bg[i])) * 235) | 0;

  // Histogram stretch 5 %–95 %
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[norm[i]]++;
  let lo = 0, hi = 255, cum = 0;
  for (let v = 0;   v < 256; v++) { cum += hist[v]; if (cum < n*0.05) lo = v; }
  cum = 0;
  for (let v = 255; v >= 0;  v--) { cum += hist[v]; if (cum < n*0.05) hi = v; }
  const rng = Math.max(1, hi - lo);
  const stretched = new Uint8Array(n);
  for (let i = 0; i < n; i++) stretched[i] = Math.max(0, Math.min(255, ((norm[i]-lo)/rng*255)|0));

  // Unsharp mask (radius 2, amount 1.2)
  const blurred = boxBlur(stretched, w, h, 2);
  const result  = new Uint8Array(n);
  for (let i = 0; i < n; i++)
    result[i] = Math.max(0, Math.min(255, (stretched[i] + 1.2*(stretched[i]-blurred[i])) | 0));

  for (let i = 0, j = 0; j < n; i += 4, j++) {
    d[i] = d[i+1] = d[i+2] = result[j]; d[i+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

// ── public API ───────────────────────────────────────────────────────────────

export async function scanImage(imageBlob: Blob): Promise<ScanResult> {
  const img = await loadImg(imageBlob);

  // Full-res colour canvas (kept as rawCanvas for mode switching)
  const fullCanvas = resizeToCanvas(img, 1600);

  // Working canvas for detection (smaller = faster; 600px gives good accuracy)
  const procCanvas = resizeToCanvas(img, 600);
  const pw = procCanvas.width, ph = procCanvas.height;
  const procData = procCanvas.getContext("2d")!.getImageData(0, 0, pw, ph);
  const gray     = toGray(procData.data, pw * ph);

  const procScale = pw / fullCanvas.width;  // proc-canvas / full-res ratio
  const quad      = detectDocument(gray, pw, ph);

  let rawCanvas: HTMLCanvasElement;
  let corrected = false;

  if (quad) {
    try {
      rawCanvas = perspectiveWarp(fullCanvas, quad, procScale);
      corrected = true;
    } catch {
      rawCanvas = fullCanvas;
    }
  } else {
    rawCanvas = fullCanvas;
  }

  const canvas = applyGrau(rawCanvas);
  return { rawCanvas, canvas, corrected };
}

export function canvasToBlob(canvas: HTMLCanvasElement, quality = 0.88): Promise<Blob> {
  return new Promise((res, rej) =>
    canvas.toBlob(b => b ? res(b) : rej(new Error("toBlob failed")), "image/jpeg", quality)
  );
}

export function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/jpeg", 0.82);
}

/**
 * ============================================================================
 *  Texture plumbing — canvases in, GPU-ready THREE textures out.
 * ============================================================================
 *  The house rules, applied here once so no generator can get them wrong:
 *    • albedo  → SRGBColorSpace          (it is colour)
 *    • normal  → NoColorSpace            (it is a vector)
 *    • ORM     → NoColorSpace            (it is three scalars)
 *    • mipmaps always, trilinear min filter, anisotropy on anything at a
 *      grazing angle (which, in a racing game, is the entire ground plane).
 *
 *  Occlusion / roughness / metalness are packed into ONE RGB texture and bound
 *  to all three slots — three reads .r for AO, .g for roughness and .b for
 *  metalness, so this is one upload instead of three.
 *
 *  Normals are derived by a wrapping Sobel over the generator's height field.
 *  Nothing here fakes a normal map out of albedo luminance.
 * ============================================================================
 */
import * as THREE from 'three';

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

const HAS_OFFSCREEN = typeof OffscreenCanvas !== 'undefined';

export interface Canvas2D {
  canvas: AnyCanvas;
  ctx: CanvasRenderingContext2D;
  size: number;
}

export function createCanvas(size: number): Canvas2D {
  let canvas: AnyCanvas;
  if (HAS_OFFSCREEN) {
    canvas = new OffscreenCanvas(size, size);
  } else {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    canvas = c;
  }
  // These canvases exist purely as a CPU staging buffer for putImageData /
  // getImageData; letting the browser back them with a GPU surface turns every
  // readback into a pipeline stall.
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as unknown as CanvasRenderingContext2D;
  return { canvas, ctx, size };
}

// ---------------------------------------------------------------------------
// Colour helpers (all in 0..255 display space — these are canvas bytes)
// ---------------------------------------------------------------------------

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function rgb(hex: number): RGB {
  return { r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 };
}

export function mixRGB(a: RGB, b: RGB, t: number, out: RGB): RGB {
  out.r = a.r + (b.r - a.r) * t;
  out.g = a.g + (b.g - a.g) * t;
  out.b = a.b + (b.b - a.b) * t;
  return out;
}

// ---------------------------------------------------------------------------
// Fields — the intermediate buffers every generator fills
// ---------------------------------------------------------------------------

/**
 * One material's worth of raw channels. Generators write per-texel via `set`
 * and `surf`; nothing allocates after construction.
 */
export class Fields {
  readonly size: number;
  readonly albedo: Uint8ClampedArray;
  readonly orm: Uint8ClampedArray;
  readonly height: Float32Array;

  constructor(size: number) {
    this.size = size;
    this.albedo = new Uint8ClampedArray(size * size * 4);
    this.orm = new Uint8ClampedArray(size * size * 4);
    this.height = new Float32Array(size * size);
    this.albedo.fill(255);
    this.orm.fill(255);
    // ORM alpha carries a low-frequency "macro variation" signal that the
    // tiling-breakup shader injection samples at a non-integer scale. It has to
    // average 0.5 or the breakup would bias the whole surface brighter/darker.
    for (let k = 3; k < this.orm.length; k += 4) this.orm[k] = 128;
  }

  /** colour + coverage at texel index `i`; channels are 0..255, alpha 0..1 */
  set(i: number, r: number, g: number, b: number, a = 1): void {
    const k = i * 4;
    this.albedo[k] = r;
    this.albedo[k + 1] = g;
    this.albedo[k + 2] = b;
    this.albedo[k + 3] = a * 255;
  }

  setRGB(i: number, c: RGB, a = 1): void {
    const k = i * 4;
    this.albedo[k] = c.r;
    this.albedo[k + 1] = c.g;
    this.albedo[k + 2] = c.b;
    this.albedo[k + 3] = a * 255;
  }

  /** height (arbitrary units, Sobel normalises), ambient occlusion, roughness, metalness — all 0..1 */
  surf(i: number, height: number, ao: number, roughness: number, metalness = 0): void {
    this.height[i] = height;
    const k = i * 4;
    this.orm[k] = ao * 255;
    this.orm[k + 1] = roughness * 255;
    this.orm[k + 2] = metalness * 255;
  }

  /** large-scale variation signal, 0..1, read by the tiling-breakup injection */
  macro(i: number, v: number): void {
    this.orm[i * 4 + 3] = v * 255;
  }
}

// ---------------------------------------------------------------------------
// Sobel normal
// ---------------------------------------------------------------------------

/**
 * Wrapping 3×3 Sobel over `height`, encoded OpenGL-style (+Y up in tangent
 * space). The image Y axis runs down while UV V runs up once three flips the
 * canvas, hence the sign on the green channel.
 */
export function sobelNormalBytes(height: Float32Array, size: number, strength: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  const m = size - 1;
  for (let y = 0; y < size; y++) {
    const yp = y === 0 ? m : y - 1;
    const yn = y === m ? 0 : y + 1;
    const r0 = yp * size;
    const r1 = y * size;
    const r2 = yn * size;
    for (let x = 0; x < size; x++) {
      const xp = x === 0 ? m : x - 1;
      const xn = x === m ? 0 : x + 1;
      const h00 = height[r0 + xp];
      const h01 = height[r0 + x];
      const h02 = height[r0 + xn];
      const h10 = height[r1 + xp];
      const h12 = height[r1 + xn];
      const h20 = height[r2 + xp];
      const h21 = height[r2 + x];
      const h22 = height[r2 + xn];
      const gx = h02 + 2 * h12 + h22 - (h00 + 2 * h10 + h20);
      const gy = h20 + 2 * h21 + h22 - (h00 + 2 * h01 + h02);
      let nx = -gx * strength;
      let ny = gy * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv;
      ny *= inv;
      const k = (r1 + x) * 4;
      out[k] = (nx * 0.5 + 0.5) * 255;
      out[k + 1] = (ny * 0.5 + 0.5) * 255;
      out[k + 2] = inv * 255;
      out[k + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface UploadOpts {
  srgb: boolean;
  wrap?: THREE.Wrapping;
  anisotropy?: number;
}

/**
 * `ImageData`'s constructor is typed against a non-shared ArrayBuffer while our
 * buffers are declared with the plain alias; routing through `ImageData['data']`
 * keeps the cast honest and in exactly one place.
 */
export function toImageData(bytes: Uint8ClampedArray, size: number): ImageData {
  return new ImageData(bytes as unknown as ImageData['data'], size, size);
}

function putBytes(size: number, bytes: Uint8ClampedArray): Canvas2D {
  const c = createCanvas(size);
  c.ctx.putImageData(toImageData(bytes, size), 0, 0);
  return c;
}

export function canvasTexture(canvas: AnyCanvas, o: UploadOpts): THREE.Texture {
  const t = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  t.colorSpace = o.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = o.wrap ?? THREE.RepeatWrapping;
  t.anisotropy = o.anisotropy ?? 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export function bytesTexture(size: number, bytes: Uint8ClampedArray, o: UploadOpts): THREE.Texture {
  return canvasTexture(putBytes(size, bytes).canvas, o);
}

export interface MapSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  /** R = AO, G = roughness, B = metalness. Bind to aoMap + roughnessMap + metalnessMap. */
  ormMap: THREE.Texture;
  all: THREE.Texture[];
}

export interface BuildOpts {
  normalStrength?: number;
  wrap?: THREE.Wrapping;
  anisotropy?: number;
  /** pre-drawn albedo canvas to use instead of the Fields buffer (for path-drawn materials) */
  albedoCanvas?: AnyCanvas;
}

export function buildMaps(f: Fields, o: BuildOpts = {}): MapSet {
  const size = f.size;
  const aniso = o.anisotropy ?? 8;
  const wrap = o.wrap ?? THREE.RepeatWrapping;
  const map = o.albedoCanvas
    ? canvasTexture(o.albedoCanvas, { srgb: true, wrap, anisotropy: aniso })
    : bytesTexture(size, f.albedo, { srgb: true, wrap, anisotropy: aniso });
  const normalMap = bytesTexture(size, sobelNormalBytes(f.height, size, (o.normalStrength ?? 1) * size * 0.012), {
    srgb: false,
    wrap,
    anisotropy: aniso,
  });
  const ormMap = bytesTexture(size, f.orm, { srgb: false, wrap, anisotropy: aniso });
  // AO defaults to the second UV set; our meshes only have one.
  ormMap.channel = 0;
  return { map, normalMap, ormMap, all: [map, normalMap, ormMap] };
}

/** Blur an alpha/height buffer in place-ish (separable box, 2 passes) — cheap rounding for cutout cards. */
export function blurField(src: Float32Array, size: number, radius: number): Float32Array {
  const tmp = new Float32Array(size * size);
  const out = new Float32Array(size * size);
  const r = Math.max(1, radius | 0);
  const norm = 1 / (r * 2 + 1);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[row + ((i + size) % size)];
    for (let x = 0; x < size; x++) {
      tmp[row + x] = acc * norm;
      acc -= src[row + ((x - r + size) % size)];
      acc += src[row + ((x + r + 1) % size)];
    }
  }
  for (let x = 0; x < size; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += tmp[((i + size) % size) * size + x];
    for (let y = 0; y < size; y++) {
      out[y * size + x] = acc * norm;
      acc -= tmp[(((y - r + size) % size) * size) + x];
      acc += tmp[(((y + r + 1) % size) * size) + x];
    }
  }
  return out;
}

/** Single readback of a drawn canvas — call this once and derive everything from it. */
export function readPixels(c: Canvas2D): Uint8ClampedArray {
  return c.ctx.getImageData(0, 0, c.size, c.size).data;
}

/** Alpha channel of a readback as a 0..1 field. */
export function alphaFrom(px: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(px.length >> 2);
  for (let i = 0, k = 3; i < out.length; i++, k += 4) out[i] = px[k] / 255;
  return out;
}

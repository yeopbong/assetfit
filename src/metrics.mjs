export const METRIC_VERSION = 'rgba-reference-v1';

/** @typedef {{x?: number, y?: number, width?: number, height?: number, w?: number, h?: number, weight?: number, unit?: string}} RegionInput */
/** @param {number} value */
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

/** @param {RegionInput} region @param {number} width @param {number} height */
function rectangle(region, width, height) {
  const pixel = region.unit === 'pixels';
  const x = Number(region.x ?? 0) * (pixel ? 1 : width);
  const y = Number(region.y ?? 0) * (pixel ? 1 : height);
  const w = Number(region.width ?? region.w ?? 0) * (pixel ? 1 : width);
  const h = Number(region.height ?? region.h ?? 0) * (pixel ? 1 : height);
  return {
    x0: clamp(Math.floor(x), 0, width), y0: clamp(Math.floor(y), 0, height),
    x1: clamp(Math.ceil(x + w), 0, width), y1: clamp(Math.ceil(y + h), 0, height),
    weight: Math.max(1, Number(region.weight ?? 4)),
  };
}

/** @param {Uint8Array} reference
 * @param {Uint8Array} candidate
 * @param {{width: number, height: number, regions?: Array<RegionInput>}} options */
export function compareRgba(reference, candidate, { width, height, regions = [] }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width * height > 16_777_216) throw new Error('Invalid metric dimensions.');
  const count = width * height;
  if (reference.length !== count * 4 || candidate.length !== count * 4) {
    throw new Error('Metric inputs must be equal-sized RGBA buffers.');
  }
  const boxes = regions.map(region => rectangle(region, width, height));
  if (boxes.some(box => !Object.values(box).every(Number.isFinite))) {
    throw new Error('Protection regions must have finite coordinates and weights.');
  }
  const lumaA = new Float32Array(count);
  const lumaB = new Float32Array(count);
  const rgbErrors = new Float32Array(count);
  const alphaErrors = new Float32Array(count);
  const edgeErrors = new Float32Array(count);
  let foregroundPixels = 0;
  let candidateForegroundPixels = 0;
  let missingPixels = 0;
  let extraPixels = 0;
  let alphaMassA = 0;
  let alphaMassB = 0;
  for (let p = 0; p < count; p++) {
    const offset = p * 4;
    const aa = reference[offset + 3] / 255;
    const ab = candidate[offset + 3] / 255;
    const foregroundA = aa > 8 / 255;
    const foregroundB = ab > 8 / 255;
    foregroundPixels += Number(foregroundA);
    candidateForegroundPixels += Number(foregroundB);
    missingPixels += Number(foregroundA && !foregroundB);
    extraPixels += Number(!foregroundA && foregroundB);
    alphaMassA += aa;
    alphaMassB += ab;
    let rgb = 0;
    let la = 0;
    let lb = 0;
    for (let c = 0; c < 3; c++) {
      const ca = reference[offset + c] / 255 * aa;
      const cb = candidate[offset + c] / 255 * ab;
      rgb += (Math.abs(ca - cb) + Math.abs((ca + (1 - aa)) - (cb + (1 - ab)))) / 6;
      const coefficient = [0.2126, 0.7152, 0.0722][c];
      la += coefficient * (ca + (1 - aa) * 0.5);
      lb += coefficient * (cb + (1 - ab) * 0.5);
    }
    rgbErrors[p] = rgb;
    alphaErrors[p] = Math.abs(aa - ab);
    lumaA[p] = la;
    lumaB[p] = lb;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const left = y * width + Math.max(0, x - 1);
      const right = y * width + Math.min(width - 1, x + 1);
      const top = Math.max(0, y - 1) * width + x;
      const bottom = Math.min(height - 1, y + 1) * width + x;
      edgeErrors[p] = (Math.abs((lumaA[right] - lumaA[left]) - (lumaB[right] - lumaB[left]))
        + Math.abs((lumaA[bottom] - lumaA[top]) - (lumaB[bottom] - lumaB[top]))) / 4;
    }
  }
  const accumulators = [null, ...boxes].map(() => ({ rgb: 0, edge: 0, alpha: 0, silhouette: 0, weight: 0, pixels: 0 }));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const originalForeground = reference[p * 4 + 3] > 8;
      const changedMask = originalForeground !== (candidate[p * 4 + 3] > 8);
      const baseWeight = foregroundPixels ? (originalForeground ? 1 : 0.03) : 1;
      let weight = baseWeight;
      const contained = boxes.map(box => x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1);
      for (let i = 0; i < boxes.length; i++) if (contained[i]) weight = Math.max(weight, baseWeight * boxes[i].weight);
      for (let a = 0; a < accumulators.length; a++) {
        if (a > 0 && !contained[a - 1]) continue;
        const value = accumulators[a];
        const w = a === 0 ? weight : baseWeight;
        value.rgb += rgbErrors[p] * w;
        value.edge += edgeErrors[p] * w;
        value.alpha += alphaErrors[p] * w;
        value.silhouette += Number(changedMask) * w;
        value.weight += w;
        value.pixels++;
      }
    }
  }
  /** @param {{rgb: number, edge: number, alpha: number, silhouette: number, weight: number, pixels: number}} accumulator */
  const score = ({ rgb, edge, alpha, silhouette, weight, pixels }) => {
    const denominator = Math.max(weight, Number.EPSILON);
    const components = { rgb: rgb / denominator, edge: edge / denominator,
      alpha: alpha / denominator, silhouette: silhouette / denominator };
    return { ...components, loss: clamp(0.55 * components.rgb + 0.20 * components.edge
      + 0.15 * components.alpha + 0.10 * components.silhouette), pixels, empty: !pixels };
  };
  const result = score(accumulators[0]);
  return {
    ...result, version: METRIC_VERSION, width, height,
    foregroundPixels, candidateForegroundPixels, emptyReference: foregroundPixels === 0,
    missingForeground: missingPixels / Math.max(1, foregroundPixels),
    extraForeground: extraPixels / Math.max(1, foregroundPixels),
    alphaMassRatio: alphaMassA > 0 ? alphaMassB / alphaMassA : (alphaMassB ? null : 1),
    vanishedForeground: foregroundPixels > 0 && candidateForegroundPixels === 0,
    regions: accumulators.slice(1).map((value, index) => ({ index, weight: boxes[index].weight, ...score(value) })),
  };
}

/** @param {Uint8Array} reference
 * @param {Uint8Array} candidate */
export function differenceRgba(reference, candidate) {
  if (reference.length !== candidate.length || reference.length % 4) throw new Error('Difference inputs must be equal RGBA buffers.');
  const result = new Uint8Array(reference.length);
  for (let i = 0; i < reference.length; i += 4) {
    const aa = reference[i + 3] / 255;
    const ab = candidate[i + 3] / 255;
    let difference = Math.abs(aa - ab);
    for (let c = 0; c < 3; c++) difference = Math.max(difference,
      Math.abs(reference[i + c] / 255 * aa - candidate[i + c] / 255 * ab));
    const strength = clamp(difference * 4);
    result[i] = Math.round(18 + 237 * strength);
    result[i + 1] = Math.round(22 * (1 - strength));
    result[i + 2] = Math.round(30 * (1 - strength));
    result[i + 3] = 255;
  }
  return result;
}

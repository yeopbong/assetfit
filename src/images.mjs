import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compareRgba, differenceRgba, METRIC_VERSION } from './metrics.mjs';

export const IMAGE_VERSION = `sharp-${sharp.versions.sharp}-image-v2`;
export const IMAGE_LIMITS = { sourcePixels: 64_000_000, usagePixels: 4_194_304, usages: 12, candidates: 24 };
const FORMATS = new Set(['jpeg', 'png', 'webp']);
const EXTENSIONS = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const sharpOptions = { failOn: 'warning', limitInputPixels: IMAGE_LIMITS.sourcePixels };
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function abort(signal) {
  if (signal?.aborted) {
    const error = new Error('Image processing canceled. Completed candidates are retained.');
    error.name = 'AbortError';
    throw error;
  }
}

function positive(value, name, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) throw new RangeError(`${name} must be a positive ${integer ? 'integer' : 'number'}.`);
  return value;
}

async function hasPngAnimation(file, format) {
  if (format !== 'png') return false;
  const buffer = await readFile(file);
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += length + 12;
  }
  return false;
}

export async function inspectImage(file) {
  const [metadata, info, hash] = await Promise.all([sharp(file, sharpOptions).metadata(), stat(file), fileHash(file)]);
  const animated = (metadata.pages ?? 1) > 1 || await hasPngAnimation(file, metadata.format);
  const rotated = [5, 6, 7, 8].includes(metadata.orientation);
  const width = rotated ? metadata.height : metadata.width;
  const height = rotated ? metadata.width : metadata.height;
  const diagnostics = [];
  if (!FORMATS.has(metadata.format)) diagnostics.push('Only static JPEG, PNG, and WebP images are supported.');
  if (animated) diagnostics.push('Animated images are not supported; their timeline cannot be discarded.');
  if (metadata.depth && metadata.depth !== 'uchar') diagnostics.push('Only 8-bit image channels are supported by the current evaluation pipeline.');
  if (width * height > IMAGE_LIMITS.sourcePixels) diagnostics.push(`Image exceeds the ${IMAGE_LIMITS.sourcePixels}-pixel source limit.`);
  return {
    type: 'image', width, height, storedWidth: metadata.width, storedHeight: metadata.height,
    format: metadata.format, bytes: info.size, hash, hasAlpha: !!metadata.hasAlpha,
    orientation: metadata.orientation ?? 1, colourSpace: metadata.space, hasProfile: !!metadata.icc,
    channels: metadata.channels, depth: metadata.depth, animated, supported: diagnostics.length === 0,
    diagnostics, encoderVersion: IMAGE_VERSION,
    metadataPolicy: 'Original retains exact bytes and metadata. New encodes apply EXIF orientation, convert to sRGB, and remove ancillary metadata.',
  };
}

export function normalizeImageUsages(usages = []) {
  if (!Array.isArray(usages)) throw new TypeError('Image usages must be an array.');
  const list = usages.length ? usages : [{ width: 512, height: 512, dpr: 1, fit: 'contain', weight: 1, regions: [] }];
  if (list.length > IMAGE_LIMITS.usages) throw new RangeError(`At most ${IMAGE_LIMITS.usages} usages per image are supported.`);
  return list.map((usage, usageIndex) => {
    const width = positive(usage.width ?? 512, 'Usage width', true);
    const height = positive(usage.height ?? 512, 'Usage height', true);
    const dpr = positive(usage.dpr ?? 1, 'Usage DPR');
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (!Number.isSafeInteger(pixelWidth) || !Number.isSafeInteger(pixelHeight) || pixelWidth < 1 || pixelHeight < 1 || pixelWidth * pixelHeight > IMAGE_LIMITS.usagePixels) throw new RangeError(`Usage raster exceeds ${IMAGE_LIMITS.usagePixels} pixels or has invalid dimensions. Reduce the declared display size or DPR.`);
    const fit = usage.fit ?? 'contain';
    if (!['contain', 'cover', 'fill'].includes(fit)) throw new TypeError('Image fit must be contain, cover, or fill. Cover affects evaluation only; output files are never cropped.');
    const weight = positive(usage.weight ?? 1, 'Usage weight');
    const regions = usage.regions ?? [];
    if (!Array.isArray(regions) || regions.length > 32) throw new RangeError('Regions must be an array with at most 32 display-space rectangles.');
    for (const region of regions) {
      for (const key of ['x', 'y', 'width', 'height']) if (!Number.isFinite(region[key]) || region[key] < 0) throw new RangeError('Region coordinates must be finite and non-negative.');
      positive(region.width, 'Region width');
      positive(region.height, 'Region height');
      positive(region.weight ?? 2, 'Region priority');
      if (region.unit !== undefined && region.unit !== 'pixels') throw new TypeError('Region unit must be pixels, or omitted for normalized coordinates.');
      const limitWidth = region.unit === 'pixels' ? width : 1;
      const limitHeight = region.unit === 'pixels' ? height : 1;
      if (region.x + region.width > limitWidth || region.y + region.height > limitHeight) throw new RangeError('Region lies outside the declared display rectangle.');
    }
    return { usageIndex, name: usage.name ?? `Usage ${usageIndex + 1}`, width, height, dpr, pixelWidth, pixelHeight, fit, weight, regions: regions.map((region) => ({ ...region, weight: region.weight ?? 2 })), defaulted: usages.length === 0 };
  });
}

function normalizeConstraints(asset) {
  const input = asset.constraints ?? {};
  const formats = input.formats ?? ['jpeg', 'png', 'webp'];
  if (!Array.isArray(formats) || formats.some((format) => !FORMATS.has(format))) throw new TypeError('Output formats must use jpeg, png, or webp names.');
  const minWidth = input.minWidth ?? 1;
  const minHeight = input.minHeight ?? 1;
  positive(minWidth, 'Minimum width', true);
  positive(minHeight, 'Minimum height', true);
  return { ...input, formats: [...new Set(formats)], minWidth, minHeight, preserveDimensions: !!input.preserveDimensions, lossless: !!input.lossless, lockOriginal: !!input.lockOriginal || asset.mode === 'lock' || asset.mode === 'lockOriginal', preserveAlpha: input.preserveAlpha !== false };
}

async function decodedRaster(file) {
  return sharp(file, sharpOptions).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

async function displayPixels(file, usage, decoded) {
  const { data, info } = decoded ?? await decodedRaster(file);
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .resize(usage.pixelWidth, usage.pixelHeight, { fit: usage.fit, position: 'centre', kernel: 'lanczos3', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw().toBuffer();
}

async function canonicalPixels(file) {
  return sharp(file, sharpOptions).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer();
}

export async function evaluateImage(sourcePath, candidatePath, usages = [], options = {}) {
  const normalized = normalizeImageUsages(usages);
  const uses = [];
  const images = [];
  const referenceRaster = options.references ? null : await decodedRaster(sourcePath);
  const candidateRaster = await decodedRaster(candidatePath);
  if (options.previewDir) await mkdir(options.previewDir, { recursive: true });
  for (const usage of normalized) {
    abort(options.signal);
    const reference = options.references?.[usage.usageIndex] ?? await displayPixels(sourcePath, usage, referenceRaster);
    const candidate = await displayPixels(candidatePath, usage, candidateRaster);
    const regions = usage.regions.map((region) => region.unit === 'pixels' ? { ...region, x: region.x * usage.dpr, y: region.y * usage.dpr, width: region.width * usage.dpr, height: region.height * usage.dpr } : region);
    const metric = compareRgba(reference, candidate, { width: usage.pixelWidth, height: usage.pixelHeight, regions });
    uses.push({ ...usage, ...metric, displayWidth: usage.width, displayHeight: usage.height, width: usage.pixelWidth, height: usage.pixelHeight });
    if (options.previewDir) {
      const prefix = options.previewPrefix ?? digest(candidateRaster.data).slice(0, 16);
      if (!/^[a-zA-Z0-9-]+$/.test(prefix)) throw new Error('Invalid image preview prefix.');
      const referenceFile = path.join(options.previewDir, `${prefix}-u${usage.usageIndex}-reference.png`);
      const candidateFile = path.join(options.previewDir, `${prefix}-u${usage.usageIndex}.png`);
      const differenceFile = path.join(options.previewDir, `${prefix}-u${usage.usageIndex}-difference.png`);
      const raw = { width: usage.pixelWidth, height: usage.pixelHeight, channels: 4 };
      await sharp(reference, { raw }).png().toFile(referenceFile);
      await sharp(candidate, { raw }).png().toFile(candidateFile);
      await sharp(differenceRgba(reference, candidate), { raw }).png().toFile(differenceFile);
      images.push({ usageIndex: usage.usageIndex, reference: referenceFile, candidate: candidateFile, difference: differenceFile, differenceAmplification: 4 });
    }
  }
  const weight = uses.reduce((sum, usage) => sum + usage.weight, 0);
  return { loss: uses.reduce((sum, usage) => sum + usage.loss * usage.weight, 0) / weight, uses, images, preview: images[0]?.candidate, reference: images[0]?.reference, difference: images[0]?.difference, aggregation: 'weighted-mean-of-usages', metricVersion: METRIC_VERSION, colourSpace: 'sRGB', evaluation: 'Full native source and output decoded to normalized RGBA before identical display resizing, DPR, fit and display-space region priorities.' };
}

function proposals(metadata, constraints, usages, maxCandidates) {
  const original = { original: true, format: metadata.format, width: metadata.width, height: metadata.height, lossless: true };
  if (constraints.lockOriginal) return [original];
  const formats = constraints.formats.filter((format) => !(metadata.hasAlpha && format === 'jpeg'));
  const output = [original];
  const losslessFormat = formats.includes('png') ? 'png' : formats.includes('webp') ? 'webp' : null;
  if (losslessFormat) output.push({ format: losslessFormat, width: metadata.width, height: metadata.height, lossless: true });
  if (constraints.lossless) {
    if (formats.includes('webp') && losslessFormat !== 'webp') output.push({ format: 'webp', width: metadata.width, height: metadata.height, lossless: true });
    return output.slice(0, maxCandidates);
  }
  const targetScale = Math.min(1, Math.max(...usages.map((usage) => usage.fit === 'contain' ? Math.min(usage.pixelWidth / metadata.width, usage.pixelHeight / metadata.height) : Math.max(usage.pixelWidth / metadata.width, usage.pixelHeight / metadata.height))));
  const scales = constraints.preserveDimensions ? [1] : [1, Math.min(0.75, Math.max(0.5, targetScale)), Math.min(0.45, Math.max(0.25, targetScale * 0.6))];
  const lossyFormats = formats.filter((format) => format !== 'png').sort((a) => a === 'webp' ? -1 : 1);
  const levels = [{ scale: scales[0], quality: 84 }, { scale: scales[1] ?? 1, quality: 68 }, { scale: scales[2] ?? 1, quality: 46 }];
  for (const { scale, quality } of levels) {
    const minimumScale = Math.max(constraints.minWidth / metadata.width, constraints.minHeight / metadata.height);
    const actualScale = Math.min(1, Math.max(scale, minimumScale));
    const width = Math.max(1, Math.round(metadata.width * actualScale));
    const height = Math.max(1, Math.round(metadata.height * actualScale));
    for (const format of lossyFormats.length ? lossyFormats : formats) output.push({ format, width, height, quality: format === 'png' ? undefined : quality, lossless: false });
  }
  const seen = new Set();
  return output.filter((params) => {
    const key = JSON.stringify(params);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, maxCandidates);
}

function legality(metadata, source, params, constraints) {
  const diagnostics = [];
  if (!constraints.formats.includes(metadata.format)) diagnostics.push(`Format ${metadata.format} is outside the selected compatibility profile.`);
  if (metadata.width < constraints.minWidth || metadata.height < constraints.minHeight) diagnostics.push(`Dimensions ${metadata.width}×${metadata.height} violate the minimum ${constraints.minWidth}×${constraints.minHeight}.`);
  if ((constraints.preserveDimensions || constraints.lossless) && (metadata.width !== source.width || metadata.height !== source.height)) diagnostics.push('Original display dimensions must be retained.');
  if (source.hasAlpha && !metadata.hasAlpha) diagnostics.push('Transparency channel was lost. Transparent sources are never encoded as opaque outputs.');
  if (constraints.lockOriginal && !params.original) diagnostics.push('The whole image is locked to its original file.');
  if (constraints.lossless && !params.lossless) diagnostics.push('Only verified lossless candidates are allowed.');
  return diagnostics;
}

export async function generateImageCandidates({ sourcePath, outputDir, asset = {}, settings = {}, onCandidate, onObservation, signal }) {
  abort(signal);
  const started = performance.now();
  const source = await inspectImage(sourcePath);
  if (!source.supported) throw new Error(source.diagnostics.join(' '));
  const constraints = normalizeConstraints(asset);
  const usages = normalizeImageUsages(asset.usages);
  const maxCandidates = settings.maxCandidates ?? settings.imageCandidates ?? 8;
  positive(maxCandidates, 'Image candidate limit', true);
  if (maxCandidates > IMAGE_LIMITS.candidates) throw new RangeError(`At most ${IMAGE_LIMITS.candidates} image candidates are supported.`);
  await mkdir(outputDir, { recursive: true });
  const references = [];
  const sourceRaster = await decodedRaster(sourcePath);
  for (const usage of usages) {
    abort(signal);
    references.push(await displayPixels(sourcePath, usage, sourceRaster));
  }
  const initializationMs = performance.now() - started;
  const candidates = [];
  const observations = [];
  const record = async (observation) => {
    observations.push(observation);
    await onObservation?.(observation);
  };
  await record({ phase: 'initialization', durationMs: initializationMs, sourceHash: source.hash, usages: usages.length, version: IMAGE_VERSION });
  const canonicalReference = sourceRaster.data;
  for (const params of proposals(source, constraints, usages, maxCandidates)) {
    abort(signal);
    const candidateStarted = performance.now();
    const key = digest(JSON.stringify({ source: source.hash, params, constraints, usages, version: IMAGE_VERSION, libvips: sharp.versions.vips, metric: METRIC_VERSION }));
    const id = params.original ? 'original' : `image-${key.slice(0, 20)}`;
    const resume = settings.resumeCandidates?.find((candidate) => candidate.id === id && candidate.cacheKey === key);
    if (resume?.file) {
      try {
        const [hash, info] = await Promise.all([fileHash(resume.file), stat(resume.file)]);
        if (hash === resume.hash && info.size === resume.bytes) {
          const candidate = { ...resume, cacheHit: true };
          candidates.push(candidate);
          await record({ phase: 'cache-hit', candidateId: id, durationMs: performance.now() - candidateStarted, historicalCostMs: resume.costMs, cacheHit: true });
          await onCandidate?.(candidate);
          continue;
        }
        await record({ phase: 'cache-mismatch', candidateId: id, durationMs: performance.now() - candidateStarted, diagnostics: ['Saved output hash or byte size differs; a new physical encode is required.'] });
      } catch (error) {
        await record({ phase: 'cache-miss', candidateId: id, durationMs: performance.now() - candidateStarted, diagnostics: [error.code === 'ENOENT' ? 'Saved candidate file is missing.' : 'Saved candidate could not be read.'] });
      }
    }
    await record({ phase: 'proposal', candidateId: id, params, sourceHash: source.hash, durationMs: 0 });
    let file;
    try {
      const encodeStarted = performance.now();
      let buffer;
      if (params.original) {
        buffer = await readFile(sourcePath);
      } else {
        let pipeline = sharp(sourcePath, sharpOptions).rotate().toColourspace('srgb');
        if (params.width !== source.width || params.height !== source.height) pipeline = pipeline.resize(params.width, params.height, { fit: 'fill', kernel: 'lanczos3', withoutEnlargement: true });
        if (params.format === 'jpeg') pipeline = pipeline.jpeg({ quality: params.quality, mozjpeg: true, chromaSubsampling: '4:4:4' });
        else if (params.format === 'png') pipeline = pipeline.png({ compressionLevel: 9, palette: false, adaptiveFiltering: true });
        else pipeline = pipeline.webp({ quality: params.quality ?? 100, lossless: params.lossless, alphaQuality: 100, effort: 4 });
        buffer = await pipeline.toBuffer();
      }
      const hash = digest(buffer);
      file = path.join(outputDir, `${id}-${hash.slice(0, 16)}.${EXTENSIONS[params.format]}`);
      if (path.resolve(file) === path.resolve(sourcePath)) throw new Error('Candidate output must not overwrite the original source.');
      await writeFile(file, buffer, { flag: 'wx' }).catch(async (error) => {
        if (error.code !== 'EEXIST') throw error;
        if (await fileHash(file) !== hash) throw new Error('Existing output differs from its content hash; refusing to overwrite historical bytes.');
      });
      const encodeMs = performance.now() - encodeStarted;
      abort(signal);
      const evaluationStarted = performance.now();
      const measured = await inspectImage(file);
      const diagnostics = legality(measured, source, params, constraints);
      if (params.lossless && !params.original) {
        if (!(await canonicalPixels(file)).equals(canonicalReference)) diagnostics.push('Decoded normalized RGBA differs from the source; the proposed lossless encoding was rejected.');
      }
      const metrics = await evaluateImage(sourcePath, file, asset.usages, { references, signal, previewDir: path.join(outputDir, 'previews'), previewPrefix: key.slice(0, 20) });
      const evaluateMs = performance.now() - evaluationStarted;
      const candidate = {
        id, file, bytes: measured.bytes, hash: measured.hash, cacheKey: key, sourceHash: source.hash,
        params, valid: diagnostics.length === 0, metrics, costMs: performance.now() - candidateStarted,
        costs: { encodeMs, evaluateMs }, diagnostics,
        metadata: { width: measured.width, height: measured.height, format: measured.format, hasAlpha: measured.hasAlpha },
        versions: { encoder: IMAGE_VERSION, libvips: sharp.versions.vips, metric: METRIC_VERSION },
        protection: { ...constraints, regionPolicy: 'Local evaluation priority only; whole-image original lock is required for exact regional content.' },
      };
      if (params.original && measured.hash !== source.hash) throw new Error('Original candidate failed exact source hash verification.');
      candidates.push(candidate);
      await record({ phase: candidate.valid ? 'evaluated' : 'invalid', candidateId: id, bytes: candidate.bytes, loss: metrics.loss, durationMs: candidate.costMs, encodeMs, evaluateMs, diagnostics });
      await onCandidate?.(candidate);
    } catch (error) {
      await record({ phase: error.name === 'AbortError' ? 'canceled' : 'failed', candidateId: id, durationMs: performance.now() - candidateStarted, diagnostics: [error.message] });
      if (error.name === 'AbortError') throw error;
    }
  }
  candidates.observations = observations;
  candidates.costs = { initializationMs, durationMs: performance.now() - started, proposals: observations.filter((item) => item.phase === 'proposal').length, cacheHits: observations.filter((item) => item.phase === 'cache-hit').length, failed: observations.filter((item) => item.phase === 'failed' || item.phase === 'invalid').length };
  return candidates;
}

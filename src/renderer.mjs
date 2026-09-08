import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { compareRgba, differenceRgba, METRIC_VERSION } from './metrics.mjs';

export const RENDERER_VERSION = 'three-180-fixed-v1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');
const finiteVector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

function resolveUsages(usages, bounds) {
  return (usages?.length ? usages : [{ width: 256, height: 256, dpr: 1, weight: 1 }]).map((input, usageIndex) => {
    const requestedWidth = Math.round(Number(input.width ?? input.displayWidth ?? 256) * Number(input.dpr ?? 1));
    const requestedHeight = Math.round(Number(input.height ?? input.displayHeight ?? 256) * Number(input.dpr ?? 1));
    if (![requestedWidth, requestedHeight].every(value => Number.isFinite(value) && value > 0 && value <= 32768)) {
      throw new Error('GLB usage dimensions and DPR must produce a positive display no larger than 32768 pixels.');
    }
    if (requestedWidth * requestedHeight > 1_048_576) throw new Error('A GLB evaluation view may contain at most 1,048,576 physical pixels. Reduce the declared dimensions or DPR.');
    const width = requestedWidth;
    const height = requestedHeight;
    const verticalFov = 35;
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov * Math.PI / 360) * width / height);
    const distance = bounds.radius * 1.15 / Math.sin(Math.min(verticalFov * Math.PI / 180, horizontalFov) / 2);
    const near = Math.max(bounds.radius / 1000, 0.000001);
    const far = Math.max(bounds.radius * 100, distance * 3);
    const auto = (yaw, elevation) => {
      const azimuth = yaw * Math.PI / 180;
      const pitch = elevation * Math.PI / 180;
      return { position: [bounds.center[0] + distance * Math.sin(azimuth) * Math.cos(pitch),
        bounds.center[1] + distance * Math.sin(pitch), bounds.center[2] + distance * Math.cos(azimuth) * Math.cos(pitch)],
      target: [...bounds.center], up: [0, 1, 0], fov: verticalFov, near, far, projection: 'perspective' };
    };
    const saved = input.cameras ?? (input.camera ? [input.camera] : []);
    if (!Array.isArray(saved) || saved.length > 8) throw new Error('A GLB usage supports up to eight saved cameras.');
    const cameras = saved.length ? saved.map(camera => {
      if (!finiteVector(camera.position) || !finiteVector(camera.target ?? bounds.center)) throw new Error('Saved cameras require finite position and target vectors.');
      const config = { ...auto(30, 20), ...camera, target: camera.target ?? [...bounds.center], near, far };
      if (config.projection === 'orthographic' && !(config.scale > 0)) throw new Error('Orthographic cameras require a positive scale.');
      return config;
    }) : [auto(30, 20), auto(150, 20), auto(270, 20)];
    const sameView = (a, b) => ['position', 'target'].every(key => a[key].every((value, index) => Math.abs(value - b[key][index]) <= bounds.radius * 1e-6));
    const heldoutCameras = [[90, 38], [210, -8], [75, 45], [195, 5], [285, 50], [15, -15], [115, 60], [245, 12], [340, 35], [50, -5]]
      .map(([yaw, elevation]) => auto(yaw, elevation)).filter(camera => !cameras.some(savedCamera => sameView(camera, savedCamera))).slice(0, 2);
    const weight = Number(input.weight ?? input.priority ?? 1);
    if (!(weight > 0) || !Number.isFinite(weight)) throw new Error('Usage weight must be positive.');
    const dpr = Number(input.dpr ?? 1);
    const regions = (input.regions ?? input.protectionRegions ?? []).map(region => region.unit === 'pixels'
      ? { ...region, x: region.x * dpr, y: region.y * dpr, width: region.width * dpr, height: region.height * dpr } : region);
    return { usageIndex, width, height, requestedWidth, requestedHeight, dpr,
      weight, regions, cameras, heldoutCameras,
      display: { width: input.width ?? input.displayWidth ?? 256, height: input.height ?? input.displayHeight ?? 256, dpr: input.dpr ?? 1 } };
  });
}

export async function chromeOptions() {
  if (process.env.ASSETFIT_CHROME) return { executablePath: process.env.ASSETFIT_CHROME };
  const candidates = process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32' ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const executablePath of candidates) { try { await access(executablePath); return { executablePath }; } catch {} }
  return {};
}

export async function createRenderer({ workDir = path.join(os.tmpdir(), 'assetfit-render'), signal } = {}) {
  const outputDir = path.resolve(workDir, 'renders');
  await mkdir(outputDir, { recursive: true });
  const files = new Map();
  const errors = [];
  const vendorRoot = await realpath(path.join(root, 'node_modules/three'));
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      let file;
      if (pathname === '/render.html' || pathname === '/render.mjs') file = path.join(root, 'web', pathname.slice(1));
      else if (pathname.startsWith('/asset/')) file = files.get(pathname);
      else if (pathname.startsWith('/vendor/three/')) {
        const resolved = await realpath(path.resolve(vendorRoot, pathname.slice('/vendor/three/'.length)));
        if (resolved.startsWith(vendorRoot + path.sep) && resolved.endsWith('.js')) file = resolved;
      }
      if (!file) { response.writeHead(404).end('Not found'); return; }
      const details = await stat(file);
      response.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : /\.m?js$/.test(file) ? 'text/javascript' : 'model/gltf-binary',
        'Content-Length': details.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      createReadStream(file).on('error', () => response.destroy()).pipe(response);
    } catch { if (!response.headersSent) response.writeHead(404).end('Not found'); else response.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser;
  let page;
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch({ ...await chromeOptions(), headless: true,
      args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
    page = await browser.newPage();
    page.setDefaultTimeout(120000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = route.request().url();
      return url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:') ? route.continue() : route.abort();
    });
    await page.goto(origin + '/render.html');
    await page.waitForFunction(() => Boolean(window.assetfitRender));
  } catch (error) {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
    throw new Error(`The GLB renderer could not start. Install Chrome or run pnpm exec playwright install chromium. ${error.message}`);
  }
  const environment = { renderer: RENDERER_VERSION, metric: METRIC_VERSION,
    browser: browser.version(), ...await page.evaluate(() => window.assetfitRender.info()) };
  let busy = Promise.resolve();
  let closed = false;
  const serial = operation => {
    const next = busy.then(() => { if (closed) throw new Error('Renderer is closed.'); signal?.throwIfAborted(); return operation(); });
    busy = next.catch(() => {});
    return next;
  };
  const register = async filePath => {
    const file = await realpath(filePath);
    const bytes = await readFile(file);
    if (bytes.length > 256 * 1024 * 1024) throw new Error('The renderer limits GLB files to 256 MiB.');
    if (bytes.subarray(0, 4).toString() !== 'glTF') throw new Error('Renderer input must be a GLB file.');
    const hash = digest(bytes);
    const urlPath = `/asset/${hash}.glb`;
    files.set(urlPath, file);
    const bounds = await page.evaluate(url => window.assetfitRender.load(url), origin + urlPath);
    return { hash, bytes: bytes.length, bounds };
  };
  const capture = async (usage, camera, lighting, outputPath) => {
    signal?.throwIfAborted();
    const dataUrl = await page.evaluate(config => window.assetfitRender.capture(config), {
      width: usage.width, height: usage.height, camera, lighting,
    });
    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    await writeFile(outputPath, png);
    return sharp(png).ensureAlpha().raw().toBuffer();
  };
  return {
    environment,
    reference: (sourcePath, usages = []) => serial(async () => {
      const started = performance.now();
      const source = await register(sourcePath);
      const uses = resolveUsages(usages, source.bounds);
      const lighting = { target: source.bounds.center,
        position: source.bounds.center.map((value, index) => value + source.bounds.radius * [4, 6, 8][index]) };
      const settingsHash = digest(JSON.stringify({ uses, lighting, environment }));
      const directory = path.join(outputDir, `${source.hash.slice(0, 16)}-${settingsHash.slice(0, 12)}`);
      await mkdir(directory, { recursive: true });
      const context = { version: RENDERER_VERSION, sourceHash: source.hash, sourceBytes: source.bytes,
        bounds: source.bounds, uses, cameras: uses[0].cameras, lighting, environment,
        settingsHash, directory, referenceImages: [], aggregation: 'weighted mean of usages; camera loss sum divided by original nonempty camera count within each usage, clamped to one' };
      for (const usage of uses) {
        for (const [stage, cameras] of [['search', usage.cameras], ['heldout', usage.heldoutCameras]]) {
          for (let viewIndex = 0; viewIndex < cameras.length; viewIndex++) {
            const imagePath = path.join(directory, `reference-u${usage.usageIndex}-${stage}-v${viewIndex}.png`);
            const rgba = await capture(usage, cameras[viewIndex], lighting, imagePath);
            const identity = compareRgba(rgba, rgba, usage);
            context.referenceImages.push({ stage, usageIndex: usage.usageIndex, viewIndex, path: imagePath,
              foregroundPixels: identity.foregroundPixels, emptyReference: identity.emptyReference });
          }
        }
        if (!context.referenceImages.some(image => image.usageIndex === usage.usageIndex && image.stage === 'search' && !image.emptyReference)) {
          throw new Error(`Original GLB has no visible foreground in any search camera for usage ${usage.usageIndex + 1}. Save a visible camera or check the model.`);
        }
      }
      context.durationMs = performance.now() - started;
      context.preview = context.referenceImages[0].path;
      return context;
    }),
    evaluate: (candidatePath, context, { heldout = false } = {}) => serial(async () => {
      const started = performance.now();
      if (context.version !== RENDERER_VERSION || context.environment.metric !== METRIC_VERSION) throw new Error('Reference renderer or metric version mismatch.');
      if (JSON.stringify(context.environment) !== JSON.stringify(environment)) throw new Error('The rendering environment changed; rebuild the original references before evaluating.');
      const candidate = await register(candidatePath);
      const stage = heldout ? 'heldout' : 'search';
      const images = [];
      const uses = [];
      for (const usage of context.uses) {
        const views = [];
        const cameras = heldout ? usage.heldoutCameras : usage.cameras;
        for (let viewIndex = 0; viewIndex < cameras.length; viewIndex++) {
          const basename = `${candidate.hash.slice(0, 20)}-u${usage.usageIndex}-${stage}-v${viewIndex}`;
          const candidateImage = path.join(context.directory, `${basename}.png`);
          const difference = path.join(context.directory, `${basename}-difference.png`);
          const reference = context.referenceImages.find(image => image.stage === stage && image.usageIndex === usage.usageIndex && image.viewIndex === viewIndex);
          if (!reference) throw new Error('Missing original reference image.');
          const rgba = await capture(usage, cameras[viewIndex], context.lighting, candidateImage);
          const original = await sharp(reference.path).ensureAlpha().raw().toBuffer();
          const metrics = compareRgba(original, rgba, usage);
          await sharp(differenceRgba(original, rgba), { raw: { width: usage.width, height: usage.height, channels: 4 } }).png().toFile(difference);
          views.push({ viewIndex, ...metrics });
          images.push({ stage, usageIndex: usage.usageIndex, viewIndex, reference: reference.path, candidate: candidateImage, difference });
        }
        const scoredViews = views.filter(view => !view.emptyReference);
        const loss = Math.min(1, views.reduce((sum, view) => sum + view.loss, 0) / Math.max(1, scoredViews.length));
        uses.push({ usageIndex: usage.usageIndex, weight: usage.weight, loss, views, width: usage.width, height: usage.height,
          requestedWidth: usage.requestedWidth, requestedHeight: usage.requestedHeight, scoredViewCount: scoredViews.length });
      }
      const denominator = uses.reduce((sum, usage) => sum + usage.weight, 0);
      return { loss: uses.reduce((sum, usage) => sum + usage.loss * usage.weight, 0) / denominator,
        version: METRIC_VERSION, rendererVersion: RENDERER_VERSION, hash: candidate.hash, bytes: candidate.bytes,
        stage, heldout, uses, images, preview: images[0]?.candidate, difference: images[0]?.difference,
        reference: images[0]?.reference, settingsHash: context.settingsHash, environment, durationMs: performance.now() - started,
        valid: uses.every(usage => usage.views.every(view => !view.vanishedForeground)),
        diagnostics: [...errors], aggregation: context.aggregation };
    }),
    async close() {
      await busy;
      if (closed) return;
      closed = true;
      await page.evaluate(() => window.assetfitRender.dispose()).catch(() => {});
      await browser.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

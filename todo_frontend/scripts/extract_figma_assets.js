#!/usr/bin/env node
/**
 * PUBLIC_INTERFACE
 * extract_figma_assets.js
 *
 * This Node.js script parses a Figma screen JSON (as provided in attachments) to detect all image/icon
 * components (PNG, JPG, SVG/Vector) and extracts or downloads the real assets to an assets folder.
 *
 * It supports:
 * - Direct "imageUrl" fields on nodes (downloads the raster image from Figma CDN).
 * - Local "imagePath" fields (copies them into target assets dir if present).
 * - Icon/vector nodes (figma_type VECTOR or type 'icon'):
 *    - If FIGMA_TOKEN and FIGMA_FILE_KEY are provided (or passed via flags), fetch real SVGs via Figma's images API.
 *    - Otherwise generate placeholder SVGs based on node name and dimensions.
 *
 * Usage:
 *   node scripts/extract_figma_assets.js <figma_json_path> [--out <assets_dir>] [--token <FIGMA_TOKEN>] [--file-key <FILE_KEY>]
 *
 * Example:
 *   node scripts/extract_figma_assets.js ../../attachments/screen_371:365.json --out ../../assets/figmaimages
 *
 * Environment variables (optional):
 * - FIGMA_TOKEN: Your Figma Personal Access Token (used when fetching real SVGs for vector nodes).
 * - FIGMA_FILE_KEY: Figma file key (used when fetching real SVGs for vector nodes).
 *
 * Outputs:
 * - Downloaded PNG/JPG assets to assets-dir
 * - Copied local assets referenced via imagePath (if they exist)
 * - Generated SVG placeholders for icons (or real SVGs if Figma API is configured)
 * - A manifest file: assets-dir/figma_assets_manifest.json
 *
 * Author: Kavia Code Generation Agent
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Small utility: promisified timeout
 */
function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Ensure a directory exists.
 */
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * PUBLIC_INTERFACE
 * slugify
 * Create a filesystem-friendly name from a string.
 */
function slugify(text) {
  return String(text || 'asset')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'asset';
}

/**
 * Fetch binary data from a URL (http or https).
 */
function fetchBinary(url, timeoutMs = 30000) {
  const u = new URL(url);
  const fn = u.protocol === 'http:' ? http : https;

  const options = {
    headers: {
      'User-Agent': 'asset-extractor-node/1.0',
    },
    timeout: timeoutMs,
  };

  return new Promise((resolve, reject) => {
    const req = fn.get(u, options, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirects
        fetchBinary(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Request failed with status ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
  });
}

/**
 * Write binary content to file.
 */
function writeBinary(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, data);
}

/**
 * Write text content to file.
 */
function writeText(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, data, 'utf8');
}

/**
 * Load JSON file.
 */
function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Save JSON file with indentation.
 */
function saveJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

/**
 * Heuristic: is a node a vector/icon?
 */
function isVectorNode(node) {
  if (!node || typeof node !== 'object') return false;
  if (String(node.figma_type || '') === 'VECTOR') return true;
  if (String(node.type || '').toLowerCase() === 'icon') return true;
  return false;
}

/**
 * Extract node dimensions if available.
 */
function nodeDimensions(node) {
  const dims = node?.dimensions || {};
  return [dims.width, dims.height];
}

/**
 * Construct usable identifier for filenames.
 */
function nodeIdentifier(node) {
  const nid = node?.id || 'node';
  const name = node?.name || 'node';
  return slugify(`${name}_${nid}`.replace(/\s+/g, '_'));
}

/**
 * Flatten node tree using DFS, assuming structure with "children".
 * PUBLIC_INTERFACE
 */
function traverseNodes(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    out.push(n);
    const children = (n && n.children) || [];
    for (const c of children) stack.push(c);
  }
  return out;
}

/**
 * Build Figma images API URL.
 */
function figmaImagesApiUrl(fileKey, ids, fmt = 'svg') {
  const base = `https://api.figma.com/v1/images/${fileKey}`;
  const query = new URLSearchParams({
    ids: ids.join(','),
    format: fmt,
  });
  return `${base}?${query.toString()}`;
}

/**
 * Call Figma images endpoint to map node id -> image URL
 */
async function figmaFetchImages(fileKey, ids, token, fmt = 'svg') {
  const url = figmaImagesApiUrl(fileKey, ids, fmt);
  const headers = { 'X-Figma-Token': token };
  const data = await fetchJson(url, headers);
  return data.images || {};
}

/**
 * Fetch JSON from a URL with headers.
 */
function fetchJson(url, headers = {}, timeoutMs = 30000) {
  const u = new URL(url);
  const fn = u.protocol === 'http:' ? http : https;

  const options = {
    headers: { 'User-Agent': 'asset-extractor-node/1.0', ...headers },
    timeout: timeoutMs,
  };

  return new Promise((resolve, reject) => {
    const req = fn.get(u, options, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 256)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
  });
}

/**
 * PUBLIC_INTERFACE
 * extractAssets
 * Extract assets from the Figma screen JSON to a given assets directory.
 */
async function extractAssets(screenJsonPath, assetsDir, figmaToken, figmaFileKey) {
  const manifest = {
    source_json: path.resolve(screenJsonPath),
    assets_dir: path.resolve(assetsDir),
    downloaded: [],
    copied: [],
    generated_svg: [],
    skipped: [],
  };

  const data = loadJson(screenJsonPath);
  const root = data.root;
  if (!root) {
    console.error("No 'root' key found in JSON. Nothing to extract.");
    return manifest;
  }

  ensureDir(assetsDir);
  const nodes = traverseNodes(root);

  // Collect vector node ids for optional Figma real SVG
  const vectorNodeIds = nodes
    .filter((n) => isVectorNode(n) && n.id)
    .map((n) => n.id);

  let figmaImagesMap = {};
  if (figmaToken && figmaFileKey && vectorNodeIds.length) {
    try {
      // Batch calls to avoid URL length issues
      const batchSize = 90;
      for (let i = 0; i < vectorNodeIds.length; i += batchSize) {
        const batch = vectorNodeIds.slice(i, i + batchSize);
        // Small delay to be gentle with API
        await delay(100);
        const m = await figmaFetchImages(figmaFileKey, batch, figmaToken, 'svg');
        figmaImagesMap = { ...figmaImagesMap, ...m };
      }
      console.log(`Fetched ${Object.keys(figmaImagesMap).length} vector SVG URLs from Figma API.`);
    } catch (ex) {
      console.warn(`Warning: Unable to fetch real SVGs via Figma API: ${ex.message || ex}`);
    }
  }

  // Repo root assumption: this script lives in task-management-web-app-41-54/todo_frontend/scripts/
  // repoRoot = scripts/../../..
  const repoRoot = path.resolve(__dirname, '../../..');

  for (const node of nodes) {
    const ntype = String(node?.type || '').toLowerCase();
    const ftype = String(node?.figma_type || '').toUpperCase();
    const nid = node?.id;
    const nname = node?.name || '';
    const ident = nodeIdentifier(node);

    // 1) Download from imageUrl
    const imageUrl = node?.imageUrl;
    if (imageUrl) {
      let ext = path.extname(new URL(imageUrl).pathname || '').toLowerCase();
      if (!ext || !['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
        ext = '.png';
      }
      const outPath = path.join(assetsDir, `${ident}${ext}`);
      try {
        const bin = await fetchBinary(imageUrl);
        writeBinary(outPath, bin);
        manifest.downloaded.push({ node_id: nid, name: nname, path: outPath, source: imageUrl });
        continue;
      } catch (ex) {
        manifest.skipped.push({ node_id: nid, name: nname, reason: `download_error: ${ex.message || ex}` });
        continue;
      }
    }

    // 2) Copy from imagePath (local file)
    const imagePath = node?.imagePath;
    if (imagePath) {
      try {
        const candidate = path.resolve(repoRoot, imagePath.replace(/^\/+/, ''));
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          const ext = path.extname(candidate) || '.png';
          const outPath = path.join(assetsDir, `${ident}${ext}`);
          ensureDir(path.dirname(outPath));
          fs.copyFileSync(candidate, outPath);
          manifest.copied.push({ node_id: nid, name: nname, from: candidate, to: outPath });
          continue;
        } else {
          manifest.skipped.push({ node_id: nid, name: nname, reason: `imagePath_not_found: ${candidate}` });
        }
      } catch (ex) {
        manifest.skipped.push({ node_id: nid, name: nname, reason: `copy_error: ${ex.message || ex}` });
        continue;
      }
    }

    // 3) Vector/Icon nodes -> prefer real SVG via Figma API if available, else placeholder
    if (isVectorNode(node)) {
      const [w0, h0] = nodeDimensions(node);
      const w = typeof w0 === 'number' && isFinite(w0) ? w0 : 24;
      const h = typeof h0 === 'number' && isFinite(h0) ? h0 : 24;

      const svgOut = path.join(assetsDir, `${ident}.svg`);
      try {
        const svgUrl = nid && figmaImagesMap[nid] ? figmaImagesMap[nid] : null;
        if (svgUrl) {
          const svgData = await fetchBinary(svgUrl);
          writeBinary(svgOut, svgData);
          manifest.generated_svg.push({ node_id: nid, name: nname, path: svgOut, source: 'figma_api' });
        } else {
          const placeholder =
            `<?xml version="1.0" encoding="UTF-8"?>\n` +
            `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(
              nname || 'icon'
            )}">\n` +
            `  <title>${escapeXml(nname || 'icon')}</title>\n` +
            `  <rect x="0.5" y="0.5" width="${Math.max(w - 1, 0)}" height="${Math.max(
              h - 1,
              0
            )}" fill="none" stroke="#999" stroke-dasharray="4 2"/>\n` +
            `  <text x="4" y="${h - 6}" font-family="Arial, Helvetica, sans-serif" font-size="8" fill="#666">${escapeXml(
              nname || 'icon'
            )}</text>\n` +
            `</svg>\n`;
          writeText(svgOut, placeholder);
          manifest.generated_svg.push({ node_id: nid, name: nname, path: svgOut, source: 'placeholder' });
        }
        continue;
      } catch (ex) {
        manifest.skipped.push({ node_id: nid, name: nname, reason: `svg_error: ${ex.message || ex}` });
        continue;
      }
    }

    // 4) Other node types: skip
    if (['rectangle', 'text', 'line', 'ellipse', 'container', 'component'].includes(ntype)) {
      continue;
    }
  }

  // Save manifest
  const manifestPath = path.join(assetsDir, 'figma_assets_manifest.json');
  saveJson(manifestPath, manifest);
  console.log(`Extraction complete. Manifest written to ${manifestPath}`);
  return manifest;
}

/**
 * Escape XML text for safe embedding into attributes or text nodes.
 */
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/>/g, '&gt;');
}

/**
 * CLI entrypoint.
 * PUBLIC_INTERFACE
 */
async function main() {
  // Simple argv parser
  const args = process.argv.slice(2);
  if (!args.length || args[0].startsWith('-')) {
    printHelp();
    process.exit(1);
  }
  const inputJson = args[0];

  let outDir = null;
  let token = process.env.FIGMA_TOKEN || null;
  let fileKey = process.env.FIGMA_FILE_KEY || null;

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if ((a === '--out' || a === '-o') && i + 1 < args.length) {
      outDir = args[++i];
    } else if (a === '--token' && i + 1 < args.length) {
      token = args[++i];
    } else if (a === '--file-key' && i + 1 < args.length) {
      fileKey = args[++i];
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  // Defaults for this repo structure (when running from repo root)
  if (!outDir) {
    outDir = path.resolve(process.cwd(), 'assets/figmaimages');
  } else {
    outDir = path.resolve(process.cwd(), outDir);
  }

  const inputPath = path.resolve(process.cwd(), inputJson);
  if (!fs.existsSync(inputPath)) {
    console.error(`Input JSON not found: ${inputPath}`);
    process.exit(1);
  }

  await extractAssets(inputPath, outDir, token, fileKey);
}

function printHelp() {
  console.log(`Usage:
  node scripts/extract_figma_assets.js <figma_json_path> [--out <assets_dir>] [--token <FIGMA_TOKEN>] [--file-key <FILE_KEY>]

Examples:
  node scripts/extract_figma_assets.js ../../attachments/screen_371:365.json --out ../../assets/figmaimages
  FIGMA_TOKEN=XXXXX FIGMA_FILE_KEY=YYYYY node scripts/extract_figma_assets.js ../../attachments/screen_371:365.json --out ../../assets/figmaimages

Notes:
- If FIGMA_TOKEN and FIGMA_FILE_KEY are provided, vector/icon nodes will try to fetch real SVGs via Figma images API.
- Otherwise, placeholder SVGs will be generated with correct dimensions.
`);
}

if (require.main === module) {
  // Run if executed directly
  main().catch((err) => {
    console.error(`Fatal: ${err?.stack || err}`);
    process.exit(1);
  });
}

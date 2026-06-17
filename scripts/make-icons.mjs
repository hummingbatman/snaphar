/**
 * make-icons.mjs — rasterize icons/icon.svg into the PNG sizes the extension
 * needs (16/32/48/128).
 *
 * The SVG is the single source of truth. We render each size at native
 * resolution with a headless Chromium browser (Chrome or Edge — both ship a
 * stable `--screenshot` mode), so there are no native image dependencies. Set
 * CHROME_BIN to point at a specific browser binary if auto-detection fails.
 *
 *   node scripts/make-icons.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const ICONS_DIR = fileURLToPath(new URL('../icons/', import.meta.url));
const SVG_PATH = join(ICONS_DIR, 'icon.svg');
const SIZES = [16, 32, 48, 128];

function findBrowser() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    win32: [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    ],
  }[platform()] || [];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error('No Chromium browser found. Set CHROME_BIN to a Chrome/Edge binary.');
  }
  return found;
}

function renderSize(browser, svg, size, outPath, workDir) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent}
    svg{display:block;width:${size}px;height:${size}px}
  </style></head><body>${svg}</body></html>`;
  const htmlPath = join(workDir, `render-${size}.html`);
  writeFileSync(htmlPath, html);

  execFileSync(browser, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${size},${size}`,
    '--default-background-color=00000000', // transparent
    `--screenshot=${outPath}`,
    htmlPath,
  ], { stdio: 'ignore' });
}

const browser = findBrowser();
const svg = readFileSync(SVG_PATH, 'utf8');
const workDir = mkdtempSync(join(tmpdir(), 'snaphar-icons-'));
try {
  for (const size of SIZES) {
    const outPath = join(ICONS_DIR, `icon${size}.png`);
    renderSize(browser, svg, size, outPath, workDir);
    if (!existsSync(outPath)) throw new Error(`render failed for ${size}px`);
    console.log(`wrote icons/icon${size}.png (${statSync(outPath).size} bytes)`);
  }
  console.log(`Rendered with: ${browser}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

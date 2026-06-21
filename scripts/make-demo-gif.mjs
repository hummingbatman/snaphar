/**
 * make-demo-gif.mjs — generate the animated demo GIF used in the README / landing page.
 *
 * Renders the REAL popup (src/popup.html + popup.css) in a sequence of states —
 * idle → recording (timer + request count climbing) → exported — via headless
 * Chrome, then stitches the frames into a looping GIF with ffmpeg.
 *
 * Requires a Chromium browser (set CHROME_BIN if auto-detect fails) and ffmpeg.
 *
 *   node scripts/make-demo-gif.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, 'docs', 'demo.gif');
const W = 600, H = 600, FPS = 10;

function findBrowser() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const c = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    win32: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'],
  }[platform()] || [];
  const f = c.find((p) => existsSync(p));
  if (!f) throw new Error('No Chromium browser found. Set CHROME_BIN.');
  return f;
}

const BROWSER = findBrowser();
const work = mkdtempSync(join(tmpdir(), 'snaphar-demo-'));
const seq = join(work, 'seq');
mkdirSync(seq, { recursive: true });
mkdirSync(join(work, 'icons'), { recursive: true });
copyFileSync(join(ROOT, 'icons/icon32.png'), join(work, 'icons/icon32.png'));
copyFileSync(join(ROOT, 'src/popup.css'), join(work, 'popup.css'));

const popupTpl = readFileSync(join(ROOT, 'src/popup.html'), 'utf8')
  .replace('src="../icons/icon32.png"', 'src="icons/icon32.png"');

/** Write a popup variant whose inline script forces a given UI state. */
function popupState(name, js) {
  const html = popupTpl.replace(/<script[^>]*><\/script>/, `<script>${js}</script>`);
  writeFileSync(join(work, name + '.html'), html);
  return name + '.html';
}

const recording = (elapsed, count) => `
  document.getElementById('status').className='status status--recording';
  document.getElementById('status-text').textContent='Recording…';
  var s=document.getElementById('stats'); s.hidden=false;
  document.getElementById('elapsed').textContent='${elapsed}';
  document.getElementById('count').textContent='${count}';
  var t=document.getElementById('target'); t.hidden=false; t.textContent='github.com';
  document.getElementById('start').hidden=true;
  document.getElementById('stop').hidden=false;
  document.getElementById('discard').hidden=false;
  document.getElementById('hint').textContent='Reproduce the issue, then Stop & Export.';`;

const done = `
  document.getElementById('status').className='status status--done';
  document.getElementById('status-text').textContent='Saved snaphar_github.com.har';
  var s=document.getElementById('stats'); s.hidden=false;
  document.getElementById('elapsed').textContent='0:15';
  document.getElementById('count').textContent='127';
  document.getElementById('hint').textContent='HAR downloaded. Re-import it in DevTools to verify.';`;

/** A scene = a caption + the popup, centred on a dark stage. */
const stage = (caption, src) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0}
  .stage{width:${W}px;height:${H}px;background:#0d0d0d;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:30px;
    font-family:ui-monospace,Menlo,monospace}
  .cap{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#9a9a9a}
  .device{width:420px;height:504px;display:flex;align-items:center;justify-content:center}
  .device iframe{border:0;background:#fff;border-radius:16px;box-shadow:0 40px 80px rgba(0,0,0,.55);
    transform:scale(1.4);transform-origin:center}
</style></head><body><div class="stage">
  <div class="cap">${caption}</div>
  <div class="device"><iframe src="${src}" width="300" height="360"></iframe></div>
</div></body></html>`;

// Storyboard: [caption, popup variant, hold in seconds]
const scenes = [
  ['01 · Open the popup', popupState('idle', ''), 1.4],
  ['02 · Start recording', popupState('r1', recording('0:01', '9')), 0.5],
  ['02 · Reproduce the bug', popupState('r2', recording('0:04', '41')), 0.5],
  ['02 · Reproduce the bug', popupState('r3', recording('0:09', '88')), 0.5],
  ['02 · Reproduce the bug', popupState('r4', recording('0:15', '127')), 0.8],
  ['03 · Stop & export', popupState('done', done), 1.9],
];

function shoot(name, sceneHtml) {
  const html = join(work, name + '.stage.html');
  writeFileSync(html, sceneHtml);
  const png = join(work, name + '.png');
  execFileSync(BROWSER, [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
    '--blink-settings=preferredColorScheme=1', '--virtual-time-budget=1500',
    `--window-size=${W},${H}`, `--screenshot=${png}`, 'file://' + html,
  ], { stdio: 'ignore' });
  return png;
}

let frame = 0;
scenes.forEach(([caption, src], i) => {
  const png = shoot('s' + i, stage(caption, src));
  const holds = Math.round(scenes[i][2] * FPS);
  for (let h = 0; h < holds; h++) {
    copyFileSync(png, join(seq, 'f' + String(frame++).padStart(4, '0') + '.png'));
  }
  console.log('rendered scene ' + (i + 1) + '/' + scenes.length);
});

// frames → palette → looping GIF
const palette = join(work, 'palette.png');
execFileSync('ffmpeg', ['-y', '-i', join(seq, 'f%04d.png'),
  '-vf', 'scale=' + W + ':-1:flags=lanczos,palettegen=max_colors=128', palette], { stdio: 'ignore' });
execFileSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', join(seq, 'f%04d.png'),
  '-i', palette, '-lavfi', 'scale=' + W + ':-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a',
  '-loop', '0', OUT], { stdio: 'ignore' });

rmSync(work, { recursive: true, force: true });
const kb = Math.round(readFileSync(OUT).length / 1024);
console.log('\nDone → docs/demo.gif  (' + frame + ' frames, ' + kb + ' KB)');

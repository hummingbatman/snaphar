/**
 * make-screenshots.mjs — generate Chrome Web Store / Edge listing screenshots.
 *
 * Renders the real popup, options page, and HAR viewer at 1280x800 via headless
 * Chrome (forced light theme), composites the small popup/options into framed
 * promo shots, and writes JPEGs (no alpha — meets the stores' "no alpha" rule)
 * into ./screenshots/.
 *
 *   node scripts/make-screenshots.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, 'screenshots');
const W = 1280, H = 800;

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
const work = mkdtempSync(join(tmpdir(), 'snaphar-shots-'));
mkdirSync(OUT, { recursive: true });
mkdirSync(join(work, 'icons'), { recursive: true });
copyFileSync(join(ROOT, 'icons/icon32.png'), join(work, 'icons/icon32.png'));
copyFileSync(join(ROOT, 'src/popup.css'), join(work, 'popup.css'));

const ESC = (s) => s; // templates are trusted

function shoot(fileUrl, outName) {
  const png = join(work, outName + '.png');
  execFileSync(BROWSER, [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--blink-settings=preferredColorScheme=1', '--virtual-time-budget=1500',
    `--window-size=${W},${H}`, `--screenshot=${png}`, fileUrl,
  ], { stdio: 'ignore' });
  // Convert to JPEG (drops alpha) using sips (macOS) or Chrome's PNG otherwise.
  const jpg = join(OUT, outName + '.jpg');
  try {
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', png, '--out', jpg], { stdio: 'ignore' });
    console.log('wrote screenshots/' + outName + '.jpg');
  } catch {
    copyFileSync(png, join(OUT, outName + '.png'));
    console.log('wrote screenshots/' + outName + '.png (install sips/ImageMagick for JPEG)');
  }
}

/* ---- 1. Popup (recording) as a framed promo ---- */
let popup = readFileSync(join(ROOT, 'src/popup.html'), 'utf8')
  .replace('src="../icons/icon32.png"', 'src="icons/icon32.png"')
  .replace(/<script[^>]*><\/script>/, `<script>
    document.getElementById('status').className='status status--recording';
    document.getElementById('status-text').textContent='Recording…';
    var s=document.getElementById('stats'); s.hidden=false;
    document.getElementById('elapsed').textContent='0:42';
    document.getElementById('count').textContent='128';
    var t=document.getElementById('target'); t.hidden=false; t.textContent='github.com';
    document.getElementById('start').hidden=true;
    document.getElementById('stop').hidden=false;
    document.getElementById('discard').hidden=false;
    document.getElementById('hint').textContent='Reproduce the issue, then Stop & Export.';
  </script>`);
writeFileSync(join(work, 'popup-rec.html'), popup);

const promo = (eyebrow, title, sub, src, w, h, scale) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0}
  .stage{width:${W}px;height:${H}px;background:#0d0d0d;color:#fff;display:grid;grid-template-columns:1.05fr .95fr;align-items:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overflow:hidden}
  .copy{padding:0 0 0 96px}
  .eyebrow{font-family:ui-monospace,Menlo,monospace;font-size:14px;letter-spacing:.16em;text-transform:uppercase;color:#8f8f8f;margin:0 0 26px}
  .copy h2{font-size:52px;line-height:1.02;letter-spacing:-.035em;margin:0 0 20px;font-weight:700}
  .copy p{font-size:19px;line-height:1.5;color:#bdbdbd;max-width:22ch;margin:0}
  .device{display:flex;align-items:center;justify-content:center}
  .device iframe{border:0;background:#fff;border-radius:18px;box-shadow:0 50px 100px rgba(0,0,0,.55)}
</style></head><body><div class="stage">
  <div class="copy"><p class="eyebrow">${eyebrow}</p><h2>${title}</h2><p>${sub}</p></div>
  <div class="device"><iframe src="${src}" width="${w}" height="${h}" style="transform:scale(${scale})"></iframe></div>
</div></body></html>`;

writeFileSync(join(work, 's1.html'), promo('SnapHAR · HAR capture', 'Record a HAR in one&nbsp;click.', 'No DevTools. Start, reproduce, Stop &amp; Export.', 'popup-rec.html', 300, 340, 1.55));

/* ---- 3. Options (static, real markup) as a framed promo ---- */
let opts = readFileSync(join(ROOT, 'src/options.html'), 'utf8')
  .replace(/<script[^>]*><\/script>/, `<script>
    includeBodies.checked=true; maxBodySize.value=5120;
    redactHeaders.checked=true; redactQuery.checked=true; redactBodies.checked=false;
    filenamePattern.value='snaphar_{host}_{datetime}';
  </script>`);
writeFileSync(join(work, 'options-static.html'), opts);
writeFileSync(join(work, 's3.html'), promo('Settings', 'Safe by&nbsp;default.', 'Redact sensitive headers, cookies, and URL tokens — or capture everything.', 'options-static.html', 680, 760, 0.82));

/* ---- 4. Brand / title card ---- */
const brand = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0}
  .stage{width:${W}px;height:${H}px;background:#fff;color:#0a0a0a;padding:0 96px;display:grid;grid-template-columns:1.1fr .9fr;align-items:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .mark{display:flex;align-items:center;gap:14px;margin-bottom:30px}
  .mark svg{width:40px;height:40px}
  .mark span{font-size:26px;font-weight:600;letter-spacing:-.01em}
  h1{font-size:62px;line-height:.98;letter-spacing:-.04em;margin:0 0 22px;font-weight:700}
  p{font-size:21px;color:#5b5b5b;max-width:26ch;margin:0}
  .wf{font-family:ui-monospace,Menlo,monospace}
  .wf .head{display:flex;justify-content:space-between;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#8a8a8a;border-bottom:1px solid #e3e3e3;padding-bottom:12px;margin-bottom:16px}
  .wf .row{display:grid;grid-template-columns:120px 1fr 56px;align-items:center;gap:12px;margin:13px 0}
  .wf .n{font-size:13px;color:#8a8a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .wf .tk{position:relative;height:12px}
  .wf .tk i{position:absolute;height:12px;background:#0a0a0a;display:block}
  .wf .ms{font-size:12px;color:#8a8a8a;text-align:right}
</style></head><body><div class="stage">
  <div>
    <div class="mark"><svg viewBox="0 0 128 128"><rect x="12" y="34" width="92" height="16" rx="8"/><rect x="30" y="56" width="60" height="16" rx="8"/><rect x="20" y="78" width="76" height="16" rx="8"/></svg><span>SnapHAR</span></div>
    <h1>One-click HAR capture.</h1>
    <p>Record a tab's network traffic and export a HAR&nbsp;1.2 file — without opening DevTools.</p>
  </div>
  <div class="wf">
    <div class="head"><span>Network</span><span>7 requests</span></div>
    ${[['document', 0, 54, '210ms'], ['app.js', 8, 42, '168ms'], ['styles.css', 6, 30, '96ms'], ['GET /api/user', 18, 46, '305ms'], ['POST /collect', 30, 16, '58ms'], ['avatar.png', 22, 34, '132ms'], ['analytics.js', 34, 28, '140ms']]
      .map(([n, l, w, ms]) => `<div class="row"><span class="n">${n}</span><span class="tk"><i style="left:${l}%;width:${w}%"></i></span><span class="ms">${ms}</span></div>`).join('')}
  </div>
</div></body></html>`;
writeFileSync(join(work, 's4.html'), brand);

const url = (p) => 'file://' + p;
shoot(url(join(work, 's1.html')), '1-popup');
shoot(url(join(ROOT, 'docs/viewer/index.html')) + '#sample', '2-viewer');
shoot(url(join(work, 's3.html')), '3-options');
shoot(url(join(work, 's4.html')), '4-brand');

rmSync(work, { recursive: true, force: true });
console.log('\nDone → ' + OUT + '  (1280x800 JPEG, ready to upload)');

/**
 * Render the README figures from reports/charts.html with headless Chrome.
 *
 * Why generate rather than hand-crop a screenshot: the charts are drawn by script from
 * the numbers `analyze.js` produces, so a figure built this way cannot drift from the
 * data the way a stale PNG would. Rerun after any new batch:
 *
 *   node analysis/extract.js && node analysis/analyze.js && node analysis/make-figures.js
 *
 * Each figure isolates whole <section>s from the charts page — the page is the source of
 * truth, this only chooses what to frame and hides the prose that a figure does not need.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// Single source of truth. `mafia-charts.html` is a FRAGMENT (no <html>/<head>): it is
// written to be dropped into a host page. Everything published is derived from it here,
// so there is only ever one copy of the numbers to keep straight -- an earlier duplicate
// let a corrected figure survive in one copy and not the other.
const SRC = path.join(ROOT, 'analysis', 'mafia-charts.html');
const OUT = path.join(ROOT, 'docs');
const STANDALONE = path.join(ROOT, 'reports', 'charts.html');

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/local/bin/chromium',
].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('No Chrome/Chromium found — figures unchanged. Install one, or keep the committed PNGs.');
  process.exit(1);
}

/** `sections` are 0-based indices into the charts page; `h` is the logical window height. */
const FIGURES = [
  { name: 'detection-by-day.png', sections: [1], h: 620, stats: true },
  { name: 'model-intervals.png', sections: [3], h: 812, stats: false },
];

const body = fs.readFileSync(SRC, 'utf8');

/**
 * Wrap the fragment into a real document.
 *
 * GitHub serves .html as source rather than rendering it, so this file only earns its
 * link by working when downloaded and opened -- which needs a doctype and a <head> the
 * fragment deliberately lacks.
 */
fs.mkdirSync(path.dirname(STANDALONE), { recursive: true });
fs.writeFileSync(
  STANDALONE,
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '</head>\n<body>\n' +
    body +
    '\n</body>\n</html>\n'
);
console.log('wrote reports/charts.html (standalone)');

for (const fig of FIGURES) {
  const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#fbfbfc}
  .wrap{padding:1.1rem 1.4rem 0 !important;max-width:none !important}
  section{display:none}
  section.keep{display:block;margin-top:0 !important}
  section.keep .sec-head{border-bottom:none;padding-bottom:0.2rem}
  /* A figure carries its chart and its own title; the page's prose stays on the page. */
  .lede,.note,.callout,.tbl-toggle,footer,.standfirst,.eyebrow,h1,.meta{display:none !important}
  ${fig.stats ? '' : '.stats{display:none !important}'}
  .stats{margin-top:0 !important}
  .panel{border:none;padding:0.6rem 0 0}
</style></head><body>
${body}
<script>
  var s = document.querySelectorAll('section');
  ${JSON.stringify(fig.sections)}.forEach(function (i) { if (s[i]) s[i].classList.add('keep'); });
</script></body></html>`;

  const tmp = path.join(os.tmpdir(), 'fig-' + fig.name.replace('.png', '.html'));
  fs.writeFileSync(tmp, html);
  fs.mkdirSync(OUT, { recursive: true });

  // Old --headless deliberately: --headless=new hangs indefinitely here even with its own
  // --user-data-dir, so the timeout is a real backstop rather than paranoia.
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=4000',
    `--window-size=1040,${fig.h}`, '--force-device-scale-factor=2',
    `--screenshot=${path.join(OUT, fig.name)}`, tmp,
  ], { stdio: 'ignore', timeout: 90000 });

  const { size } = fs.statSync(path.join(OUT, fig.name));
  console.log('wrote docs/' + fig.name, (size / 1024).toFixed(0) + ' KB');
}

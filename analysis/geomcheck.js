/**
 * Layout check without a browser.
 *
 * The dataviz skill's last step is "render it and look at it" — the browser pane is
 * unresponsive here, so this replays each chart's label geometry and reports anything
 * outside the viewBox or overlapping another label. Mono glyphs are a fixed 0.60em
 * advance, which makes text width computable rather than guessed.
 */
const W = 780;
const adv = (s, size) => s.length * size * 0.6;

const problems = [];
function box(chart, s, x, y, size, anchor) {
  const w = adv(s, size);
  const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
  const b = { chart, s, x0, x1: x0 + w, y0: y - size * 0.8, y1: y + size * 0.25 };
  if (b.x0 < -2) problems.push(`${chart}: "${s}" runs off the LEFT (x0=${b.x0.toFixed(1)})`);
  if (b.x1 > W + 2) problems.push(`${chart}: "${s}" runs off the RIGHT (x1=${b.x1.toFixed(1)} > ${W})`);
  return b;
}
function collide(boxes) {
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x0 < b.x1 - 1 && b.x0 < a.x1 - 1 && a.y0 < b.y1 - 1 && b.y0 < a.y1 - 1)
        problems.push(`${a.chart}: "${a.s}" overlaps "${b.s}"`);
    }
}
const sgn = (v, d = 3) => {
  const s = Math.abs(v).toFixed(d);
  return parseFloat(s) === 0 ? s : (v >= 0 ? '+' : '−') + s;
};

/* --- 03 profiles: the chart the fix was for --- */
{
  const H = 320, L = 56, R = 132, T = 22, B = 46;
  const pw = W - L - R, ph = H - T - B, ymin = -0.03, ymax = 0.45;
  const X = (d) => L + ((d - 1) / 2) * pw;
  const Y = (v) => T + ph - ((v - ymin) / (ymax - ymin)) * ph;
  const PROF = [
    { name: 'rule-based control', ldy: 4, mark: 2, pts: [[1, 0.010], [2, 0.198], [3, 0.410]] },
    { name: 'gpt-oss:120b', ldy: -14, mark: 0, pts: [[1, 0.170], [2, 0.096]] },
    { name: 'gpt-oss:20b', ldy: 4, mark: 2, pts: [[1, 0.007], [2, 0.074], [3, 0.181]] },
  ];
  const boxes = [];
  for (const p of PROF) {
    const last = p.pts[p.pts.length - 1];
    boxes.push(box('profiles', p.name, X(last[0]) + 12, Y(last[1]) + p.ldy, 10.5, 'start'));
    const mk = p.pts[p.mark];
    boxes.push(box('profiles', sgn(mk[1]), X(mk[0]) + (p.mark === 0 ? 4 : 0), Y(mk[1]) - 13, 10.5,
      p.mark === 0 ? 'start' : 'middle'));
  }
  for (const d of [1, 2, 3]) boxes.push(box('profiles', 'day ' + d, X(d), H - B + 22, 11, 'middle'));
  collide(boxes);

  // does another series' LINE pass through a series label box?
  for (const p of PROF) {
    const last = p.pts[p.pts.length - 1];
    const lb = { x0: X(last[0]) + 12, x1: X(last[0]) + 12 + adv(p.name, 10.5),
                 y0: Y(last[1]) + p.ldy - 8.4, y1: Y(last[1]) + p.ldy + 2.6 };
    for (const q of PROF) {
      if (q === p) continue;
      for (let i = 0; i < q.pts.length - 1; i++) {
        const [d0, v0] = q.pts[i], [d1, v1] = q.pts[i + 1];
        const x0 = X(d0), x1 = X(d1);
        for (let x = Math.max(lb.x0, x0); x <= Math.min(lb.x1, x1); x += 2) {
          const y = Y(v0 + ((v1 - v0) * (x - x0)) / (x1 - x0));
          if (y >= lb.y0 && y <= lb.y1) {
            problems.push(`profiles: ${q.name}'s line crosses the "${p.name}" label`);
            x = Infinity;
          }
        }
      }
    }
  }
}

/* --- 01 funnel --- */
{
  const H = 340, L = 56, R = 20, T = 14, B = 46;
  const pw = W - L - R, ph = H - T - B, xmax = 64, ymin = -0.18, ymax = 0.46;
  const X = (g) => L + (g / xmax) * pw;
  const Y = (v) => T + ph - ((v - ymin) / (ymax - ymin)) * ph;
  const boxes = [box('funnel', '30+ games', X(30) + 8, T + 15, 10, 'start'),
    box('funnel', '+0.416 (3 games)', X(3) + 13, Y(0.416) + 4, 10, 'start'),
    box('funnel', '+0.085 (60 games)', X(60) - 12, Y(0.085) - 11, 10, 'end'),
    box('funnel', 'games in batch', L + pw / 2, H - B + 36, 10, 'middle')];
  for (const v of [-0.1, 0, 0.1, 0.2, 0.3, 0.4]) boxes.push(box('funnel', sgn(v, 2), L - 8, Y(v) + 3.5, 10, 'end'));
  for (const g of [0, 10, 20, 30, 40, 50, 60]) boxes.push(box('funnel', String(g), X(g), H - B + 18, 10, 'middle'));
  collide(boxes);
  // the widest dot must stay inside the viewBox
  if (X(60) + 5.5 > W) problems.push('funnel: 60-game dot clipped');
}

/* --- 04 leaderboard --- */
{
  const rowH = 26, L = 172, R = 62, T = 28;
  const BOARD = [
    ['gpt-oss:120b', 0.193, 0.083, 0.298], ['gemma4', 0.174, -0.064, 0.389],
    ['minimax-m3', 0.146, -0.333, 0.625], ['nemotron-3-super', 0.146, 0.012, 0.279],
    ['rule-based-v1', 0.071, 0.028, 0.118], ['granite3.1-dense:2b', 0.012, -0.106, 0.137],
    ['mistral-small:24b', 0.010, -0.139, 0.164], ['gpt-oss:20b', 0.001, -0.059, 0.061],
    ['gemma3:1b', -0.004, -0.083, 0.078], ['qwen3.5:2b', -0.047, -0.122, 0.022],
    ['llama3.1:8b', -0.059, -0.164, 0.051], ['qwen3:4b', -0.076, -0.129, -0.012],
    ['smollm2:1.7b', -0.133, -0.379, 0.128], ['ctf-custom-q4 (LoRA)', -0.157, -0.285, -0.010],
    ['granite3.2:2b', -0.160, -0.400, 0.092], ['exaone3.5:2.4b', -0.172, -0.322, -0.019],
    ['qwen2.5:3b', -0.202, -0.289, -0.114], ['llama3.2:1b', -0.400, null, null],
  ];
  const H = T + BOARD.length * rowH + 34;
  const pw = W - L - R, xmin = -0.46, xmax = 0.66;
  const X = (v) => L + ((v - xmin) / (xmax - xmin)) * pw;
  const boxes = [];
  BOARD.forEach((r, i) => {
    const y = T + i * rowH + rowH / 2;
    boxes.push(box('board', r[0], L - 12, y + 3.5, 10.5, 'end'));
    boxes.push(box('board', sgn(r[1]), W - 8, y + 3.5, 10.5, 'end'));
    if (r[2] !== null && X(r[2]) < L) problems.push(`board: ${r[0]} CI low clipped at left`);
    if (r[3] !== null && X(r[3]) > W - R) problems.push(`board: ${r[0]} CI high overruns plot`);
  });
  boxes.push(box('board', 'control +0.071', X(0.071), T - 14, 10, 'middle'));
  collide(boxes);
  // longest model name must not collide with the axis
  const longest = BOARD.reduce((a, r) => (r[0].length > a.length ? r[0] : a), '');
  if (adv(longest, 10.5) + 12 > L) problems.push(`board: label column too narrow for "${longest}"`);
}

/* --- 05 defenses --- */
{
  const L = 132, R = 168, T = 22, maxN = 24, rowH = 58, pw = W - L - R;
  const Xw = (v) => (v / maxN) * pw;
  const boxes = [];
  [['Town defends', 21, 0], ['Mafia defends', 23, 4]].forEach((d, i) => {
    const y = T + i * rowH;
    boxes.push(box('defense', d[0], L - 12, y + 25, 11, 'end'));
    boxes.push(box('defense', `${d[2]} of ${d[1]} survived`, L + Xw(d[1]) + 12, y + 26, 11, 'start'));
  });
  boxes.push(box('defense', 'bar length = defenses given · filled = defender survived the vote',
    L, 196 - 10, 10, 'start'));
  collide(boxes);
}

/* --- 06 outcomes --- */
{
  const H = 262, L = 56, R = 20, T = 20, B = 52, pw = W - L - R, ph = H - T - B;
  const Y = (v) => T + ph - (v / 0.25) * ph;
  const bw = pw / 3, boxes = [];
  [[5, 12, 2], [7, 415, 77], [10, 95, 9]].forEach((d, i) => {
    const rate = d[2] / d[1], x = L + i * bw + bw * 0.26, w = bw * 0.48;
    boxes.push(box('outcomes', (rate * 100).toFixed(1) + '%', x + w / 2, Y(rate) - 9, 11.5, 'middle'));
    boxes.push(box('outcomes', d[0] + ' seats', x + w / 2, H - B + 22, 11, 'middle'));
    boxes.push(box('outcomes', d[2] + ' of ' + d[1], x + w / 2, H - B + 37, 10, 'middle'));
  });
  boxes.push(box('outcomes', 'all games 16.9%', L + pw, Y(88 / 522) - 8, 10, 'end'));
  collide(boxes);
  // the 16.9% reference label must not sit on top of a bar's value label
  const r7 = 77 / 415;
  if (Math.abs(Y(r7) - 9 - (Y(88 / 522) - 8)) < 12) problems.push('outcomes: 16.9% line label near the 7-seat value');
}

if (problems.length) { console.log('PROBLEMS:'); problems.forEach((p) => console.log('  ✗ ' + p)); }
else console.log('✓ all label boxes inside the viewBox, no overlaps, no line/label crossings');

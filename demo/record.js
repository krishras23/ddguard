// Renders demo/output.ansi as a terminal and films it frame by frame.
// Usage: node demo/record.js   (needs puppeteer-core and ffmpeg)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer-core');

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DIR = __dirname;
const FRAMES = path.join(DIR, 'frames');
const FPS = 20;
const HOLD = 2.5;

const CLASS = { 31: 'fail', 33: 'warn', 32: 'pass', 2: 'dim' };

function ansiToHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let out = '';
  let open = false;
  const re = /\x1b\[(\d+)m/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    const code = Number(m[1]);
    if (code === 0) { if (open) { out += '</span>'; open = false; } }
    else if (CLASS[code]) { if (open) out += '</span>'; out += `<span class="${CLASS[code]}">`; open = true; }
    last = re.lastIndex;
  }
  out += esc(text.slice(last));
  if (open) out += '</span>';
  return out;
}

const page = (lines) => `<!doctype html><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box }
  body { background:#14161a; font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;
         display:flex; align-items:center; justify-content:center; height:100vh }
  .win { width:1180px; height:700px; background:#1b1e24; border-radius:10px; overflow:hidden;
         box-shadow:0 24px 70px rgba(0,0,0,.6); display:flex; flex-direction:column }
  .bar { height:34px; background:#23272e; display:flex; align-items:center; padding:0 13px; gap:8px; flex:0 0 auto }
  .dot { width:11px; height:11px; border-radius:50% }
  .t { margin-left:10px; color:#7d8590; font-size:12px }
  .body { padding:16px 20px; color:#d5dae1; white-space:pre-wrap; overflow:hidden; flex:1 }
  .fail { color:#f2637a } .warn { color:#e3b341 } .pass { color:#57d178 } .dim { color:#7d8590 }
  .prompt { color:#57d178 } .cmd { color:#d5dae1 }
  .cur { display:inline-block; width:8px; height:15px; background:#d5dae1; vertical-align:-2px }
  .hide { visibility:hidden }
</style>
<div class="win">
  <div class="bar">
    <div class="dot" style="background:#ff5f57"></div>
    <div class="dot" style="background:#febc2e"></div>
    <div class="dot" style="background:#28c840"></div>
    <div class="t">ddguard — pre-merge monitor checks</div>
  </div>
  <div class="body" id="b"></div>
</div>
<script>
const LINES = ${JSON.stringify(lines)};
const CMD = 'make demo';
const b = document.getElementById('b');
window.render = (typed, shown) => {
  const cmd = '<span class="prompt">$</span> <span class="cmd">' + CMD.slice(0, typed) + '</span>'
    + (shown === 0 ? '<span class="cur"></span>' : '');
  b.innerHTML = cmd + '\\n\\n' + LINES.slice(0, shown).join('\\n');
};
window.render(0, 0);
</script>`;

(async () => {
  const raw = fs.readFileSync(path.join(DIR, 'output.ansi'), 'utf8').replace(/\r/g, '');
  const lines = raw.split('\n').map(ansiToHtml);

  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });

  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--force-device-scale-factor=2'] });
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  await p.setContent(page(lines));

  let n = 0;
  const shot = async () => p.screenshot({ path: path.join(FRAMES, String(n++).padStart(5, '0') + '.png') });

  for (let i = 0; i <= 'make demo'.length; i++) { await p.evaluate((t) => window.render(t, 0), i); await shot(); await shot(); }
  for (let i = 0; i < FPS * 0.6; i++) await shot();

  // reveal roughly a screenful, then scroll with the output
  for (let i = 1; i <= lines.length; i++) {
    await p.evaluate((s) => {
      window.render(9, s);
      const b = document.getElementById('b');
      b.scrollTop = b.scrollHeight;
    }, i);
    const line = lines[i - 1] || '';
    // let each finding sit long enough to actually read; failures get the longest
    const hold = /class="fail">FAIL/.test(line) ? FPS * 1.6
      : /class="(warn|pass)">(WARN|PASS)/.test(line) ? FPS * 0.9
      : 2;
    for (let k = 0; k < hold; k++) await shot();
  }
  for (let i = 0; i < FPS * HOLD; i++) await shot();

  await browser.close();

  const mp4 = path.join(DIR, 'ddguard.mp4');
  const gif = path.join(DIR, 'ddguard.gif');
  execFileSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES, '%05d.png'),
    '-vf', 'scale=1180:-2:flags=lanczos', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', mp4],
    { stdio: 'ignore' });
  execFileSync('ffmpeg', ['-y', '-i', mp4, '-vf',
    'fps=12,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
    gif], { stdio: 'ignore' });

  fs.rmSync(FRAMES, { recursive: true, force: true });
  console.log(`${n} frames -> ${mp4} (${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB), ${gif} (${(fs.statSync(gif).size / 1e6).toFixed(1)} MB)`);
})();

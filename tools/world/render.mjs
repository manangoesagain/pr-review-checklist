// Records the world into the scroll clips: one "dive" per scene and one connector
// between each pair, sharing their boundary frames exactly so the seams can't pop.
//   node render.mjs desktop OUT   (1920x1080)   |   node render.mjs portrait OUT (720x1280, phones)
// Frames go to a temporary folder (kept, so a stopped run picks up where it left off,
// as long as world.js hasn't changed).
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const mode = process.argv[2] === 'portrait' ? 'portrait' : 'desktop';
const out = path.resolve(process.argv[3] || 'out');
const [width, height] = mode === 'portrait' ? [720, 1280] : [1920, 1080];
const suffix = mode === 'portrait' ? '-m' : '';
const types = { '.js': 'text/javascript', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(0);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width, height } });
page.on('pageerror', (e) => console.log('page error:', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/render.html?w=${width}&h=${height}&portrait=${mode === 'portrait' ? 1 : 0}`);
await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
const { segments, FPS } = await page.evaluate(() => window.info);

// Saved frames are reused only while world.js and the size are unchanged.
const stamp = createHash('sha1').update(fs.readFileSync(path.join(root, 'world.js'))).update(`${width}x${height}`).digest('hex').slice(0, 12);
fs.mkdirSync(path.join(out, 'vid'), { recursive: true });
const started = Date.now();
for (const seg of segments) {
  const name = seg.kind === 'dive' ? seg.name : `conn${seg.index + 1}`;
  const dir = path.join(os.tmpdir(), 'pr-checklist-world-frames', stamp, `${name}${suffix}`);
  fs.mkdirSync(dir, { recursive: true });
  const count = Math.round(seg.seconds * FPS);
  for (let k = 0; k <= count; k++) {
    const file = path.join(dir, `${String(k).padStart(4, '0')}.png`);
    if (fs.existsSync(file)) continue; // Resumable.
    const T = seg.start + (k / count) * seg.seconds;
    const data = await page.evaluate((T) => window.frame(T), T);
    fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
  }
  const gop = mode === 'portrait' ? 4 : 6;
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', path.join(dir, '%04d.png'), '-an',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', mode === 'portrait' ? '24' : '22', '-pix_fmt', 'yuv420p',
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-movflags', '+faststart',
    path.join(out, 'vid', `${name}${suffix}.mp4`)]);
  // A VP9 copy for Chrome, Edge and Firefox, with the same keyframe spacing.
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', path.join(dir, '%04d.png'), '-an',
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', mode === 'portrait' ? '35' : '33', '-pix_fmt', 'yuv420p',
    '-g', String(gop), '-keyint_min', String(gop), '-row-mt', '1', '-deadline', 'good', '-cpu-used', '3',
    path.join(out, 'vid', `${name}${suffix}.webm`)]);
  if (seg.kind === 'dive') {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(dir, '0000.png'), '-quality', '90', path.join(out, `${name}${suffix}.webp`)]);
  }
  console.log(`${name}${suffix} done after ${Math.round((Date.now() - started) / 1000)} s`);
}
await browser.close();
server.close();

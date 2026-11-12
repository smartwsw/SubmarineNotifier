// 本地假 Bark 服务，用于 Phase 5 联调。
// 仅监听 127.0.0.1，记录每次 POST /push 的请求体到 received.jsonl，
// 并支持通过 /_control 注入失败（模拟 Bark 5xx / 网络错误）。
import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const port = Number(args.get('port') ?? 8790);
const out = resolve(args.get('out') ?? './received.jsonl');
mkdirSync(dirname(out), { recursive: true });
if (!existsSync(out)) writeFileSync(out, '');

// 失败计划：数组元素按顺序消费；'ok' | 'fail500' | 'fail400' | 'reset'
let plan = [];
if (args.has('plan')) plan = String(args.get('plan')).split(',').filter(Boolean);

let received = 0;

function log(entry) {
  appendFileSync(out, JSON.stringify(entry) + '\n');
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (url.pathname === '/_control') {
      // GET /_control?plan=fail500,ok  → 重置失败计划
      const value = url.searchParams.get('plan');
      if (value !== null) plan = value.split(',').filter(Boolean);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, plan, received }));
      return;
    }

    if (url.pathname === '/_received') {
      const lines = existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean) : [];
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ count: lines.length, entries: lines.map((l) => JSON.parse(l)) }));
      return;
    }

    if (req.method !== 'POST' || url.pathname !== '/push') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 404, message: 'not found' }));
      return;
    }

    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { unparsed: raw };
    }

    const step = plan.shift() ?? 'ok';
    received += 1;
    log({ at: new Date().toISOString(), step, body });

    if (step === 'reset') {
      req.socket.destroy();
      return;
    }
    if (step === 'fail500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 500, message: 'simulated bark failure' }));
      return;
    }
    if (step === 'fail400') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 400, message: 'bad device key' }));
      return;
    }
    if (step === 'slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 200, message: 'success' }));
      }, 12_000);
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 200, message: 'success' }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake-bark listening on http://127.0.0.1:${port} -> ${out}`);
});

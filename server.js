import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.DO_INFERENCE_KEY;
if (!API_KEY) {
  console.error('Missing required env var: DO_INFERENCE_KEY. Copy .env.example to .env and fill in the value.');
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_ROUTER = process.env.DEFAULT_ROUTER || 'router:your-router-name';
const BASE = 'https://inference.do-ai.run';
const PATH_MODELS = '/v1/models';
const PATH_CHAT = '/v1/chat/completions';
const PATH_IMAGES = '/v1/images/generations';

const PUBLIC_CONFIG = {
  brandTitle: 'Inference Demo',
  inferenceHost: 'inference.do-ai.run',
  baseUrl: BASE,
  defaultRouter: DEFAULT_ROUTER,
  apiPathModels: PATH_MODELS,
  apiPathChat: PATH_CHAT,
  apiPathImages: PATH_IMAGES,
  fallbackModels: [
    'llama3.3-70b-instruct',
    'openai-gpt-oss-120b',
    'openai-gpt-oss-20b',
    'anthropic-claude-haiku-4.5',
    'anthropic-claude-4.6-sonnet',
    'openai-gpt-5-nano',
    'openai-gpt-5-mini',
    'alibaba-qwen3-32b'
  ],
  compareDefaultModels: [
    'anthropic-claude-haiku-4.5',
    'openai-gpt-oss-20b',
    'llama3.3-70b-instruct'
  ],
  preferredModels: ['anthropic-claude-haiku-4.5', 'llama3.3-70b-instruct'],
  imageModels: ['openai-gpt-image-1', 'openai-gpt-image-1.5', 'fal-ai/flux/schnell', 'fal-ai/fast-sdxl'],
  imageSizes: ['1024x1024', '1024x1536', '1536x1024'],
  defaultImageSize: '1024x1024',
  defaultImageCount: 1,
  defaultMaxTokensSingle: 400,
  defaultTemperatureSingle: 0.7,
  defaultMaxTokensCompare: 500,
  defaultTemperatureCompare: 0.3,
  defaultMaxTokensRouter: 500,
  defaultTemperatureRouter: 0.3
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function doFetch(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function handleModels(req, res) {
  const r = await doFetch(PATH_MODELS, { method: 'GET' });
  res.writeHead(r.status, { 'Content-Type': 'application/json' });
  res.end(r.text);
}

function handleConfig(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(PUBLIC_CONFIG));
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const t0 = Date.now();
  const r = await doFetch(PATH_CHAT, { method: 'POST', body });
  const latency_ms = Date.now() - t0;
  res.writeHead(r.status, { 'Content-Type': 'application/json' });
  try {
    const data = JSON.parse(r.text);
    data.latency_ms = latency_ms;
    res.end(JSON.stringify(data));
  } catch {
    res.end(JSON.stringify({ error: r.text, latency_ms }));
  }
}

async function handleImage(req, res) {
  const body = await readBody(req);
  const t0 = Date.now();
  const r = await doFetch(PATH_IMAGES, { method: 'POST', body });
  const latency_ms = Date.now() - t0;
  res.writeHead(r.status, { 'Content-Type': 'application/json' });
  try {
    const data = JSON.parse(r.text);
    data.latency_ms = latency_ms;
    res.end(JSON.stringify(data));
  } catch {
    res.end(JSON.stringify({ error: r.text, latency_ms }));
  }
}

async function handleCompare(req, res) {
  const { models = [], messages = [], max_completion_tokens, temperature } = JSON.parse(await readBody(req));
  const results = await Promise.all(
    models.map(async (model) => {
      const t0 = Date.now();
      try {
        const payload = { model, messages, max_completion_tokens };
        if (temperature !== undefined) payload.temperature = temperature;
        const r = await doFetch(PATH_CHAT, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        const latency_ms = Date.now() - t0;
        let data;
        try { data = JSON.parse(r.text); } catch { data = { raw: r.text }; }
        return { model, status: r.status, latency_ms, data };
      } catch (e) {
        return { model, status: 0, latency_ms: Date.now() - t0, error: String(e) };
      }
    })
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ results }));
}

async function serveStatic(req, res) {
  let p = req.url === '/' ? '/index.html' : req.url;
  p = p.split('?')[0];
  const filePath = join(__dirname, 'public', p);
  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error('not file');
    const data = await readFile(filePath);
    const type = MIME[extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/api/chat' && req.method === 'POST') return handleChat(req, res);
    if (req.url === '/api/compare' && req.method === 'POST') return handleCompare(req, res);
    if (req.url === '/api/image' && req.method === 'POST') return handleImage(req, res);
    if (req.url === '/api/models' && req.method === 'GET') return handleModels(req, res);
    if (req.url === '/api/config' && req.method === 'GET') return handleConfig(req, res);
    return serveStatic(req, res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e) }));
  }
});

server.listen(PORT, () => {
  console.log(`\n${PUBLIC_CONFIG.brandTitle} → http://localhost:${PORT}\n`);
});

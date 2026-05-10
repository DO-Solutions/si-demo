import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PAGE_ACCESS_PASSWORD = (process.env.PAGE_ACCESS_PASSWORD ?? '').trim();
const ACCESS_REQUIRED = PAGE_ACCESS_PASSWORD.length > 0;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function resolveSessionSigningKey() {
  const explicit = (process.env.PAGE_SESSION_SECRET ?? '').trim();
  if (explicit) return { key: Buffer.from(explicit, 'utf8'), ephemeral: false };
  if (!ACCESS_REQUIRED) return { key: null, ephemeral: false };
  return { key: randomBytes(32), ephemeral: true };
}

const { key: SESSION_SIGNING_KEY, ephemeral: SESSION_KEY_EPHEMERAL } = resolveSessionSigningKey();

if ((process.env.PAGE_SESSION_SECRET ?? '').trim() && !ACCESS_REQUIRED) {
  console.warn(
    '[si-demo] PAGE_SESSION_SECRET is set but PAGE_ACCESS_PASSWORD is empty — the page gate stays off. Set a non-empty PAGE_ACCESS_PASSWORD to require unlock.'
  );
}

function timingSafePasswordEqual(provided, expected) {
  const a = createHash('sha256').update(String(provided ?? ''), 'utf8').digest();
  const b = createHash('sha256').update(String(expected ?? ''), 'utf8').digest();
  return timingSafeEqual(a, b);
}

function issueSessionToken() {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ exp }), 'utf8').toString('base64url');
  const sig = createHmac('sha256', SESSION_SIGNING_KEY).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || !SESSION_SIGNING_KEY) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payloadPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  const expectedSig = createHmac('sha256', SESSION_SIGNING_KEY).update(payloadPart).digest('base64url');
  const sb = Buffer.from(sigPart, 'utf8');
  const eb = Buffer.from(expectedSig, 'utf8');
  if (sb.length !== eb.length) return false;
  if (!timingSafeEqual(sb, eb)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}

function bearerToken(req) {
  const h = req.headers.authorization;
  if (!h || typeof h !== 'string' || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

function sendUnauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

function requireSession(req, res) {
  if (!ACCESS_REQUIRED) return true;
  const token = bearerToken(req);
  if (!token || !verifySessionToken(token)) {
    sendUnauthorized(res);
    return false;
  }
  return true;
}

function pathname(req) {
  return req.url.split('?')[0];
}

const API_KEY = process.env.DO_INFERENCE_KEY;
if (!API_KEY) {
  console.error('Missing required env var: DO_INFERENCE_KEY. Set it in your environment, or copy .env.example to .env and fill it in.');
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
  res.end(JSON.stringify({ ...PUBLIC_CONFIG, accessRequired: ACCESS_REQUIRED }));
}

async function handleSession(req, res) {
  if (!ACCESS_REQUIRED) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: null }));
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_json' }));
    return;
  }
  const password = body?.password;
  if (!timingSafePasswordEqual(password, PAGE_ACCESS_PASSWORD)) {
    sendUnauthorized(res);
    return;
  }
  const token = issueSessionToken();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ token }));
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
    const path = pathname(req);
    if (path === '/api/chat' && req.method === 'POST') {
      if (!requireSession(req, res)) return;
      return handleChat(req, res);
    }
    if (path === '/api/compare' && req.method === 'POST') {
      if (!requireSession(req, res)) return;
      return handleCompare(req, res);
    }
    if (path === '/api/image' && req.method === 'POST') {
      if (!requireSession(req, res)) return;
      return handleImage(req, res);
    }
    if (path === '/api/models' && req.method === 'GET') {
      if (!requireSession(req, res)) return;
      return handleModels(req, res);
    }
    if (path === '/api/config' && req.method === 'GET') return handleConfig(req, res);
    if (path === '/api/session' && req.method === 'POST') return handleSession(req, res);
    return serveStatic(req, res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e) }));
  }
});

server.listen(PORT, () => {
  console.log(`\n${PUBLIC_CONFIG.brandTitle} → http://localhost:${PORT}\n`);
  if (ACCESS_REQUIRED) {
    console.log('[si-demo] Page access gate on — unlock with PAGE_ACCESS_PASSWORD.');
    if (SESSION_KEY_EPHEMERAL) {
      console.log(
        '[si-demo] Session signing key is ephemeral (random at startup) — tokens do not survive server restart. Set PAGE_SESSION_SECRET for a stable key.'
      );
    }
    console.log('');
  }
});

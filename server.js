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
  try {
    let p = req.url.split('?')[0];
    p = decodeURIComponent(p);
    p = p.replace(/\/{2,}/g, '/');
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  } catch {
    let p = req.url.split('?')[0];
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  }
}

function parseAsyncInvokeRoute(path) {
  const prefix = '/api/async-invoke/';
  if (!path.startsWith(prefix)) return null;
  const tail = path.slice(prefix.length);
  if (!tail || tail.includes('..')) return null;
  const statusSuffix = '/status';
  if (tail.endsWith(statusSuffix)) {
    const id = tail.slice(0, -statusSuffix.length);
    if (!id) return null;
    return { kind: 'status', id };
  }
  return { kind: 'result', id: tail };
}

function isSafeAsyncInvokeId(id) {
  return typeof id === 'string' && /^[0-9a-fA-F-]{8,128}$/.test(id);
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
const PATH_ASYNC_INVOKE = '/v1/async-invoke';
// Router reports the route it picked (e.g. a model id, or "fallback") in this response header.
const ROUTER_ROUTE_HEADER = 'x-model-router-selected-route';

const PUBLIC_CONFIG = {
  brandTitle: 'Inference Demo',
  inferenceHost: 'inference.do-ai.run',
  baseUrl: BASE,
  defaultRouter: DEFAULT_ROUTER,
  apiPathModels: PATH_MODELS,
  apiPathChat: PATH_CHAT,
  apiPathImages: PATH_IMAGES,
  apiPathAsyncInvoke: PATH_ASYNC_INVOKE,
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
  audioGenModels: ['fal-ai/stable-audio-25/text-to-audio'],
  audioTtsModels: ['fal-ai/elevenlabs/tts/multilingual-v2'],
  imageSizes: ['1024x1024', '1024x1536', '1536x1024'],
  defaultImageSize: '1024x1024',
  defaultImageCount: 1,
  defaultMaxTokensSingle: 400,
  defaultTemperatureSingle: 0.7,
  defaultMaxTokensCompare: 500,
  defaultTemperatureCompare: 0.3,
  defaultMaxTokensRouter: 2048,
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

const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 120000;

async function doFetch(path, init = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        ...(init.headers || {})
      }
    });
    const text = await res.text();
    return { status: res.status, text, routedRoute: res.headers.get(ROUTER_ROUTE_HEADER) };
  } catch (e) {
    if (e?.name === 'AbortError') {
      return {
        status: 504,
        text: JSON.stringify({
          error: 'upstream_timeout',
          detail: `No response from ${BASE}${path} within ${UPSTREAM_TIMEOUT_MS} ms`
        })
      };
    }
    return {
      status: 502,
      text: JSON.stringify({ error: 'upstream_fetch_failed', detail: String(e?.cause?.message || e?.message || e) })
    };
  } finally {
    clearTimeout(timer);
  }
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
  res.writeHead(r.status, {
    'Content-Type': 'application/json',
    ...(r.routedRoute ? { [ROUTER_ROUTE_HEADER]: r.routedRoute } : {})
  });
  try {
    const data = JSON.parse(r.text);
    data.latency_ms = latency_ms;
    if (r.routedRoute) data.router_selected_route = r.routedRoute;
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

async function handleAsyncInvoke(req, res) {
  const body = await readBody(req);
  const t0 = Date.now();
  const r = await doFetch(PATH_ASYNC_INVOKE, { method: 'POST', body });
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

async function handleAsyncInvokeStatus(req, res, id) {
  if (!isSafeAsyncInvokeId(id)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_request_id' }));
    return;
  }
  const t0 = Date.now();
  const r = await doFetch(`${PATH_ASYNC_INVOKE}/${id}/status`, { method: 'GET' });
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

async function handleAsyncInvokeResult(req, res, id) {
  if (!isSafeAsyncInvokeId(id)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_request_id' }));
    return;
  }
  const t0 = Date.now();
  const r = await doFetch(`${PATH_ASYNC_INVOKE}/${id}`, { method: 'GET' });
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
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, HEAD' });
    res.end(
      JSON.stringify({
        error: 'method_not_allowed',
        hint: 'Run the demo API with npm start from the project root; plain static hosts have no /api routes.'
      })
    );
    return;
  }
  let p = req.url === '/' ? '/index.html' : req.url;
  p = p.split('?')[0];
  try {
    p = decodeURIComponent(p);
    p = p.replace(/\/{2,}/g, '/');
  } catch {
    /* use raw path */
  }
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
      return await handleChat(req, res);
    }
    if (path === '/api/compare' && req.method === 'POST') {
      if (!requireSession(req, res)) return;
      return await handleCompare(req, res);
    }
    if (path === '/api/image' && req.method === 'POST') {
      if (!requireSession(req, res)) return;
      return await handleImage(req, res);
    }
    if (path === '/api/async-invoke' && req.method === 'POST') {
      if (!requireSession(req, res)) return;
      return await handleAsyncInvoke(req, res);
    }
    if (path.startsWith('/api/async-invoke/') && req.method === 'GET') {
      if (!requireSession(req, res)) return;
      const parsed = parseAsyncInvokeRoute(path);
      if (!parsed) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      if (parsed.kind === 'status') return await handleAsyncInvokeStatus(req, res, parsed.id);
      return await handleAsyncInvokeResult(req, res, parsed.id);
    }
    if (path === '/api/models' && req.method === 'GET') {
      if (!requireSession(req, res)) return;
      return await handleModels(req, res);
    }
    if (path === '/api/config' && req.method === 'GET') return handleConfig(req, res);
    if (path === '/api/session' && req.method === 'POST') return await handleSession(req, res);
    if (path.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown_api_route', path }));
      return;
    }
    return await serveStatic(req, res);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    } else {
      res.end();
    }
  }
});

// Safety net: never let a stray async rejection take down the demo server.
process.on('unhandledRejection', (reason) => {
  console.error('[si-demo] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[si-demo] uncaughtException:', err);
});

server.listen(PORT, () => {
  console.log(`\n${PUBLIC_CONFIG.brandTitle} → http://localhost:${PORT}`);
  console.log('API routes: /api/config, /api/models, /api/chat, /api/compare, /api/image, POST /api/async-invoke, GET /api/async-invoke/:id(/status)\n');
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

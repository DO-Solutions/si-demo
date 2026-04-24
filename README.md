# DO Inference Demo

A small browser demo for the DigitalOcean Inference API. Single Node.js server (no dependencies — stdlib only) plus a static HTML/JS frontend. Built for live walkthroughs of chat, multi-model comparison, routing, and image generation against `inference.do-ai.run`.

![Serverless Inference tab](docs/si-demo.png)

## What it shows

- **Single chat** — pick any model from the catalog and send an OpenAI-compatible chat request. Server-measured latency and token counts inline.
- **Compare** — fan out one prompt to N models in parallel, side-by-side results, fastest highlighted.
- **Router** — preset prompts walk through the router's task classes (summarization, code, reasoning, etc.) and show which downstream model it picked.
- **Image** — generate images through the same endpoint at `/v1/images/generations`.

## Requirements

- Node.js >= 20 (uses `--env-file` and the global `fetch`)
- A DigitalOcean Inference API key

## Setup

```sh
cp .env.example .env
# edit .env and fill in DO_INFERENCE_KEY and DEFAULT_ROUTER
npm start
```

The server listens on `http://localhost:3000` by default.

## Configuration

Only two values are externalized — everything else (base URL, paths, model lists, UI defaults, branding) lives as inline constants in `server.js` so the demo runs with minimal env setup.

| Variable | Required | Description |
|---|---|---|
| `DO_INFERENCE_KEY` | yes | Your DigitalOcean Inference API key. |
| `DEFAULT_ROUTER` | recommended | Router model identifier shown in the Router tab (e.g. `router:your-router-name`). |
| `PORT` | no | Override the listen port. Defaults to `3000`. |

If you need to point at a different base URL, change endpoint paths, swap the model lists, or tweak the UI defaults, edit the constants near the top of `server.js`.

## Layout

```
server.js          # HTTP server + API proxy + /api/config
public/
  index.html       # Single-page UI (chat, compare, router, image)
  assets/          # Logo
.env.example       # Template — copy to .env
```

## Endpoints

The frontend talks to the local server, which proxies through to Inference using the API key (the key never reaches the browser).

| Path | Method | Forwards to |
|---|---|---|
| `/api/chat` | POST | `/v1/chat/completions` |
| `/api/compare` | POST | `/v1/chat/completions` (fan-out across N models) |
| `/api/image` | POST | `/v1/images/generations` |
| `/api/models` | GET | `/v1/models` |
| `/api/config` | GET | Returns the public config consumed by the frontend |

## Notes

- The server caps request bodies at 10 MB.
- `.env` is gitignored — verify before your first push with `git check-ignore -v .env`.
- The default router string in `server.js` is a placeholder. Set `DEFAULT_ROUTER` in `.env` to the router you actually want to demo.

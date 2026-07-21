# GitNexus on Render

Deploy [GitNexus](https://github.com/abhigyanpatwari/GitNexus) on Render in one click. Get a hosted **code-intelligence** service that indexes a repository into a knowledge graph, then lets you explore call graphs, run queries, and see the blast radius of a change — all from a browser.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/render-examples/GitNexus-Render)


https://github.com/user-attachments/assets/e2e57b2d-c424-42cc-a9f5-716abd0cfaa0


## What it does

GitNexus parses a codebase into a graph of symbols and relationships and exposes it through a web UI: index a repo, browse the call/inheritance graph, search execution flows, and run impact analysis ("what breaks if I change this?"). The core needs **no API key** — everything in this deploy runs on the code graph alone.

> Full documentation, language support, and CLI usage live in the upstream project: **[abhigyanpatwari/GitNexus](https://github.com/abhigyanpatwari/GitNexus)**.

## Prerequisites

- A [Render account](https://render.com) — for the one-click deploy.
- A [GitHub account](https://github.com) — only if you want to fork and customize this repo before deploying.
- **No API keys required** for the core app. Two integrations are optional: an Azure DevOps Server URL + PAT (to index from Azure DevOps), and your own provider key for the in-app LLM chat (bring-your-own-key, stays in your browser). Both are covered below.
- For **local development only**: [Docker](https://docs.docker.com/get-docker/) and Docker Compose.

## Architecture

This Blueprint deploys **two services** under one `gitnexus` Render project:

```
                        Render project: gitnexus
   ┌───────────────────────────────────────────────────────────────┐
   │                                                               │
   │   ┌───────────────────┐         ┌───────────────────┐         │
   │   │   gitnexus-web    │  /api/* │  gitnexus-server  │         │
   │   │   PUBLIC (Docker) │  proxy  │  PRIVATE (Docker) │         │
   │   │                   │ ──────▶ │                   │         │
   │   │  • serves web UI  │ ◀────── │  • clones repos   │         │
   │   │  • reverse-proxies│         │  • indexes graph  │         │
   │   │    /api/* calls   │         │  • query / impact │         │
   │   └───────────────────┘         └─────────┬─────────┘         │
   │             ▲                             │                   │
   │             │                    ┌────────▼───────────┐       │
   └─────────────┼────────────────────┤  Persistent disk   ├───────┘
                 │                    │  /data/gitnexus    │
   same-origin   │                    │  index · repos ·   │
   requests      │                    │     registry       │
                 │                    └────────────────────┘
            ┌────┴────┐
            │ Browser │   Only gitnexus-web is reachable from the internet.
            │ (user)  │   The server is internal-only, runs as a single
            └─────────┘   instance, and keeps all state on the disk.
```

| Service | Type | Role |
|---------|------|------|
| `gitnexus-server` | **Private** service (Docker) | The code-intelligence API. Clones and indexes repos; keeps its index, cloned repos, and registry on a persistent disk (`/data/gitnexus`). Internal-only — never exposed to the public internet. |
| `gitnexus-web` | **Public** web service (Docker) | Serves the web UI **and** reverse-proxies every `/api/*` call to the private server. The browser only ever makes same-origin requests, so there's no CORS to configure and no public API server to abuse. |

Because the server keeps state on a disk, it runs as a single instance.

## Deploy

1. Click **Deploy to Render** above (or fork this repo and point a new Blueprint at your fork).
2. Render reads [`render.yaml`](render.yaml) and provisions both services plus the disk.
3. Wait for both services to go **live**, then open the `gitnexus-web` URL.

No environment variables are required for the core app. Two are optional:

| Env var | Service | Required? | What it's for |
|---------|---------|-----------|---------------|
| `AZURE_DEVOPS_URL` | `gitnexus-server` | Optional | Base URL of an Azure DevOps Server instance to index from. |
| `AZURE_DEVOPS_PAT` | `gitnexus-server` | Optional | Personal access token for that instance (marked `sync: false` — Render prompts you for it; it is never committed). |

Leave both unset to skip the Azure DevOps integration.

### Using the app

Once `gitnexus-web` is live, you can see it working with **no API key**:

1. Open the `gitnexus-web` service URL.
2. Point GitNexus at a repository to index (e.g. a public GitHub URL, or a repo already available to the server) and start indexing.
3. When indexing finishes, **browse the graph** — click a symbol to see its callers and callees.
4. Run a **query** to find an execution flow by concept (e.g. "authentication").
5. Open **impact analysis** on a symbol to see its blast radius — the direct callers and affected flows.

That's the full loop: index → graph → query → impact, entirely on the code graph.

### Large repositories

Indexing is memory-intensive — it is the peak-RAM step of the whole app. The default `gitnexus-server` runs on a **2 GB (`standard`)** instance, which comfortably handles small and mid-sized repos. A very large repo can need more memory than that to finish.

When a repo exceeds the available memory, the indexing worker aborts and the **job fails cleanly with an out-of-memory error** — the server (and every other in-flight job) stays up. If you hit that, you have two knobs:

- **Give the indexer more RAM (recommended for large repos).** In [`render.yaml`](render.yaml), raise the `gitnexus-server` `plan` (e.g. `pro` → 4 GB, `pro plus` → 8 GB) and redeploy. This is the real fix for a repo that genuinely needs more memory.
- **Tune the worker heap ceiling (advanced).** `GITNEXUS_SERVER_WORKER_MAX_OLD_SPACE_MB` on `gitnexus-server` overrides the per-worker V8 old-space heap cap (MB). It defaults to ~75% of the instance's memory. Leave it unset unless you have a specific reason — setting it **above** the instance's real RAM re-introduces the kernel OOM-kill that this default is designed to avoid.

> **Optional LLM chat.** GitNexus also has an in-app chat that talks to an LLM. It is a **bring-your-own-key, client-side** feature: you paste your own provider key into the app's Settings, it is held only in your browser session, and it is sent only to the provider you choose — never to this server and never stored by the deploy. It is not required for anything above.
>
> **There is no backend env var for the chat.** Adding `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / etc. to the `gitnexus-server` (or `gitnexus-web`) service does **not** enable it — the browser calls the provider directly, so the key lives only in the app. To turn the chat on: open `gitnexus-web`, go to **Settings**, pick a provider, and paste your key. Supported providers: **OpenAI, Azure OpenAI, Google Gemini, Anthropic, OpenRouter, MiniMax, GLM (Z.AI), DeepSeek**, and **Ollama** (local, no key). Each key goes straight to that provider's API from your browser.
>
> (The only LLM-related backend env vars in this repo — `OPENAI_API_KEY`, `GITNEXUS_API_KEY`, `GITNEXUS_LLM_BASE_URL` — are used solely by the separate offline `gitnexus wiki` CLI generator, not by the chat or the deployed services.)

## Demo mode

Demo mode is **off by default**. For public, shareable deployments, enable it by setting `DEMO=true` in the Render dashboard on **`gitnexus-server` only** (`render.yaml` marks it `sync: false`, so it's dashboard-managed and a Blueprint sync never overrides it). The web UI picks it up automatically via `GET /api/info` — no env var on `gitnexus-web`. In demo mode visitors can still index their own repositories, but each added repo is private to the browser session that created it and is erased when that session ends; the pre-indexed "seed" repos stay browsable by everyone and are read-only. Leave `DEMO` unset for a normal single-tenant deploy.

## Security notes

- The API server is a **private** Render service, so the repo-indexing endpoints are not reachable from the public internet — only the web service (which proxies same-origin) can reach it.
- No secret is baked into the Blueprint. The optional Azure PAT is `sync: false` (entered in the dashboard, never in the repo). The LLM chat key, if you use it, stays in your browser.

## Local development

Run both services locally with Docker Compose (uses the published images):

```bash
cp .env.example .env   # optional; fill in overrides
docker compose up
```

The web UI comes up on <http://localhost:4173> and talks to the server on <http://localhost:4747>. See [`.env.example`](.env.example) for the available knobs.

## License

GitNexus is licensed **PolyForm Noncommercial** — see [LICENSE](LICENSE). It is maintained upstream at [abhigyanpatwari/GitNexus](https://github.com/abhigyanpatwari/GitNexus).

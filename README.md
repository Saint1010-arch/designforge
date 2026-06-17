# DesignForge 设界

> 读懂任何网站与 HTML 的设计语言，一键做同款、按权重融合、升级锻造。

Analyze any website's (or raw HTML's) design language, then rebuild a same-style page — or fuse multiple sources into one new aesthetic. A local, BYOK (bring-your-own-key) tool with a polished bilingual web UI and a real headless browser.

## What it does
- **Analyze** — Spins up a real headless browser, extracts design tokens (palette, fonts, radii, shadows, layout topology, assets), and produces a **design report** plus a reusable **"same-style prompt"**.
- **Clone** — Shows the report first, then generates a same-style **Next.js** project. Optional customization box (e.g. "change the title, use a teal accent").
- **Fuse** — Blends two sites' design languages by a weight slider, then generates a new same-style site.

Every action returns a **report first**, then proceeds.

## Key design choices
- **BYOK**: your LLM API key lives only in your browser's localStorage; it is never stored server-side. Works with any OpenAI-compatible endpoint (custom Base URL + model).
- **Real extraction**: uses Playwright/Chromium, not a static fetch.
- **Local-first**: runs entirely on your machine.

## Run from source
```bash
npm install
npm run build
npm start            # serves the web UI (default), auto-opens browser on :4571
# or use the CLI directly:
node dist/cli.js analyze https://example.com --api-key sk-...
node dist/cli.js clone   https://example.com --instructions "change the title"
node dist/cli.js fuse    https://a.com https://b.com --weight 60
```

## Offline Windows bundle (no install needed)
Build a self-contained, double-click-to-run zip (bundles portable Node + Chromium):
```bash
node scripts/package-win.mjs
# → release/designforge-win.zip  (~332 MB)
```
End-user flow: unzip → double-click `启动.bat` → browser opens → set API Key → use.

## Project layout
- `src/cli.ts` — CLI entry (commands: serve [default], analyze, clone, fuse)
- `src/core/` — extract, report, format, fuse, types
- `src/llm/client.ts` — OpenAI-compatible chat client
- `src/generate/builder.ts` — same-style + fusion Next.js project builders
- `src/server/api.ts` — local HTTP API with SSE progress streaming
- `public-ui/` — the web UI (HTML/CSS/JS)
- `scripts/package-win.mjs` — offline Windows packager
- `launcher/` — `启动.bat` + `使用说明.txt` + `start.command`

## Notes
- LLM-dependent paths (report/clone/fuse) require your API key; extraction works without one.

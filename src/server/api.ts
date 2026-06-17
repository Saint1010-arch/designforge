import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { extractSite } from "../core/extract.js";
import { generateReport } from "../core/report.js";
import { reportToMarkdown } from "../core/format.js";
import { buildSite, buildFusionSite } from "../generate/builder.js";
import { generateFusionReport, blendTokens } from "../core/fuse.js";
import { LlmClient, resolveLlmConfig } from "../llm/client.js";
import { extractHtml } from "../core/extract.js";
import { generateHtmlReport, buildHtmlFromSource, buildHtmlFusion, compareHtml, type HtmlForgeOptions } from "../core/htmlforge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// public dir is shipped next to dist/ -> ../../public from dist/server
const PUBLIC_DIR = path.resolve(__dirname, "..", "..", "public-ui");
const OUT_DIR = path.resolve(process.cwd(), "designforge-out");

// Track one running preview dev-server at a time.
interface PreviewProc { proc: ChildProcess; port: number; dir: string; }
let preview: PreviewProc | null = null;

function npmBin(): string {
  // Use the same Node that runs this server; resolve npm-cli.js next to it.
  const dir = path.dirname(process.execPath);
  const candidates = [
    path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return ""; // fall back to "npm" on PATH
}

function runNpm(args: string[], cwd: string, onLine: (l: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const cli = npmBin();
    const proc = cli
      ? spawn(process.execPath, [cli, ...args], { cwd, env: process.env })
      : spawn("npm", args, { cwd, shell: true, env: process.env });
    proc.stdout?.on("data", (d) => onLine(String(d).trim()));
    proc.stderr?.on("data", (d) => onLine(String(d).trim()));
    proc.on("close", (code) => resolve(code ?? 0));
    proc.on("error", () => resolve(1));
  });
}

function safeProjectDir(dir: string): string {
  const abs = path.resolve(dir);
  if (!abs.startsWith(OUT_DIR)) throw new Error("项目目录不在输出路径内，已拒绝。");
  if (!fs.existsSync(path.join(abs, "package.json"))) throw new Error("该目录不是一个生成的项目。");
  return abs;
}

interface SseRes extends http.ServerResponse {}

function sse(res: SseRes) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  return {
    step: (msg: string) => res.write(`event: step\ndata: ${JSON.stringify({ msg })}\n\n`),
    done: (payload: unknown) => {
      res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    },
    error: (msg: string) => {
      res.write(`event: error\ndata: ${JSON.stringify({ msg })}\n\n`);
      res.end();
    },
  };
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
    });
  });
}

function llmFrom(body: Record<string, unknown>): LlmClient {
  const mt = typeof body.maxTokens === "number" ? (body.maxTokens as number)
    : (body.maxTokens ? parseInt(String(body.maxTokens), 10) : undefined);
  const cfg = resolveLlmConfig({
    apiKey: (body.apiKey as string) || undefined,
    baseURL: (body.baseUrl as string) || undefined,
    model: (body.model as string) || undefined,
    maxTokens: Number.isFinite(mt) ? mt : undefined,
  });
  return new LlmClient(cfg);
}

export function startServer(port: number): Promise<number> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }

    // ---- API: analyze ----
    if (req.method === "POST" && url.pathname === "/api/analyze") {
      const body = await readBody(req);
      const s = sse(res);
      try {
        const llm = llmFrom(body);
        const x = await extractSite(String(body.url), { onStep: s.step });
        s.step("Analyzing design language");
        const report = await generateReport(x, llm);
        saveMd(host(String(body.url)) + "-report", reportToMarkdown(x, report));
        s.done({ extraction: slimExtraction(x), report });
      } catch (e) { s.error(errMsg(e)); }
      return;
    }

    // ---- API: clone ----
    if (req.method === "POST" && url.pathname === "/api/clone") {
      const body = await readBody(req);
      const s = sse(res);
      try {
        const llm = llmFrom(body);
        const x = await extractSite(String(body.url), { onStep: s.step });
        s.step("Analyzing design language");
        const report = await generateReport(x, llm);
        const name = host(String(body.url));
        const projectDir = path.join(OUT_DIR, name + "-clone");
        await buildSite(projectDir, x, report, llm, s.step, body.instructions as string | undefined);
        s.done({ extraction: slimExtraction(x), report, projectDir });
      } catch (e) { s.error(errMsg(e)); }
      return;
    }

    // ---- API: fuse ----
    if (req.method === "POST" && url.pathname === "/api/fuse") {
      const body = await readBody(req);
      const s = sse(res);
      try {
        const llm = llmFrom(body);
        const weightA = clampWeight(body.weight);
        const a = await extractSite(String(body.urlA), { onStep: (m) => s.step("A . " + m) });
        const b = await extractSite(String(body.urlB), { onStep: (m) => s.step("B . " + m) });
        s.step("Fusing design languages");
        const report = await generateFusionReport(a, b, weightA, llm);
        const build = body.build !== false;
        let projectDir: string | undefined;
        if (build) {
          projectDir = path.join(OUT_DIR, host(String(body.urlA)) + "-x-" + host(String(body.urlB)) + "-fusion");
          await buildFusionSite(projectDir, a, b, weightA, report, llm, s.step, body.instructions as string | undefined);
        }
        s.done({ weightA, blend: blendTokens(a, b, weightA), siteA: slimExtraction(a), siteB: slimExtraction(b), report, projectDir });
      } catch (e) { s.error(errMsg(e)); }
      return;
    }

    // ---- API: preview palette blend (no LLM) ----
    if (req.method === "POST" && url.pathname === "/api/extract") {
      const body = await readBody(req);
      const s = sse(res);
      try {
        const x = await extractSite(String(body.url), { onStep: s.step });
        s.done({ extraction: slimExtraction(x) });
      } catch (e) { s.error(errMsg(e)); }
      return;
    }

    // ---- API: list models (uses key to query the provider) ----
    if (req.method === "POST" && url.pathname === "/api/models") {
      const body = await readBody(req);
      try {
        const models = await listModels(body);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ models }));
      } catch (e) {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: errMsg(e) }));
      }
      return;
    }

    // ---- HTML: analyze (link or uploaded html) ----
    if (req.method === "POST" && url.pathname === "/api/html-analyze") {
      const body = await readBody(req);
      const s = sse(res);
      try {
        const llm = llmFrom(body);
        const x = await loadHtmlSource(body, s.step);
        s.step("Analyzing HTML design language");
        const report = await generateHtmlReport(x, llm, htmlOpts(body));
        s.done({ extraction: slimExtraction(x), report });
      } catch (e) { s.error(errMsg(e)); }
      return;
    }

    // ---- HTML: clone/upgrade -> single-file html ----
    if (req.method === "POST" && url.pathname === "/api/html-clone") {
      const body = await readBody(req);
      const s = sse(res);
      try {
        const llm = llmFrom(body);
        const opts = htmlOpts(body);
        const x = await loadHtmlSource(body, s.step);
        s.step("Analyzing HTML design language");
        const report = await generateHtmlReport(x, llm, opts);
        s.step("Composing an upgraded single-file HTML");
        const html = await buildHtmlFromSource(x, report, llm, opts);
        const file = saveHtml(host(x.finalUrl || "page") + "-htmlforge", html);
        s.done({ extraction: slimExtraction(x), report, html, file });
      } catch (e) { s.error(errMsg(e)); }
      return;
    }

    // ---- HTML: compose from raw content (no source) ----
    if (req.method === "POST" && url.pathname === "/api/html-compose") {
      const body = await readBody(req);
      const s = sse(res);
      try {
        const llm = llmFrom(body);
        const opts = htmlOpts(body);
        s.step("Composing a single-file HTML from your content");
        // synthesize a minimal source from defaults so we can reuse the builder
        const fake = blankExtraction((body.title as string) || "Document");
        const report = { summary: "", vibe: [], colorAnalysis: "", typographyAnalysis: "", layoutAnalysis: "", structureAnalysis: "", recommendations: [], upgradeIdeas: [], sameStylePrompt: "" };
        const html = await buildHtmlFromSource(fake, report as any, llm, opts);
        const file = saveHtml("compose-htmlforge", html);
        s.done({ html, file });
      } catch (e) { s.error(errMsg(e)); }
      return;
    }

    // ---- HTML: multi-source compare (no build) ----
    if (req.method === "POST" && url.pathname === "/api/html-compare") {
      const body = await readBody(req);
      const s = sse(res);
      try {
        const llm = llmFrom(body);
        const xs = await loadHtmlSources(body, s.step);
        s.step("Comparing " + xs.length + " documents");
        const report = await compareHtml(xs, llm, htmlOpts(body));
        s.done({ extractions: xs.map(slimExtraction), report });
      } catch (e) { s.error(errMsg(e)); }
      return;
    }

    // ---- HTML: multi-source fusion -> single-file html ----
    if (req.method === "POST" && url.pathname === "/api/html-fuse") {
      const body = await readBody(req);
      const s = sse(res);
      try {
        const llm = llmFrom(body);
        const opts = htmlOpts(body);
        const items = Array.isArray(body.sources) ? body.sources as any[] : [];
        const xs: { x: any; weight: number }[] = [];
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          s.step("Loading source " + (i + 1) + "/" + items.length);
          const x = await loadOneHtml(it, s.step);
          xs.push({ x, weight: Number(it.weight) || 1 });
        }
        s.step("Fusing " + xs.length + " documents into one HTML");
        const out = await buildHtmlFusion(xs, llm, opts);
        const file = saveHtml("fusion-htmlforge", out.html);
        s.done({ extractions: xs.map((z) => slimExtraction(z.x)), html: out.html, plan: out.plan, file });
      } catch (e) { s.error(errMsg(e)); }
      return;
    }
    // ---- API: preview a generated project (npm install + next dev), opens a port ----
    if (req.method === "POST" && url.pathname === "/api/preview") {
      const body = await readBody(req);
      const s = sse(res);
      try {
        const dir = safeProjectDir(String(body.projectDir));
        // stop any prior preview
        if (preview) { try { preview.proc.kill(); } catch { /* ignore */ } preview = null; }
        if (!fs.existsSync(path.join(dir, "node_modules"))) {
          s.step("\u9996\u6b21\u9884\u89c8\uff1a\u6b63\u5728\u5b89\u88c5\u4f9d\u8d56 (npm install)\uff0c\u8bf7\u7a0d\u5019\u2026");
          const code = await runNpm(["install", "--no-audit", "--no-fund"], dir, (l) => { if (l) s.step(l.slice(0, 100)); });
          if (code !== 0) { s.error("npm install \u5931\u8d25\uff0c\u8bf7\u786e\u8ba4\u7f51\u7edc\u53ef\u7528\u3002"); return; }
        }
        const devPort = 3000 + Math.floor(Math.random() * 400);
        s.step("\u542f\u52a8\u5f00\u53d1\u670d\u52a1\u5668 (next dev) \u2026");
        const cli = npmBin();
        const proc = cli
          ? spawn(process.execPath, [cli, "run", "dev", "--", "-p", String(devPort)], { cwd: dir, env: process.env })
          : spawn("npm", ["run", "dev", "--", "-p", String(devPort)], { cwd: dir, shell: true, env: process.env });
        preview = { proc, port: devPort, dir };
        let ready = false;
        const onData = (d: Buffer | string) => {
          const line = String(d);
          if (!ready && /(Local:|ready|started server|compiled)/i.test(line)) {
            ready = true;
            s.done({ url: "http://localhost:" + devPort, port: devPort });
          }
        };
        proc.stdout?.on("data", onData);
        proc.stderr?.on("data", onData);
        proc.on("error", () => { if (!ready) s.error("\u542f\u52a8\u5931\u8d25\u3002"); });
        // safety: if it never reports ready, resolve after a delay assuming it booted
        setTimeout(() => { if (!ready) { ready = true; s.done({ url: "http://localhost:" + devPort, port: devPort }); } }, 20000);
      } catch (e) { s.error(errMsg(e)); }
      return;
    }

    // ---- API: stop the running preview ----
    if (req.method === "POST" && url.pathname === "/api/preview-stop") {
      if (preview) { try { preview.proc.kill(); } catch { /* ignore */ } preview = null; }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ stopped: true }));
      return;
    }

    // ---- API: export a generated project to a single double-clickable HTML ----
    if (req.method === "POST" && url.pathname === "/api/export-html") {
      const body = await readBody(req);
      const s = sse(res);
      try {
        const dir = safeProjectDir(String(body.projectDir));
        s.step("\u5bfc\u51fa\u9759\u6001 HTML\uff08\u53ef\u53cc\u51fb\u6253\u5f00\uff09\u2026");
        const file = await exportProjectToHtml(dir, s.step);
        s.done({ file });
      } catch (e) { s.error(errMsg(e)); }
      return;
    }

    // ---- static UI ----
    serveStatic(url.pathname, res);
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve(port));
  });
}

/** Render a generated project's page into one self-contained, double-clickable HTML file. */
async function exportProjectToHtml(dir: string, step: (m: string) => void): Promise<string> {
  const pageTsxPath = path.join(dir, "src", "app", "page.tsx");
  const cssPath = path.join(dir, "src", "app", "globals.css");
  const pageTsx = fs.existsSync(pageTsxPath) ? fs.readFileSync(pageTsxPath, "utf8") : "";
  const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : "";
  let code = pageTsx
    .replace(/^\s*['\"]use client['\"];?\s*$/m, "")
    .replace(/^\s*import[^;]*;\s*$/gm, "")
    .replace(/export\s+default\s+function/, "function App_DF")
    .replace(/export\s+default\s+/, "const App_DF = ");
  if (!/function App_DF|const App_DF/.test(code)) code += "\nconst App_DF = () => null;";
  const cssInline = css.replace(/@import[^;]+;/g, "");
  const doc = "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<script src=\"https://cdn.tailwindcss.com\"></script>" +
    "<script src=\"https://unpkg.com/react@18/umd/react.production.min.js\"></script>" +
    "<script src=\"https://unpkg.com/react-dom@18/umd/react-dom.production.min.js\"></script>" +
    "<script src=\"https://unpkg.com/@babel/standalone/babel.min.js\"></script>" +
    "<style>" + cssInline + "</style></head><body><div id=\"root\"></div>" +
    "<script type=\"text/babel\" data-presets=\"react\">" + code + "\n" +
    "ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App_DF));</script>" +
    "</body></html>";
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(doc, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1500);
    // Snapshot the fully-rendered DOM and inline the compiled Tailwind so it works offline-ish.
    const rendered = await page.evaluate(() => {
      const html = document.documentElement.outerHTML;
      return html;
    });
    step("\u6e32\u67d3\u5b8c\u6210\uff0c\u5199\u5165\u6587\u4ef6");
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, path.basename(dir) + "-export-" + Date.now() + ".html");
    // keep the Tailwind CDN so utility classes still apply when opened directly
    const finalDoc = rendered.includes("cdn.tailwindcss.com")
      ? "<!doctype html>\n" + rendered
      : "<!doctype html>\n<html><head><meta charset=\"utf-8\"><script src=\"https://cdn.tailwindcss.com\"></script><style>" + cssInline + "</style></head>" + rendered.replace(/^[\s\S]*?<body/i, "<body");
    fs.writeFileSync(out, finalDoc, "utf8");
    return out;
  } finally {
    if (browser) await browser.close();
  }
}

function serveStatic(pathname: string, res: http.ServerResponse) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, decodeURIComponent(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end("forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": mime(filePath) });
    res.end(data);
  });
}

function mime(f: string): string {
  if (f.endsWith(".html")) return "text/html; charset=utf-8";
  if (f.endsWith(".css")) return "text/css; charset=utf-8";
  if (f.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (f.endsWith(".svg")) return "image/svg+xml";
  if (f.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function slimExtraction(x: { finalUrl: string; title: string; lang: string; tokens: unknown; sections: unknown; videoCount: number; assets: unknown[] }) {
  return {
    finalUrl: x.finalUrl, title: x.title, lang: x.lang,
    tokens: x.tokens, sections: x.sections, videoCount: x.videoCount,
    assetCount: x.assets.length,
  };
}

function saveMd(name: string, md: string) {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(path.join(OUT_DIR, name + ".md"), md, "utf8"); } catch { /* ignore */ }
}
function host(url: string) { try { return new URL(url).hostname.replace(/^www\./, "").replace(/[^a-z0-9.-]/gi, "-"); } catch { return "site"; } }
function clampWeight(w: unknown): number { const n = typeof w === "number" ? w : parseInt(String(w), 10); if (isNaN(n)) return 50; return Math.min(95, Math.max(5, n)); }
function errMsg(e: unknown) { return e instanceof Error ? e.message : String(e); }

async function listModels(body: Record<string, unknown>): Promise<string[]> {
  const apiKey = (body.apiKey as string) || process.env.DESIGNFORGE_API_KEY || process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw new Error("请先填入 API Key 再拉取模型列表。");
  const base = ((body.baseUrl as string) || process.env.DESIGNFORGE_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const resp = await fetch(base + "/models", { headers: { Authorization: "Bearer " + apiKey } });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error("拉取失败 (HTTP " + resp.status + ")" + (t ? ": " + t.slice(0, 160) : ""));
  }
  const data: any = await resp.json().catch(() => ({}));
  const list: string[] = Array.isArray(data?.data)
    ? data.data.map((m: any) => String(m?.id || m?.name || "")).filter(Boolean)
    : Array.isArray(data?.models)
      ? data.models.map((m: any) => String(m?.id || m?.name || m || "")).filter(Boolean)
      : [];
  list.sort((a, b) => a.localeCompare(b));
  return list;
}

// ---- HTML source loading + options ----
function htmlOpts(body: Record<string, unknown>): HtmlForgeOptions {
  return {
    instructions: (body.instructions as string) || undefined,
    language: (body.language as string) || undefined,
    purpose: (body.purpose as string) || undefined,
    tone: (body.tone as string) || undefined,
    colorMode: (body.colorMode as string) || undefined,
    density: (body.density as string) || undefined,
    animation: (body.animation as string) || undefined,
    upgrade: body.upgrade === undefined ? true : !!body.upgrade,
    sections: (body.sections as string) || undefined,
    content: (body.content as string) || undefined,
    fontHint: (body.fontHint as string) || undefined,
    creativity: typeof body.creativity === "number" ? (body.creativity as number) : undefined,
  };
}

async function fetchHtml(u: string): Promise<string> {
  const resp = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 designforge" } });
  if (!resp.ok) throw new Error("\u62c9\u53d6\u9875\u9762\u5931\u8d25 (HTTP " + resp.status + ")");
  return await resp.text();
}

async function loadOneHtml(it: Record<string, unknown>, step: (m: string) => void) {
  const html = (it.html as string) || "";
  const url = (it.url as string) || "";
  if (html && html.trim()) {
    return extractHtml(html, { onStep: step, label: (it.name as string) || "uploaded.html" });
  }
  if (url && url.trim()) {
    step("Fetching " + url);
    const fetched = await fetchHtml(url);
    return extractHtml(fetched, { onStep: step, baseUrl: url, label: url });
  }
  throw new Error("\u6bcf\u4e2a\u6765\u6e90\u9700\u8981\u63d0\u4f9b\u94fe\u63a5\u6216 HTML \u5185\u5bb9\u3002");
}

async function loadHtmlSource(body: Record<string, unknown>, step: (m: string) => void) {
  return loadOneHtml(body, step);
}

async function loadHtmlSources(body: Record<string, unknown>, step: (m: string) => void) {
  const items = Array.isArray(body.sources) ? (body.sources as Record<string, unknown>[]) : [];
  if (!items.length) throw new Error("\u8bf7\u63d0\u4f9b\u81f3\u5c11\u4e00\u4e2a\u6765\u6e90\u3002");
  const out = [];
  for (let i = 0; i < items.length; i++) {
    step("Loading source " + (i + 1) + "/" + items.length);
    out.push(await loadOneHtml(items[i], step));
  }
  return out;
}

function saveHtml(name: string, html: string): string {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const p = path.join(OUT_DIR, name + "-" + Date.now() + ".html");
    fs.writeFileSync(p, html, "utf8");
    return p;
  } catch { return ""; }
}

function blankExtraction(title: string): any {
  return {
    url: title, finalUrl: title, title, description: "", lang: "zh",
    viewport: { width: 1440, height: 900 }, pageHeight: 0,
    tokens: { bodyBackground: "", bodyColor: "", palette: [], fontFamilies: [], googleFonts: [], fontFaces: [], headingSizes: [], radii: [], shadows: [] },
    sections: [], assets: [], smoothScroll: { lenis: false, locomotive: false, scrollSnap: false },
    videoCount: 0, navLinks: [], extractedAt: new Date().toISOString(),
  };
}

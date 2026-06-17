import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import type { ExtractionResult, DesignReport } from "../core/types.js";
import type { FusionReport } from "../core/fuse.js";
import { blendTokens } from "../core/fuse.js";
import { LlmClient } from "../llm/client.js";
import { chromium } from "playwright";

const SYSTEM = `You are an expert front-end engineer. You generate a single-file React
homepage (default export) that recreates the VISUAL STYLE of a reference site as an
ORIGINAL same-style page. You output ONLY JSON. The component must be self-contained,
use inline Tailwind utility classes, and import NOTHING except React (the only allowed\nimport is React). NEVER import icon/animation/UI libraries such as lucide-react, react-icons,\n@heroicons, framer-motion, swiper, clsx, etc. For icons, write inline <svg> elements or use emoji.\nFor animation use CSS/Tailwind only. Use the
provided design tokens (colors, fonts, radii) faithfully. Recreate the section rhythm
from the topology. Use placeholder text in the same language/topic, and reference local
asset paths under /assets/ for any images you include. Keep it production-clean.`;

interface GenResult {
  pageTsx: string;
  globalsCss: string;
}

export async function buildSite(
  outDir: string,
  x: ExtractionResult,
  r: DesignReport,
  llm: LlmClient,
  onStep: (m: string) => void,
  instructions?: string,
  refineRounds = 2
): Promise<void> {
  // Download reference assets FIRST so the model can reference real local files.
  onStep("Downloading reference assets");
  const localAssets = await downloadAssets(outDir, x, onStep);

  const slim = {
    title: x.title,
    lang: x.lang,
    tokens: {
      bg: x.tokens.bodyBackground,
      fg: x.tokens.bodyColor,
      palette: x.tokens.palette.slice(0, 12),
      fonts: x.tokens.fontFamilies.slice(0, 4),
      googleFonts: x.tokens.googleFonts,
      radii: x.tokens.radii,
      shadows: x.tokens.shadows.slice(0, 3),
      headingSizes: x.tokens.headingSizes,
    },
    sections: x.sections.map((sec) => ({
      name: sec.name,
      layout: sec.layout,
      display: sec.display,
      gridTemplateColumns: sec.gridTemplateColumns,
      flexDirection: sec.flexDirection,
      columns: sec.columnCount,
      gap: sec.gap,
      padding: sec.paddingPx,
      background: sec.background,
      images: sec.imageCount,
      interaction: sec.interaction,
      states: sec.states,
      heightPx: sec.height,
      text: sec.textPreview,
    })),
    smoothScroll: x.smoothScroll,
    vibe: r.vibe,
  };

  const assetList = localAssets.length
    ? localAssets.map((a) => `/assets/${a.local}  (${a.kind})`).join("\n")
    : "(none downloaded — use tasteful CSS gradients/placeholders instead)";

  const extra = instructions && instructions.trim()
    ? `\n\nUSER CUSTOMIZATION (apply, but keep the visual style): ${instructions.trim()}`
    : "\n\nUse fresh original placeholder copy in the same language/topic; do NOT copy the original brand names or exact wording.";

  onStep("Composing the same-style page (driven by the design prompt)");
  const user = `PRIMARY DIRECTIVE — build this page to match this design brief exactly:
"""
${r.sameStylePrompt || r.summary}
"""

PRECISE EXTRACTED LAYOUT & TOKENS (honor section order, column counts, gaps, padding, colors, fonts):
${JSON.stringify(slim, null, 2)}

LOCAL ASSETS available under /assets/ (use these real images where the section has imagery):
${assetList}
${extra}

Return JSON:
{
  \"pageTsx\": \"full source of src/app/page.tsx (default-exported React component, 'use client' at top, inline Tailwind classes, recreating EVERY section in order with the exact column counts/spacing/colors; use <img src=\\\"/assets/...\\\"> for imagery)\",
  \"globalsCss\": \"src/app/globals.css starting with @import \\\"tailwindcss\\\"; plus :root variables for the extracted colors and any keyframes\"
}`;

  const gen = await llm.json<GenResult>(SYSTEM, user);

  onStep("Scaffolding Next.js project");
  scaffold(outDir, x, gen);

  // Screenshot-based self-iteration: render our page, compare to the original, fix.
  if (refineRounds > 0 && x.screenshots && x.screenshots.desktop) {
    await refineWithScreenshots(outDir, x, gen, llm, onStep, refineRounds);
  }
}

const KNOWN_VERSIONS: Record<string, string> = {
  "lucide-react": "^0.469.0",
  "framer-motion": "^11.15.0",
  "react-icons": "^5.4.0",
  "clsx": "^2.1.1",
  "@heroicons/react": "^2.2.0",
  "swiper": "^11.1.15",
};

/** Find third-party package imports in the generated page (excluding react / next / relative paths). */
function detectExternalDeps(code: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /import[^;]*?from\s*['\"]([^'\"]+)['\"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/")) continue;
    if (spec === "react" || spec === "react-dom" || spec.startsWith("next")) continue;
    // package name: handle scoped (@scope/name) and subpaths (pkg/sub)
    const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (pkg) out[pkg] = KNOWN_VERSIONS[pkg] || "latest";
  }
  return out;
}

function scaffold(outDir: string, x: ExtractionResult, gen: GenResult) {
  const w = (rel: string, content: string) => {
    const p = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, { encoding: "utf8" });
  };

  w("package.json", JSON.stringify({
    name: "designforge-output",
    version: "0.1.0",
    private: true,
    scripts: { dev: "next dev", build: "next build", start: "next start" },
    dependencies: { next: "^15.1.6", react: "^19.0.0", "react-dom": "^19.0.0", ...detectExternalDeps(gen.pageTsx) },
    devDependencies: {
      typescript: "^5.7.3",
      "@types/node": "^22.10.7",
      "@types/react": "^19.0.7",
      "@types/react-dom": "^19.0.3",
      tailwindcss: "^4.0.0",
      "@tailwindcss/postcss": "^4.0.0",
      postcss: "^8.5.1",
    },
  }, null, 2));

  w("tsconfig.json", JSON.stringify({
    compilerOptions: {
      target: "ES2017", lib: ["dom", "dom.iterable", "esnext"], allowJs: true,
      skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true,
      module: "esnext", moduleResolution: "bundler", resolveJsonModule: true,
      isolatedModules: true, jsx: "preserve", incremental: true,
      plugins: [{ name: "next" }], baseUrl: ".", paths: { "@/*": ["./src/*"] },
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  }, null, 2));

  w("postcss.config.mjs", "const config = { plugins: [\"@tailwindcss/postcss\"] };\nexport default config;\n");
  w("next.config.ts", "import type { NextConfig } from \"next\";\nimport path from \"path\";\nconst nextConfig: NextConfig = { reactStrictMode: true, outputFileTracingRoot: path.resolve(__dirname) };\nexport default nextConfig;\n");
  w("next-env.d.ts", "/// <reference types=\"next\" />\n/// <reference types=\"next/image-types/global\" />\n");
  w(".gitignore", "node_modules\n.next\nout\n");

  const layout = `import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: ${JSON.stringify(x.title || "Same-style site")}, description: "Generated by designforge" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang=${JSON.stringify(x.lang || "en")}><body>{children}</body></html>);
}
`;
  w("src/app/layout.tsx", layout);
  w("src/app/page.tsx", gen.pageTsx);
  w("src/app/globals.css", gen.globalsCss);

  // build report alongside
  w("DESIGNFORGE.md", "# Generated by designforge\n\nStyle reference: " + x.finalUrl + "\n\nRun: npm install && npm run dev\n");
}

async function downloadAssets(
  outDir: string,
  x: ExtractionResult,
  onStep: (m: string) => void
): Promise<{ remote: string; local: string; kind: string }[]> {
  const dir = path.join(outDir, "public", "assets");
  fs.mkdirSync(dir, { recursive: true });
  const imgs = x.assets
    .filter((a) => a.kind === "image" || a.kind === "background" || a.kind === "logo")
    .slice(0, 24);
  const out: { remote: string; local: string; kind: string }[] = [];
  const used = new Set<string>();
  let ok = 0;
  for (const a of imgs) {
    try {
      let name = (a.src.split("?")[0].split("/").pop() || "asset").replace(/[^a-z0-9._-]/gi, "_");
      if (!/.[a-z0-9]{2,5}$/i.test(name)) name += ".img";
      while (used.has(name)) name = "_" + name;
      used.add(name);
      await download(a.src, path.join(dir, name), x.finalUrl);
      out.push({ remote: a.src, local: name, kind: a.kind });
      ok++;
    } catch {
      /* skip unreachable assets */
    }
  }
  onStep(`Downloaded ${ok}/${imgs.length} reference assets`);
  return out;
}

function download(url: string, dest: string, referer: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(
      url,
      { headers: { Referer: referer, "User-Agent": "Mozilla/5.0" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          return reject(new Error("HTTP " + res.statusCode));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
      }
    );
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("timeout")));
  });
}


const REFINE_SYSTEM = `You are a meticulous front-end engineer doing visual QA.
You are shown TWO screenshots: (1) the ORIGINAL reference site, (2) the CURRENT generated page.
Identify concrete visual differences (layout, spacing, colors, type scale, section order, missing blocks)
and return a corrected, COMPLETE page. Keep it a single default-exported React component with inline
Tailwind classes. Do not regress anything that already matches. Output ONLY JSON.`;

/** Render a generated React component to a screenshot via Babel + Tailwind CDN (no npm install). */
async function renderPreviewToScreenshot(pageTsx: string, globalsCss: string): Promise<string> {
  // Strip TS/Next-isms that break in-browser Babel; keep it best-effort.
  let code = pageTsx
    .replace(/^\s*['\"]use client['\"];?\s*$/m, "")
    .replace(/^\s*import[^;]*;\s*$/gm, "")
    .replace(/export\s+default\s+function/, "function App_DF")
    .replace(/export\s+default\s+/, "const App_DF = ");
  if (!/function App_DF|const App_DF/.test(code)) code += "\nconst App_DF = () => null;";
  const cssInline = (globalsCss || "").replace(/@import[^;]+;/g, "");
  const doc = `<!doctype html><html><head><meta charset=\"utf-8\">` +
    `<script src=\"https://cdn.tailwindcss.com\"></script>` +
    `<script src=\"https://unpkg.com/react@18/umd/react.production.min.js\"></script>` +
    `<script src=\"https://unpkg.com/react-dom@18/umd/react-dom.production.min.js\"></script>` +
    `<script src=\"https://unpkg.com/@babel/standalone/babel.min.js\"></script>` +
    `<style>${cssInline}</style></head><body><div id=\"root\"></div>` +
    `<script type=\"text/babel\" data-presets=\"react\">${code}\n` +
    `ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App_DF));</script>` +
    `</body></html>`;
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(doc, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1500);
    const buf = await page.screenshot({ fullPage: true, type: "jpeg", quality: 60 });
    return "data:image/jpeg;base64," + buf.toString("base64");
  } finally {
    if (browser) await browser.close();
  }
}

/** Compare our render to the original screenshot and let the model fix the page, N rounds. */
async function refineWithScreenshots(
  outDir: string,
  x: ExtractionResult,
  gen: GenResult,
  llm: LlmClient,
  onStep: (m: string) => void,
  rounds: number
): Promise<void> {
  const original = x.screenshots?.desktop;
  if (!original) return;
  let current = gen;
  for (let i = 1; i <= rounds; i++) {
    let mine = "";
    try {
      onStep(`Self-check round ${i}/${rounds}: rendering preview`);
      mine = await renderPreviewToScreenshot(current.pageTsx, current.globalsCss);
    } catch {
      onStep(`Self-check round ${i}: preview render skipped`);
      return; // can't render -> stop refining quietly
    }
    try {
      onStep(`Self-check round ${i}/${rounds}: comparing with original & fixing`);
      const user = `Image 1 = ORIGINAL reference. Image 2 = CURRENT generated page.\n` +
        `Fix the CURRENT page so it matches the ORIGINAL more closely (layout, spacing, colors, section order).\n` +
        `Return JSON { \"pageTsx\": \"...\", \"globalsCss\": \"...\" } with the FULL corrected files.`;
      const fixed = await llm.jsonWithImages<GenResult>(REFINE_SYSTEM, user, [original, mine]);
      if (fixed && fixed.pageTsx && fixed.pageTsx.length > 200) {
        current = fixed;
        scaffold(outDir, x, current);
      }
    } catch (e) {
      onStep(`Self-check round ${i}: skipped (${e instanceof Error ? e.message.slice(0, 60) : "error"})`);
      return;
    }
  }
  onStep("Self-iteration complete");
}

export async function buildFusionSite(
  outDir: string,
  a: ExtractionResult,
  bSite: ExtractionResult,
  weightA: number,
  report: FusionReport,
  llm: LlmClient,
  onStep: (m: string) => void,
  instructions?: string
): Promise<void> {
  onStep("Composing a fused same-style page");
  const blend = blendTokens(a, bSite, weightA);
  const slim = {
    weight: { siteA: Math.round(weightA), siteB: 100 - Math.round(weightA) },
    siteA: { title: a.title, bg: a.tokens.bodyBackground, palette: a.tokens.palette.slice(0, 6), fonts: a.tokens.fontFamilies.slice(0, 2), sections: a.sections.map((s) => s.name).slice(0, 8) },
    siteB: { title: bSite.title, bg: bSite.tokens.bodyBackground, palette: bSite.tokens.palette.slice(0, 6), fonts: bSite.tokens.fontFamilies.slice(0, 2), sections: bSite.sections.map((s) => s.name).slice(0, 8) },
    blendedTokens: blend,
    fusionPlan: { vibe: report.vibe, colorPlan: report.colorPlan, typographyPlan: report.typographyPlan, layoutPlan: report.layoutPlan },
  };
  const extra = instructions && instructions.trim()
    ? `\n\nUSER CUSTOMIZATION:\n${instructions.trim()}`
    : "\n\nUse fresh original placeholder copy; do not copy either site's exact wording or brand.";
  const user = `PRIMARY DIRECTIVE — build this fused page to match this design brief exactly:
"""
${report.sameStylePrompt || report.summary}
"""

BLEND DATA (honor the weight; use blendedTokens for color/fonts; merge both sites' section rhythm):
${JSON.stringify(slim, null, 2)}${extra}

Return JSON:
{
  "pageTsx": "full src/app/page.tsx (default-exported React component, 'use client', inline Tailwind classes, fused sections + style)",
  "globalsCss": "src/app/globals.css starting with @import \"tailwindcss\"; plus :root variables for the blended colors and any keyframes"
}`;
  const gen = await llm.json<{ pageTsx: string; globalsCss: string }>(SYSTEM, user);

  onStep("Scaffolding Next.js project");
  const merged: ExtractionResult = {
    ...a,
    title: a.title + " x " + bSite.title,
    assets: [...a.assets, ...bSite.assets],
  };
  scaffold(outDir, merged, gen);

  onStep("Downloading reference assets");
  await downloadAssets(outDir, merged, onStep);

  // Self-iteration against site A's screenshot as the primary visual anchor.
  if (a.screenshots && a.screenshots.desktop) {
    await refineWithScreenshots(outDir, merged, gen, llm, onStep, 1);
  }
}

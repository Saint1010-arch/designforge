import type { ExtractionResult } from "./types.js";
import { LlmClient } from "../llm/client.js";

export interface HtmlForgeOptions {
  instructions?: string;
  language?: string;
  purpose?: string;
  tone?: string;
  colorMode?: string;
  density?: string;
  animation?: string;
  upgrade?: boolean;
  sections?: string;
  content?: string;
  fontHint?: string;
  creativity?: number;
}

export interface HtmlReport {
  summary: string;
  vibe: string[];
  colorAnalysis: string;
  typographyAnalysis: string;
  layoutAnalysis: string;
  structureAnalysis: string;
  recommendations: string[];
  upgradeIdeas: string[];
  sameStylePrompt: string;
}

function slimForReport(x: ExtractionResult) {
  return {
    source: x.finalUrl || x.title,
    title: x.title,
    lang: x.lang,
    bodyBackground: x.tokens.bodyBackground,
    bodyColor: x.tokens.bodyColor,
    palette: x.tokens.palette,
    fontFamilies: x.tokens.fontFamilies,
    googleFonts: x.tokens.googleFonts,
    headingSizes: x.tokens.headingSizes,
    radii: x.tokens.radii,
    shadows: x.tokens.shadows.slice(0, 3),
    sections: x.sections.map((s) => ({ name: s.name, layout: s.layout, interaction: s.interaction, text: s.textPreview })),
  };
}

const REPORT_SYSTEM = `You are a senior product/brand designer reviewing an HTML document/page.
Analyze its DESIGN LANGUAGE and STRUCTURE from extracted tokens. Be concrete (cite hex/rgb,
px, font names). Return STRICT JSON only.

BILINGUAL OUTPUT: For every human-readable text value, write CHINESE FIRST, then a newline,
then ENGLISH. Format each as "<中文>\n<English>". vibe stays short English adjectives.`;

export async function generateHtmlReport(x: ExtractionResult, llm: LlmClient, opts: HtmlForgeOptions = {}): Promise<HtmlReport> {
  const extra = opts.instructions && opts.instructions.trim() ? "\n\nUSER EXTRA REQUIREMENTS:\n" + opts.instructions.trim() : "";
  const user = `Analyze this HTML document's design language and structure.

EXTRACTED DATA:
OXJSONO`.replace("OXJSONO", JSON.stringify(slimForReport(x), null, 2)) + extra + `

Return JSON with EXACTLY these keys:
{
  "summary": "2-3 sentence overview of the design identity",
  "vibe": ["3-6 adjective tags"],
  "colorAnalysis": "background/text/accents/contrast (cite values)",
  "typographyAnalysis": "fonts, hierarchy, sizes (cite values)",
  "layoutAnalysis": "grid/flex, rhythm, spacing, density",
  "structureAnalysis": "document sections and information architecture",
  "recommendations": ["3-5 reusable design takeaways"],
  "upgradeIdeas": ["3-5 concrete ways to make a NEXT-LEVEL version that is clearly better and different (not a copy)"],
  "sameStylePrompt": "a single ready-to-paste prompt to BUILD a NEW ORIGINAL single-file HTML in this style, an upgrade not a 1:1 copy"
}

Reminder: every text value must be bilingual "中文\n English" (use \n inside JSON strings). Keep JSON valid.`;
  return llm.json<HtmlReport>(REPORT_SYSTEM, user);
}

const GEN_SYSTEM = `You are an elite front-end designer-engineer. You output ONE complete, self-contained
single-file HTML document (doctype + <html> + <head> with <style> + <body>). All CSS inline in <style>.
It must look stunning, modern, production-clean, and render by double-clicking the file. You may use a CDN
link only if essential. You output ONLY JSON.`;

function knobLines(opts: HtmlForgeOptions): string {
  const L: string[] = [];
  if (opts.purpose) L.push("Purpose/type: " + opts.purpose);
  if (opts.tone) L.push("Tone: " + opts.tone);
  if (opts.language) L.push("Language: " + opts.language);
  if (opts.colorMode) L.push("Color direction: " + opts.colorMode);
  if (opts.density) L.push("Density: " + opts.density);
  if (opts.animation) L.push("Animation level: " + opts.animation);
  if (opts.fontHint) L.push("Font preference: " + opts.fontHint);
  if (opts.sections) L.push("Required sections: " + opts.sections);
  if (opts.upgrade) L.push("UPGRADE MODE: make it clearly stronger and visibly different from the source. Do NOT copy 1:1.");
  if (opts.content && opts.content.trim()) L.push("LAY OUT THIS CONTENT beautifully:\n" + opts.content.trim());
  if (opts.instructions && opts.instructions.trim()) L.push("EXTRA USER REQUIREMENTS:\n" + opts.instructions.trim());
  return L.length ? "\n\nSETTINGS:\n- " + L.join("\n- ") : "";
}

export async function buildHtmlFromSource(x: ExtractionResult, report: HtmlReport, llm: LlmClient, opts: HtmlForgeOptions = {}): Promise<string> {
  const slim = {
    title: x.title, lang: x.lang,
    tokens: { bg: x.tokens.bodyBackground, fg: x.tokens.bodyColor, palette: x.tokens.palette.slice(0, 10), fonts: x.tokens.fontFamilies.slice(0, 4), googleFonts: x.tokens.googleFonts, radii: x.tokens.radii, headingSizes: x.tokens.headingSizes },
    sections: x.sections.map((s) => ({ name: s.name, layout: s.layout })).slice(0, 16),
    designPlan: { vibe: report.vibe, color: report.colorAnalysis, type: report.typographyAnalysis, layout: report.layoutAnalysis, upgrades: report.upgradeIdeas },
  };
  const user = "Create ONE original, beautiful single-file HTML document in the SAME visual style as the source." + knobLines(opts) + "\n\nSOURCE DESIGN DATA:\n" + JSON.stringify(slim, null, 2) + "\n\nReturn JSON: { \"html\": \"the FULL single-file HTML document as a string\" }\nThe HTML must be complete (doctype to </html>), all CSS in a <style> tag, responsive, and visually polished.";
  const out = await llm.json<{ html: string }>(GEN_SYSTEM, user);
  return out.html;
}

export async function buildHtmlFusion(sources: { x: ExtractionResult; weight: number }[], llm: LlmClient, opts: HtmlForgeOptions = {}): Promise<{ html: string; plan: string }> {
  const total = sources.reduce((a, s) => a + (s.weight || 1), 0) || 1;
  const slim = sources.map((s, i) => ({ index: i + 1, weightPct: Math.round((100 * (s.weight || 1)) / total), title: s.x.title, bg: s.x.tokens.bodyBackground, fg: s.x.tokens.bodyColor, palette: s.x.tokens.palette.slice(0, 6), fonts: s.x.tokens.fontFamilies.slice(0, 3), sections: s.x.sections.map((z) => z.name).slice(0, 10) }));
  const user = "Fuse the " + sources.length + " HTML sources below into ONE original single-file HTML, honoring each source weight. Blend palettes, type, layout into a coherent NEW design." + knobLines(opts) + "\n\nSOURCES:\n" + JSON.stringify(slim, null, 2) + "\n\nReturn JSON:\n{ \"plan\": \"a short bilingual note describing what you took from each source\", \"html\": \"the FULL single-file HTML document\" }\nThe HTML must be complete, all CSS inline, responsive, visually polished.";
  const out = await llm.json<{ html: string; plan: string }>(GEN_SYSTEM, user);
  return { html: out.html, plan: out.plan };
}

export interface HtmlCompareReport {
  summary: string;
  perSource: { title: string; strengths: string; weaknesses: string }[];
  contrasts: string;
  fusionAdvice: string;
  sameStylePrompt: string;
}
export async function compareHtml(sources: ExtractionResult[], llm: LlmClient, opts: HtmlForgeOptions = {}): Promise<HtmlCompareReport> {
  const slim = sources.map((x, i) => ({ index: i + 1, title: x.title, bg: x.tokens.bodyBackground, fg: x.tokens.bodyColor, palette: x.tokens.palette.slice(0, 6), fonts: x.tokens.fontFamilies.slice(0, 3), sections: x.sections.map((s) => s.name).slice(0, 10) }));
  const extra = opts.instructions && opts.instructions.trim() ? "\n\nUSER EXTRA REQUIREMENTS:\n" + opts.instructions.trim() : "";
  const user = "Compare and analyze these " + sources.length + " HTML documents design languages.\n" + JSON.stringify(slim, null, 2) + extra + "\n\nReturn JSON with EXACTLY these keys:\n{ \"summary\": \"2-3 sentence overview\", \"perSource\": [{ \"title\": \"...\", \"strengths\": \"...\", \"weaknesses\": \"...\" }], \"contrasts\": \"key differences\", \"fusionAdvice\": \"how to fuse + suggested weight split\", \"sameStylePrompt\": \"a prompt to build a fused single-file HTML\" }\nBILINGUAL: every text value bilingual (use \n in JSON strings). Keep JSON valid.";
  return llm.json<HtmlCompareReport>(GEN_SYSTEM, user);
}

import type { ExtractionResult, DesignReport } from "./types.js";
import { LlmClient } from "../llm/client.js";

const SYSTEM = `You are a senior product/brand designer and front-end architect.
You receive structured data extracted from a live website (computed design tokens,
color palette, fonts, section topology, assets). Analyze its DESIGN LANGUAGE only.
Return STRICT JSON. Be concrete and reference actual extracted values (hex/rgb,
px sizes, font names). Do not invent assets that are not present.

BILINGUAL OUTPUT: For every human-readable text value (summary, *Analysis, score.notes,
each recommendations item, and sameStylePrompt), write CHINESE FIRST, then a newline, then
the ENGLISH version. Format each such field exactly as: "<中文>\n<English>".
The 'vibe' tags array stays short English adjectives. Keys stay in English.`;

function buildUserPrompt(x: ExtractionResult): string {
  const slim = {
    url: x.finalUrl,
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
    sections: x.sections.map((s) => ({
      name: s.name,
      layout: s.layout,
      interaction: s.interaction,
      text: s.textPreview,
    })),
    videoCount: x.videoCount,
    smoothScroll: x.smoothScroll,
    assetCounts: x.assets.reduce<Record<string, number>>((acc, a) => {
      acc[a.kind] = (acc[a.kind] || 0) + 1;
      return acc;
    }, {}),
  };

  return `Analyze this website's design language from the extracted data below.

EXTRACTED DATA:
${JSON.stringify(slim, null, 2)}

Return JSON with EXACTLY these keys:
{
  "summary": "2-3 sentence overview of the overall design identity",
  "vibe": ["3-6 adjective tags, e.g. 'minimal', 'editorial', 'dark', 'playful'"],
  "colorAnalysis": "how color is used: background, text, accents, contrast, mood (cite values)",
  "typographyAnalysis": "font choices, hierarchy, sizes, pairing (cite values)",
  "layoutAnalysis": "grid/flex usage, section rhythm, spacing, density",
  "motionAnalysis": "scroll behavior, video usage, likely animation patterns",
  "score": { "overall": <number 1-10>, "notes": "one line justification" },
  "recommendations": ["3-5 actionable design takeaways someone could reuse"],
  "sameStylePrompt": "A single ready-to-paste prompt instructing an AI to BUILD A NEW ORIGINAL website in this exact visual style. Include concrete colors, fonts, spacing, layout structure, and motion. Note that it is a style reference, not a 1:1 copy."
}

Reminder: every text value above must be \"中文\\n English\" (Chinese line first, English line second). Keep JSON valid (use \\n inside strings for the line break).`;
}

export async function generateReport(
  x: ExtractionResult,
  llm: LlmClient
): Promise<DesignReport> {
  return llm.json<DesignReport>(SYSTEM, buildUserPrompt(x));
}

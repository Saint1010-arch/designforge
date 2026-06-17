import type { ExtractionResult, DesignReport } from "./types.js";
import { LlmClient } from "../llm/client.js";

export interface FusionReport {
  summary: string;
  vibe: string[];
  blendRationale: string;
  colorPlan: string;
  typographyPlan: string;
  layoutPlan: string;
  recommendations: string[];
  sameStylePrompt: string;
}

const SYSTEM = `You are a senior brand/product designer. You receive design data extracted
from TWO live websites plus a blend weight (how much of each site to favor). Propose a single
coherent ORIGINAL design language that fuses both, respecting the weight. Cite concrete values
(hex/rgb, font names, px) from the inputs. Return STRICT JSON only.`;

function slim(x: ExtractionResult) {
  return {
    url: x.finalUrl,
    title: x.title,
    bg: x.tokens.bodyBackground,
    fg: x.tokens.bodyColor,
    palette: x.tokens.palette.slice(0, 8),
    fonts: x.tokens.fontFamilies.slice(0, 3),
    googleFonts: x.tokens.googleFonts,
    headingSizes: x.tokens.headingSizes,
    radii: x.tokens.radii,
    sections: x.sections.map((s) => ({ name: s.name, layout: s.layout, interaction: s.interaction, text: s.textPreview })),
    videoCount: x.videoCount,
  };
}

export async function generateFusionReport(
  a: ExtractionResult,
  b: ExtractionResult,
  weightA: number,
  llm: LlmClient
): Promise<FusionReport> {
  const wA = Math.round(weightA);
  const wB = 100 - wA;
  const user = `Fuse these two sites into ONE original design language.
Blend weight: Site A = ${wA}%, Site B = ${wB}%.

SITE A:
${JSON.stringify(slim(a), null, 2)}

SITE B:
${JSON.stringify(slim(b), null, 2)}

Return JSON with EXACTLY these keys:
{
  "summary": "2-3 sentences describing the fused identity",
  "vibe": ["3-6 adjective tags"],
  "blendRationale": "what you took from A vs B and why, honoring the ${wA}/${wB} weight",
  "colorPlan": "the fused palette: background, text, accents (cite hex/rgb)",
  "typographyPlan": "fused font choices + hierarchy (cite names/sizes)",
  "layoutPlan": "fused section rhythm and structure",
  "recommendations": ["3-5 concrete takeaways"],
  "sameStylePrompt": "a single ready-to-paste prompt (150-300 words) to BUILD A NEW ORIGINAL site in this fused style, with concrete colors/fonts/spacing/layout/motion. Note it is a style reference, not a copy."
}`;
  return llm.json<FusionReport>(SYSTEM, user);
}

/** Deterministic token blend (no LLM) used by the builder + UI swatches. */
export function blendTokens(
  a: ExtractionResult,
  b: ExtractionResult,
  weightA: number
) {
  const wA = weightA / 100;
  const pickN = (arr: { color: string; count: number }[], n: number) =>
    arr.slice(0, n).map((x) => x.color);
  const fromA = Math.max(1, Math.round(8 * wA));
  const fromB = Math.max(1, 8 - fromA);
  const palette = [
    ...pickN(a.tokens.palette, fromA),
    ...pickN(b.tokens.palette, fromB),
  ];
  return {
    background: wA >= 0.5 ? a.tokens.bodyBackground : b.tokens.bodyBackground,
    foreground: wA >= 0.5 ? a.tokens.bodyColor : b.tokens.bodyColor,
    palette: Array.from(new Set(palette)),
    fonts: Array.from(
      new Set([
        ...a.tokens.fontFamilies.slice(0, wA >= 0.5 ? 2 : 1),
        ...b.tokens.fontFamilies.slice(0, wA >= 0.5 ? 1 : 2),
      ])
    ),
    radii: Array.from(new Set([...a.tokens.radii, ...b.tokens.radii])).slice(0, 4),
  };
}

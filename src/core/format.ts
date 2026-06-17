import type { ExtractionResult, DesignReport } from "./types.js";

export function reportToMarkdown(
  x: ExtractionResult,
  r: DesignReport
): string {
  const lines: string[] = [];
  lines.push(`# Design Report — ${x.title || x.finalUrl}`);
  lines.push("");
  lines.push(`- Source: ${x.finalUrl}`);
  lines.push(`- Language: ${x.lang || "n/a"}`);
  lines.push(`- Extracted: ${x.extractedAt}`);
  lines.push(`- Sections: ${x.sections.length} · Videos: ${x.videoCount} · Assets: ${x.assets.length}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(r.summary);
  lines.push("");
  lines.push("## Vibe");
  lines.push(r.vibe.map((v) => `\`${v}\``).join("  "));
  lines.push("");
  lines.push(`## Aesthetic Score: ${r.score.overall}/10`);
  lines.push(r.score.notes);
  lines.push("");
  lines.push("## Color");
  lines.push(r.colorAnalysis);
  lines.push("");
  lines.push("Palette (most frequent):");
  x.tokens.palette.slice(0, 10).forEach((p) =>
    lines.push(`- ${p.color}  (×${p.count})`)
  );
  lines.push("");
  lines.push("## Typography");
  lines.push(r.typographyAnalysis);
  if (x.tokens.googleFonts.length) {
    lines.push("");
    lines.push("Google Fonts: " + x.tokens.googleFonts.join(", "));
  }
  lines.push("");
  lines.push("## Layout");
  lines.push(r.layoutAnalysis);
  lines.push("");
  lines.push("Section topology:");
  x.sections.forEach((s) =>
    lines.push(`- ${s.name} — ${s.layout}, ${s.interaction} — "${s.textPreview}"`)
  );
  lines.push("");
  lines.push("## Motion");
  lines.push(r.motionAnalysis);
  lines.push("");
  lines.push("## Recommendations");
  r.recommendations.forEach((rec) => lines.push(`- ${rec}`));
  lines.push("");
  lines.push("## Same-Style Prompt (reference only)");
  lines.push("> Paste this into any AI to generate a NEW original site in this style.");
  lines.push("> A standalone prompt cannot perfectly reproduce the site — use `designforge clone` for that.");
  lines.push("");
  lines.push("\`\`\`");
  lines.push(r.sameStylePrompt);
  lines.push("\`\`\`");
  lines.push("");
  return lines.join("\n");
}

export function printReportSummary(
  x: ExtractionResult,
  r: DesignReport,
  c: typeof import("picocolors")
): void {
  console.log("");
  console.log(c.bold(c.cyan("  Design Report — ")) + c.bold(x.title || x.finalUrl));
  console.log(c.dim("  " + x.finalUrl));
  console.log("");
  console.log(c.bold("  Vibe:  ") + r.vibe.map((v) => c.green(v)).join("  "));
  console.log(c.bold("  Score: ") + c.yellow(r.score.overall + "/10") + c.dim("  " + r.score.notes));
  console.log("");
  console.log(c.bold("  Summary"));
  console.log("  " + wrap(r.summary, 76, "  "));
  console.log("");
  console.log(c.bold("  Palette"));
  console.log("  " + x.tokens.palette.slice(0, 6).map((p) => p.color).join("  "));
  console.log("");
}

function wrap(s: string, width: number, indent: string): string {
  const words = s.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      out.push(line.trim());
      line = w;
    } else line += " " + w;
  }
  if (line.trim()) out.push(line.trim());
  return out.join("\n" + indent);
}

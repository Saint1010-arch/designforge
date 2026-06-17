import fs from "node:fs";
import path from "node:path";
import ora from "ora";
import c from "picocolors";
import { extractSite } from "../core/extract.js";
import { generateFusionReport, blendTokens } from "../core/fuse.js";
import { buildFusionSite } from "../generate/builder.js";
import { LlmClient, resolveLlmConfig } from "../llm/client.js";

export interface FuseOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  out?: string;
  weight?: string;
  instructions?: string;
  yes?: boolean;
}

export async function fuseCommand(urlA: string, urlB: string, opts: FuseOptions) {
  validateUrl(urlA);
  validateUrl(urlB);
  const weightA = clampWeight(opts.weight);
  const cfg = resolveLlmConfig(opts);
  const llm = new LlmClient(cfg);

  const spin = ora({ text: "Starting", color: "cyan" }).start();
  spin.text = "Extracting site A: " + urlA;
  const a = await extractSite(urlA, { onStep: (m) => (spin.text = "A . " + m) });
  spin.text = "Extracting site B: " + urlB;
  const b = await extractSite(urlB, { onStep: (m) => (spin.text = "B . " + m) });

  spin.text = "Fusing design languages (" + weightA + "/" + (100 - weightA) + ")";
  const report = await generateFusionReport(a, b, weightA, llm);
  spin.succeed("Fusion report ready (shown before building)");

  printFusion(a, b, weightA, report);

  const baseDir = opts.out || path.join(process.cwd(), "designforge-out");
  fs.mkdirSync(baseDir, { recursive: true });
  const name = sanitize(host(urlA) + "-x-" + host(urlB));
  fs.writeFileSync(path.join(baseDir, name + "-fusion-report.md"), fusionMarkdown(a, b, weightA, report), "utf8");

  if (!opts.yes) {
    const prompts = (await import("prompts")).default;
    const { go } = await prompts({ type: "confirm", name: "go", message: "Build the fused Next.js site?", initial: true });
    if (!go) {
      console.log(c.yellow("  Skipped build. Fusion report saved."));
      return;
    }
  }

  const projectDir = path.join(baseDir, name + "-fusion");
  const spin2 = ora({ text: "Building", color: "cyan" }).start();
  await buildFusionSite(projectDir, a, b, weightA, report, llm, (m) => (spin2.text = m), opts.instructions);
  spin2.succeed("Fused site generated");

  console.log("");
  console.log(c.bold(c.green("  Project: ")) + projectDir);
  console.log(c.dim("  Next:    ") + c.cyan("cd " + JSON.stringify(projectDir) + " && npm install && npm run dev"));
  console.log("");
}

function printFusion(a: ExtractionLike, b: ExtractionLike, weightA: number, r: FusionLike) {
  console.log("");
  console.log(c.bold(c.cyan("  Fusion Report")));
  console.log(c.dim("  " + a.finalUrl + "  (" + weightA + "%)  +  " + b.finalUrl + "  (" + (100 - weightA) + "%)"));
  console.log("");
  console.log(c.bold("  Vibe:  ") + r.vibe.map((v) => c.green(v)).join("  "));
  console.log("");
  console.log(c.bold("  Summary"));
  console.log("  " + r.summary);
  console.log("");
  const blend = blendTokens(a as never, b as never, weightA);
  console.log(c.bold("  Blended palette"));
  console.log("  " + blend.palette.slice(0, 8).join("  "));
  console.log("");
}

function fusionMarkdown(a: ExtractionLike, b: ExtractionLike, weightA: number, r: FusionLike): string {
  const blend = blendTokens(a as never, b as never, weightA);
  return [
    "# Fusion Report",
    "",
    "- Site A: " + a.finalUrl + " (" + weightA + "%)",
    "- Site B: " + b.finalUrl + " (" + (100 - weightA) + "%)",
    "",
    "## Summary", r.summary,
    "",
    "## Vibe", r.vibe.map((v) => "\`" + v + "\`").join("  "),
    "",
    "## Blend Rationale", r.blendRationale,
    "",
    "## Color Plan", r.colorPlan,
    "",
    "Blended palette:",
    ...blend.palette.map((p) => "- " + p),
    "",
    "## Typography Plan", r.typographyPlan,
    "",
    "## Layout Plan", r.layoutPlan,
    "",
    "## Recommendations", ...r.recommendations.map((x) => "- " + x),
    "",
    "## Same-Style Prompt (reference only)",
    "\`\`\`", r.sameStylePrompt, "\`\`\`", "",
  ].join("\n");
}

interface ExtractionLike { finalUrl: string; }
interface FusionLike {
  summary: string; vibe: string[]; blendRationale: string; colorPlan: string;
  typographyPlan: string; layoutPlan: string; recommendations: string[]; sameStylePrompt: string;
}

function validateUrl(url: string) {
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw new Error(); }
  catch { throw new Error("Invalid URL: " + url); }
}
function clampWeight(w?: string): number {
  const n = w ? parseInt(w, 10) : 50;
  if (isNaN(n)) return 50;
  return Math.min(95, Math.max(5, n));
}
function host(url: string) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "site"; } }
function sanitize(s: string) { return s.replace(/[^a-z0-9\-_]+/gi, "-").replace(/-+/g, "-").slice(0, 60) || "fusion"; }

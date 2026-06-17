import fs from "node:fs";
import path from "node:path";
import ora from "ora";
import c from "picocolors";
import { extractSite } from "../core/extract.js";
import { generateReport } from "../core/report.js";
import { reportToMarkdown, printReportSummary } from "../core/format.js";
import { buildSite } from "../generate/builder.js";
import { LlmClient, resolveLlmConfig } from "../llm/client.js";

export interface CloneOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  out?: string;
  yes?: boolean;
  instructions?: string;
}

export async function cloneCommand(url: string, opts: CloneOptions) {
  validateUrl(url);
  const cfg = resolveLlmConfig(opts);
  const llm = new LlmClient(cfg);

  const spin = ora({ text: "Starting", color: "cyan" }).start();
  const onStep = (m: string) => (spin.text = m);

  // 1) extract + report FIRST (the "report before any action" requirement)
  const extraction = await extractSite(url, { onStep });
  spin.text = "Analyzing design language with " + cfg.model;
  const report = await generateReport(extraction, llm);
  spin.succeed("Design report ready (shown before building)");
  printReportSummary(extraction, report, c);

  const baseDir = opts.out || path.join(process.cwd(), "designforge-out");
  const base = sanitize(extraction.title || hostname(url));
  const projectDir = path.join(baseDir, base + "-clone");
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, base + "-report.md"), reportToMarkdown(extraction, report), "utf8");

  // 2) confirm before building (unless --yes)
  if (!opts.yes) {
    const prompts = (await import("prompts")).default;
    const { go } = await prompts({
      type: "confirm",
      name: "go",
      message: "Build a same-style Next.js site into " + projectDir + " ?",
      initial: true,
    });
    if (!go) {
      console.log(c.yellow("  Skipped build. Report is saved."));
      return;
    }
  }

  // 3) build
  const spin2 = ora({ text: "Building", color: "cyan" }).start();
  await buildSite(projectDir, extraction, report, llm, (m) => (spin2.text = m), opts.instructions);
  spin2.succeed("Same-style site generated");

  console.log("");
  console.log(c.bold(c.green("  Project: ")) + projectDir);
  console.log(c.dim("  Next:    ") + c.cyan("cd " + JSON.stringify(projectDir) + " && npm install && npm run dev"));
  console.log("");
}

function validateUrl(url: string) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error();
  } catch {
    throw new Error("Invalid URL: " + url + " (use a full http(s) URL)");
  }
}
function hostname(url: string) { try { return new URL(url).hostname; } catch { return "site"; } }
function sanitize(s: string) { return s.replace(/[^a-z0-9\-_]+/gi, "-").replace(/-+/g, "-").slice(0, 50) || "site"; }

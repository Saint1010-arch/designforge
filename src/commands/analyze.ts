import fs from "node:fs";
import path from "node:path";
import ora from "ora";
import c from "picocolors";
import { extractSite } from "../core/extract.js";
import { generateReport } from "../core/report.js";
import { reportToMarkdown, printReportSummary } from "../core/format.js";
import { LlmClient, resolveLlmConfig } from "../llm/client.js";

export interface AnalyzeOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  out?: string;
  json?: boolean;
}

export async function analyzeCommand(url: string, opts: AnalyzeOptions) {
  validateUrl(url);
  const cfg = resolveLlmConfig(opts);
  const llm = new LlmClient(cfg);

  const spin = ora({ text: "Starting", color: "cyan" }).start();
  const onStep = (m: string) => (spin.text = m);

  const extraction = await extractSite(url, { onStep });
  spin.text = "Analyzing design language with " + cfg.model;
  const report = await generateReport(extraction, llm);
  spin.succeed("Analysis complete");

  printReportSummary(extraction, report, c);

  const outDir = opts.out || path.join(process.cwd(), "designforge-out");
  fs.mkdirSync(outDir, { recursive: true });
  const md = reportToMarkdown(extraction, report);
  const base = sanitize(extraction.title || hostname(url));
  const mdPath = path.join(outDir, base + "-report.md");
  fs.writeFileSync(mdPath, md, "utf8");
  if (opts.json) {
    const jsonPath = path.join(outDir, base + "-data.json");
    fs.writeFileSync(jsonPath, JSON.stringify({ extraction, report }, null, 2), "utf8");
    console.log(c.dim("  data:   ") + jsonPath);
  }
  console.log(c.bold(c.green("  Report saved: ")) + mdPath);
  console.log("");
  console.log(c.dim("  Tip: run ") + c.cyan("designforge clone " + url) + c.dim(" to build a same-style site."));
  console.log("");
  return { extraction, report, mdPath };
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

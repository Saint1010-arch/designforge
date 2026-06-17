#!/usr/bin/env node
import { Command } from "commander";
import c from "picocolors";
import { analyzeCommand } from "./commands/analyze.js";
import { cloneCommand } from "./commands/clone.js";
import { fuseCommand } from "./commands/fuse.js";
import { serveCommand } from "./commands/serve.js";

const program = new Command();

program
  .name("designforge")
  .description(
    "Analyze any website's design language and rebuild a same-style site.\n" +
      "Uses a real headless browser for extraction and YOUR OWN LLM API key (BYOK)."
  )
  .version("0.1.0");

program
  .command("analyze")
  .argument("<url>", "website URL to analyze")
  .description("Extract design tokens and produce a design report + same-style prompt")
  .option("--api-key <key>", "LLM API key (or set OPENAI_API_KEY)")
  .option("--base-url <url>", "OpenAI-compatible base URL")
  .option("--model <model>", "model name (default: gpt-4o-mini)")
  .option("--out <dir>", "output directory")
  .option("--json", "also write raw extraction + report JSON")
  .action(async (url, opts) => {
    try {
      await analyzeCommand(url, opts);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("clone")
  .argument("<url>", "website URL to clone")
  .description("Show a design report, then build a same-style Next.js project")
  .option("--api-key <key>", "LLM API key (or set OPENAI_API_KEY)")
  .option("--base-url <url>", "OpenAI-compatible base URL")
  .option("--model <model>", "model name (default: gpt-4o-mini)")
  .option("--out <dir>", "output directory")
  .option("-y, --yes", "skip the confirmation prompt and build immediately")
  .option("--instructions <text>", "customization, e.g. 'use my title, change accent to teal'")
  .action(async (url, opts) => {
    try {
      await cloneCommand(url, opts);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("fuse")
  .argument("<urlA>", "first website URL")
  .argument("<urlB>", "second website URL")
  .description("Fuse two sites' design languages by weight, then build a new same-style site")
  .option("--api-key <key>", "LLM API key (or set OPENAI_API_KEY)")
  .option("--base-url <url>", "OpenAI-compatible base URL")
  .option("--model <model>", "model name (default: gpt-4o-mini)")
  .option("--weight <n>", "percent weight for site A (5-95, default 50)")
  .option("--instructions <text>", "customization for the fused site")
  .option("--out <dir>", "output directory")
  .option("-y, --yes", "skip the confirmation prompt and build immediately")
  .action(async (urlA, urlB, opts) => {
    try {
      await fuseCommand(urlA, urlB, opts);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("serve", { isDefault: true })
  .description("Start the local web UI (default when run with no command)")
  .option("--port <n>", "port to listen on (default 4571)")
  .option("--no-open", "do not auto-open the browser")
  .action(async (opts) => {
    try {
      await serveCommand(opts);
    } catch (e) {
      fail(e);
    }
  });

program.parseAsync(process.argv);

function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("\n" + c.red(c.bold("  Error: ")) + msg + "\n");
  process.exit(1);
}

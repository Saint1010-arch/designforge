/**
 * Build an offline, double-click-to-run release bundle for Windows.
 *
 * Output layout (zipped):
 *   designforge-win/
 *     启动.bat
 *     runtime/node.exe              (portable Node)
 *     app/dist, app/public-ui, app/templates, app/node_modules (prod deps only)
 *     browser/chromium-*, chromium_headless_shell-*, ffmpeg-*  (Playwright browser)
 *
 * Usage: node scripts/package-win.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const NODE_VERSION = "v20.19.0";
const NODE_ZIP = "node-" + NODE_VERSION + "-win-x64.zip";
const NODE_URL = "https://nodejs.org/dist/" + NODE_VERSION + "/" + NODE_ZIP;

const BUILD = path.join(ROOT, "release");
const STAGE = path.join(BUILD, "designforge-win");

function sh(cmd, opts = {}) { console.log("> " + cmd); execSync(cmd, { stdio: "inherit", ...opts }); }
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(src, dst) { fs.cpSync(src, dst, { recursive: true }); }

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => https.get(u, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location);
      }
      if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode + " for " + u));
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
    });
    get(url).on("error", reject);
  });
}

async function main() {
  console.log("\n=== DesignForge Windows packager ===\n");
  rmrf(BUILD);
  fs.mkdirSync(STAGE, { recursive: true });

  // 1) build the app
  sh("npm run build", { cwd: ROOT });

  // 2) stage app (dist + ui + templates + prod node_modules)
  const appDir = path.join(STAGE, "app");
  fs.mkdirSync(appDir, { recursive: true });
  copyDir(path.join(ROOT, "dist"), path.join(appDir, "dist"));
  copyDir(path.join(ROOT, "public-ui"), path.join(appDir, "public-ui"));
  if (fs.existsSync(path.join(ROOT, "templates"))) copyDir(path.join(ROOT, "templates"), path.join(appDir, "templates"));
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(appDir, "package.json"));

  // prod-only node_modules via clean install in a temp copy
  console.log("\n-- installing production dependencies --");
  const tmp = path.join(os.tmpdir(), "designforge-prod-" + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(tmp, "package.json"));
  if (fs.existsSync(path.join(ROOT, "package-lock.json"))) fs.copyFileSync(path.join(ROOT, "package-lock.json"), path.join(tmp, "package-lock.json"));
  sh("npm install --omit=dev --no-audit --no-fund", { cwd: tmp });
  copyDir(path.join(tmp, "node_modules"), path.join(appDir, "node_modules"));
  rmrf(tmp);

  // 3) portable Node
  console.log("\n-- fetching portable Node " + NODE_VERSION + " --");
  const runtimeDir = path.join(STAGE, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const zipPath = path.join(BUILD, NODE_ZIP);
  await download(NODE_URL, zipPath);
  sh('powershell -NoProfile -Command "Expand-Archive -Force -Path \'' + zipPath + '\' -DestinationPath \'' + BUILD + '\'"');
  const extracted = path.join(BUILD, "node-" + NODE_VERSION + "-win-x64");
  fs.copyFileSync(path.join(extracted, "node.exe"), path.join(runtimeDir, "node.exe"));
  rmrf(extracted); rmrf(zipPath);

  // 4) bundled Chromium (Playwright)
  console.log("\n-- copying Playwright browser --");
  const pwSrc = process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  const browserDir = path.join(STAGE, "browser");
  fs.mkdirSync(browserDir, { recursive: true });
  for (const entry of fs.readdirSync(pwSrc)) {
    if (/^(chromium|chromium_headless_shell|ffmpeg|winldd)/.test(entry)) {
      copyDir(path.join(pwSrc, entry), path.join(browserDir, entry));
    }
  }

  // 5) launcher + readme (copied from launcher/, written as clean UTF-8)
  fs.copyFileSync(path.join(ROOT, "launcher", "启动.bat"), path.join(STAGE, "启动.bat"));
  fs.copyFileSync(path.join(ROOT, "launcher", "使用说明.txt"), path.join(STAGE, "使用说明.txt"));

  // 6) zip
  console.log("\n-- zipping --");
  const zipOut = path.join(BUILD, "designforge-win.zip");
  sh('powershell -NoProfile -Command "Compress-Archive -Force -Path \'' + STAGE + '\' -DestinationPath \'' + zipOut + '\'"');

  const sizeMB = (fs.statSync(zipOut).size / 1024 / 1024).toFixed(0);
  console.log("\n✅ Done: " + zipOut + "  (" + sizeMB + " MB)\n");
}

main().catch((e) => { console.error("\nPackaging failed:", e.message); process.exit(1); });

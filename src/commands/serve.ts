import c from "picocolors";
import { exec } from "node:child_process";
import { startServer } from "../server/api.js";

export interface ServeOptions {
  port?: string;
  open?: boolean;
}

export async function serveCommand(opts: ServeOptions) {
  const desired = opts.port ? parseInt(opts.port, 10) : 4571;
  const port = await startServer(desired).catch(async () => {
    // try a few fallback ports
    for (const p of [desired + 1, desired + 2, desired + 3, 0]) {
      try { return await startServer(p); } catch { /* next */ }
    }
    throw new Error("Could not bind a port");
  });

  const urlLocal = "http://localhost:" + port;
  console.log("");
  console.log(c.bold(c.cyan("  designforge")) + c.dim("  is running"));
  console.log("");
  console.log("  " + c.bold("Open: ") + c.green(urlLocal));
  console.log(c.dim("  Bring your own API key in the UI. Press Ctrl+C to stop."));
  console.log("");

  if (opts.open !== false) openBrowser(urlLocal);
}

function openBrowser(url: string) {
  const platform = process.platform;
  const cmd =
    platform === "win32" ? `start "" "${url}"`
    : platform === "darwin" ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => { /* ignore */ });
}

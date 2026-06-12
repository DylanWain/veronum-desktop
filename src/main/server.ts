/**
 * Spawns the bundled Veronum-site Next.js standalone server as a child
 * process of the Electron main, on a fixed local port so localStorage
 * (chat history, undo log, version snapshots) survives across launches.
 *
 * Why fixed-port:
 *   localStorage / IndexedDB are scoped by (protocol, host, port). If
 *   we pick a free port each launch the user's saved chat list would
 *   disappear next time the app opens — that's the exact bug the user
 *   asked us to never have again. We start at 27500 and walk forward
 *   if it's taken; in practice 27500 is always free.
 *
 * Why Electron's bundled Node (process.execPath + ELECTRON_RUN_AS_NODE):
 *   The .app ships its own Node-compatible runtime (Electron). Spawning
 *   the standalone server through it removes any dependency on the
 *   user having Node installed.
 *
 * Env vars threaded to the child:
 *   PORT, HOSTNAME           binding the local server
 *   DESKTOP_REMOTE_API_URL   makes Next rewrites forward /api/* to the
 *                            live deployment (where the model keys live)
 *   NODE_ENV=production      Next standalone behaviour
 *
 * Readiness:
 *   we poll http://127.0.0.1:PORT/ every 250ms for up to 30s. The
 *   first 200/3xx response means we can load the URL in the
 *   BrowserWindow.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { app } from "electron";

const PORT_BASE = 27500;
const PORT_MAX_WALK = 20;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
const REMOTE_API_DEFAULT = "https://thetoolswebsite.com";

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); resolve(false); });
    s.once("error", () => { s.destroy(); resolve(true); });
  });
}

async function pickPort(): Promise<number> {
  for (let i = 0; i < PORT_MAX_WALK; i++) {
    const port = PORT_BASE + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port in ${PORT_BASE}..${PORT_BASE + PORT_MAX_WALK - 1}`);
}

function resolveServerPath(): string {
  // In dev (electron-vite), __dirname is veronum-desktop/out/main.
  // In a packaged .app the resources live at
  //   .app/Contents/Resources/web/ (because we asarUnpack 'resources/web/**')
  // Try both.
  const devPath = join(__dirname, "../../resources/web/server.js");
  if (existsSync(devPath)) return devPath;
  const prodPath = join(process.resourcesPath ?? "", "web/server.js");
  if (existsSync(prodPath)) return prodPath;
  throw new Error(
    `Veronum-site bundle not found.\n` +
    `Looked at:\n  ${devPath}\n  ${prodPath}\n` +
    `Did you run \`npm run build:web\`?`,
  );
}

function waitForReady(url: string): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async (): Promise<void> => {
      try {
        const r = await fetch(url, { method: "GET" });
        // Any 2xx/3xx is "alive" — even a redirect proves the server
        // is handling requests.
        if (r.status < 500) return resolve();
      } catch {
        // not ready yet — fall through to retry
      }
      if (Date.now() - started > READY_TIMEOUT_MS) {
        return reject(new Error(`Standalone server didn't become ready in ${READY_TIMEOUT_MS}ms`));
      }
      setTimeout(tick, READY_POLL_MS);
    };
    void tick();
  });
}

export type ServerHandle = {
  url: string;
  port: number;
  child: ChildProcess;
};

let active: ServerHandle | null = null;

export async function startVeronumServer(): Promise<ServerHandle> {
  if (active) return active;
  const serverPath = resolveServerPath();
  const port = await pickPort();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    DESKTOP_REMOTE_API_URL: process.env.VERONUM_REMOTE_API_URL ?? REMOTE_API_DEFAULT,
    // ELECTRON_RUN_AS_NODE makes Electron's binary behave like vanilla
    // Node — no GUI, no Chromium, no Electron APIs. That's how we run
    // Next's standalone server.js from inside the .app without
    // bundling a separate Node runtime.
    ELECTRON_RUN_AS_NODE: "1",
  };

  const child = spawn(process.execPath, [serverPath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: join(serverPath, ".."),
  });

  // Stream the child's output into the main-process console for
  // debugging. Not surfaced to the renderer.
  child.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

  child.on("exit", (code, signal) => {
    process.stderr.write(`[server] exited code=${code} signal=${signal}\n`);
    active = null;
  });

  // Clean shutdown when the app quits — otherwise the orphan node
  // process can keep port 27500 held after a crash.
  app.on("before-quit", () => {
    if (!child.killed) child.kill();
  });

  const url = `http://127.0.0.1:${port}`;
  await waitForReady(url);
  active = { url, port, child };
  return active;
}

export function getActiveServer(): ServerHandle | null {
  return active;
}

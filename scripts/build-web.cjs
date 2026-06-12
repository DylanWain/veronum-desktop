#!/usr/bin/env node
/**
 * build-web — builds Veronum-site as a Next.js standalone bundle and
 * copies the output into resources/web/ inside this project so
 * electron-builder can pack it into the .app.
 *
 * Standalone layout after `next build` with output:'standalone':
 *   ../Veronum-site/.next/standalone/   self-contained server + minimal node_modules
 *   ../Veronum-site/.next/static/       static chunks, must be at .next/standalone/.next/static/
 *   ../Veronum-site/public/             public/, must be at .next/standalone/public/
 *
 * We copy all three into resources/web/, then the runtime spawner can
 * just do `node resources/web/server.js`.
 *
 * Run from the veronum-desktop project root:
 *   node scripts/build-web.cjs
 *
 * Or via the npm script:
 *   npm run build:web
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SITE_ROOT = path.resolve(__dirname, "../../Veronum-site");
const OUT_DIR = path.resolve(__dirname, "../resources/web");

function log(msg) {
  process.stdout.write(`[build-web] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[build-web] ERROR: ${msg}\n`);
  process.exit(1);
}

function rmrf(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else fs.copyFileSync(s, d);
  }
}

if (!fs.existsSync(SITE_ROOT)) fail(`Veronum-site not found at ${SITE_ROOT}`);
if (!fs.existsSync(path.join(SITE_ROOT, "package.json"))) fail("Veronum-site has no package.json");

log(`Veronum-site:   ${SITE_ROOT}`);
log(`Output target:  ${OUT_DIR}`);

log("running `next build` in Veronum-site …");
try {
  execSync("npm run build", {
    cwd: SITE_ROOT,
    stdio: "inherit",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
} catch {
  fail("next build failed — see the output above");
}

const standaloneBase = path.join(SITE_ROOT, ".next/standalone");
const staticDir      = path.join(SITE_ROOT, ".next/static");
const publicDir      = path.join(SITE_ROOT, "public");

if (!fs.existsSync(standaloneBase)) {
  fail("`.next/standalone` missing — is `output: 'standalone'` set in next.config.ts?");
}

// When outputFileTracingRoot is set, Next nests the standalone output
// under .next/standalone/<projectRelPath>/. Find the actual server.js
// rather than assuming a fixed layout — supports both flat output
// (no tracing root) and nested output (tracing root pinned).
function findServerRoot(base) {
  if (fs.existsSync(path.join(base, "server.js"))) return base;
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(base, entry.name);
    if (fs.existsSync(path.join(nested, "server.js"))) return nested;
    // one level deeper, just in case
    for (const inner of fs.readdirSync(nested, { withFileTypes: true })) {
      if (!inner.isDirectory()) continue;
      const deeper = path.join(nested, inner.name);
      if (fs.existsSync(path.join(deeper, "server.js"))) return deeper;
    }
  }
  return null;
}

const serverRoot = findServerRoot(standaloneBase);
if (!serverRoot) {
  fail("`.next/standalone` exists but no server.js found inside. The build is incomplete.");
}
log(`found standalone at ${serverRoot}`);

log(`clearing ${OUT_DIR} …`);
rmrf(OUT_DIR);
fs.mkdirSync(OUT_DIR, { recursive: true });

log("copying standalone/ → web/ …");
copyDir(serverRoot, OUT_DIR);

if (fs.existsSync(staticDir)) {
  log("copying .next/static/ → web/.next/static/ …");
  copyDir(staticDir, path.join(OUT_DIR, ".next/static"));
} else {
  log("WARN: .next/static not present — UI might be missing chunks");
}

if (fs.existsSync(publicDir)) {
  log("copying public/ → web/public/ …");
  copyDir(publicDir, path.join(OUT_DIR, "public"));
} else {
  log("no public/ directory — skipping (fine)");
}

log("done.");
log(`The bundle is at ${OUT_DIR}/server.js`);

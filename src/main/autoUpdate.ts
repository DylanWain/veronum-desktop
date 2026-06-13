/**
 * Auto-update for Veronum Desktop.
 *
 * electron-updater checks the GitHub Releases feed (configured under
 * `publish` in electron-builder.yml) on launch and every 6 hours. When a
 * newer SIGNED build is published it downloads in the background, then on
 * 'update-downloaded' offers a one-click restart — otherwise the update
 * installs silently the next time the user quits.
 *
 * No-op in dev (app.isPackaged === false): electron-updater needs a
 * packaged, code-signed build with an embedded app-update.yml, which only
 * exists inside the shipped .app/.dmg. Calling it from `npm run dev` would
 * throw, so we skip cleanly.
 *
 * Failure posture: every path is wrapped so a missing release, an offline
 * machine, or a GitHub rate-limit logs a line and is otherwise ignored —
 * an update check must never crash the app or block the window.
 */
import { app, dialog, BrowserWindow } from "electron";
// electron-updater ships as CommonJS; the documented cross-interop import
// is the default-then-destructure form (named imports resolve to
// undefined under some bundler/ESM combinations).
import electronUpdater from "electron-updater";

// NB: `electronUpdater.autoUpdater` is a LAZY GETTER — touching it
// instantiates MacUpdater (which reads app.getVersion()). We must not
// destructure it at module load; we read it only inside initAutoUpdate,
// after the isPackaged guard, so dev builds never construct an updater.
type AutoUpdater = typeof electronUpdater.autoUpdater;

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function log(message: string): void {
  process.stdout.write(`[auto-update] ${message}\n`);
}

// Guards against stacking dialogs if more than one download resolves.
let promptOpen = false;

async function offerRestart(autoUpdater: AutoUpdater, version: string): Promise<void> {
  if (promptOpen) return;
  promptOpen = true;

  const win = BrowserWindow.getAllWindows()[0] ?? null;
  const options = {
    type: "info" as const,
    buttons: ["Restart now", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "Update ready",
    message: `Veronum ${version} is ready to install.`,
    detail:
      "Restart to apply it now, or it will install automatically the next time you quit Veronum.",
  };

  try {
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    if (response === 0) {
      // isSilent=false: surface the installer if it needs interaction.
      // isForceRunAfter=true: relaunch Veronum once the update is applied.
      autoUpdater.quitAndInstall(false, true);
    }
  } catch (err) {
    log(`restart prompt failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    promptOpen = false;
  }
}

/**
 * Wire up background auto-updates. Safe to call unconditionally from
 * app.whenReady() — it self-disables in dev.
 */
export function initAutoUpdate(): void {
  if (!app.isPackaged) {
    log("skipped — dev / unpackaged build has no update feed");
    return;
  }

  // Safe to read the lazy getter now: packaged + Electron app is ready.
  const { autoUpdater } = electronUpdater;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null; // we emit our own concise lines below

  autoUpdater.on("error", (err: unknown) => {
    // Offline, no release yet, or rate-limited — never fatal.
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
  });
  autoUpdater.on("update-available", (info: { version: string }) =>
    log(`update available: ${info.version}`),
  );
  autoUpdater.on("update-not-available", () => log("up to date"));
  autoUpdater.on("update-downloaded", (info: { version: string }) => {
    log(`downloaded: ${info.version}`);
    void offerRestart(autoUpdater, info.version);
  });

  const check = (): void => {
    autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
      log(`check failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  check(); // on launch
  setInterval(check, SIX_HOURS_MS); // and periodically for long-lived windows
}

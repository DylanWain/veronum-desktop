import { defineConfig, externalizeDepsPlugin } from "electron-vite";

/**
 * Electron-Vite config.
 *
 * Three build contexts:
 *   - main:    Node-side. Runs the BrowserWindow, holds the FS bridge IPC handlers.
 *   - preload: Bridge that contextBridge-exposes window.veronumDesktop to the renderer.
 *   - renderer: NOT built locally yet — v1 loads thetoolswebsite.com remotely. v2 will
 *               bundle Veronum-site's Next.js standalone output and load it via a
 *               local server on a free port. Until then we just declare nothing here.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: "out/main" },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: "out/preload" },
  },
});

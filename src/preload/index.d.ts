/**
 * Ambient types so Veronum-site (TypeScript) can declare
 * window.veronumDesktop without copying the interface around.
 *
 * Veronum-site can re-declare this with `import type` after we ship
 * the API, but for now duplicating the shape is fine — the file is
 * small and the bridge is stable.
 */
declare global {
  interface Window {
    veronumDesktop?: {
      pickFolder(): Promise<{
        rootId: string;
        rootName: string;
        files: { path: string; content: string }[];
        totalBytes: number;
        dropped: number;
      } | null>;
      walkFolder(rootId: string): Promise<{
        files: { path: string; content: string }[];
        totalBytes: number;
        dropped: number;
      } | null>;
      readFile(rootId: string, relPath: string): Promise<string | null>;
      writeFile(
        rootId: string,
        relPath: string,
        content: string,
      ): Promise<{ ok: true } | { ok: false; error: string }>;
      platform(): Promise<{
        isDesktop: true;
        platform: NodeJS.Platform;
        arch: string;
        version: string;
      }>;
      onAuthCallback(handler: (url: string) => void): () => void;
    };
  }
}

export {};

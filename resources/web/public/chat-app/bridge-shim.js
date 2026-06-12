/**
 * bridge-shim.js — auth + channel + fetch monkey-patch
 *
 * Loaded BEFORE app.js. Three jobs:
 *
 *   1. Auth gate — read the Supabase session from localStorage (set by
 *      /pair-bridge or /chat-app once the user has paired their Mac).
 *      If no session, show an inline "go pair your Mac first" overlay
 *      and stop. App.js never runs.
 *
 *   2. Look up the user's paired bridge via veronum_bridges (RLS gates
 *      to their own row), extract install_id, subscribe to the
 *      `bridge:<install_id>` Realtime broadcast channel.
 *
 *   3. Monkey-patch window.fetch so any URL starting with /api/ gets
 *      routed through the channel as a `bridge.fetch.request` event.
 *      The daemon (lib/bridgeSupabase.js + server.js handleChannelFetch)
 *      proxies the request to its own localhost endpoints and streams
 *      the response back as bridge.fetch.response (one-shot) or a
 *      sequence of bridge.fetch.chunk + bridge.fetch.done (streaming).
 *      Returned object is a Response-shaped wrapper so app.js's
 *      existing `await res.json()` and `res.body.getReader()` calls
 *      keep working with zero changes.
 *
 * Result: the localhost app.js code runs unmodified in the cloud,
 * with the Mac daemon at the other end of every /api/* call.
 */

(() => {
  // ─── Constants (must match Tools-AI lib/supabase.ts) ─────────────────────
  const SUPABASE_URL = "https://synpjcammfjebwsmtfpz.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_1h3d9dMB7f5JK_8aLHR5ig_GiurDzuS";
  const STORAGE_KEY = "veronum-auth"; // matches storageKey in getBrowserSupabase

  // List of /api/* paths that return SSE rather than JSON. The shim
  // routes them through the streaming branch of bridge.fetch.request.
  const STREAMING_PATHS = ["/api/claude/send", "/api/cursor/send"];

  // ─── Inline overlay helpers (no UI framework on this page) ───────────────
  function showOverlay(html) {
    const root = document.createElement("div");
    root.id = "bridge-overlay";
    root.style.cssText = `
      position:fixed;inset:0;background:rgba(14,13,18,.92);
      color:#f0eef5;z-index:9999;
      display:flex;align-items:center;justify-content:center;
      font-family:"IBM Plex Sans",system-ui,sans-serif;
      padding:24px;text-align:center;line-height:1.5`;
    root.innerHTML = `<div style="max-width:480px">${html}</div>`;
    document.body.appendChild(root);
  }

  // ─── 1. Bootstrap ────────────────────────────────────────────────────────
  async function bootstrap() {
    if (!window.supabase || !window.supabase.createClient) {
      showOverlay(`<h2>Supabase library failed to load</h2>
        <p style="color:#9a94aa">Reload the page. If the issue persists, check your network.</p>`);
      return;
    }

    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: STORAGE_KEY,
      },
    });

    // Auth gate
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.user?.id) {
      showOverlay(`
        <h2>Sign in first</h2>
        <p style="color:#9a94aa;margin:12px 0 24px">
          You need to pair this Mac to your account before opening the chat.
        </p>
        <a href="/pair-bridge"
           style="display:inline-block;background:#a78bfa;color:#0e0d12;
                  padding:10px 20px;border-radius:999px;
                  text-decoration:none;font-weight:500">
          Pair this Mac
        </a>`);
      return;
    }
    const userId = session.user.id;

    // Look up the user's bridge(s) via RLS
    const { data: bridges, error: bErr } = await sb
      .from("veronum_bridges")
      .select("id, install_id, hostname, app_version, last_seen_at")
      .not("user_id", "is", null)
      .order("last_seen_at", { ascending: false });

    if (bErr) {
      showOverlay(`<h2>Couldn't load your bridges</h2>
        <p style="color:#9a94aa">${bErr.message}</p>`);
      return;
    }
    if (!bridges || bridges.length === 0) {
      showOverlay(`<h2>No Mac paired yet</h2>
        <p style="color:#9a94aa;margin:12px 0 24px">
          Install Veronum Bridge on your Mac, then pair it. This page is the chat surface for whatever Mac is paired to your account.
        </p>
        <a href="/pair-bridge"
           style="display:inline-block;background:#a78bfa;color:#0e0d12;
                  padding:10px 20px;border-radius:999px;
                  text-decoration:none;font-weight:500">
          Pair a Mac
        </a>`);
      return;
    }

    const bridge = bridges[0];
    const channelName = `bridge:${bridge.install_id}`;

    // Open the channel
    const channel = sb.channel(channelName, {
      config: { broadcast: { self: false, ack: false } },
    });
    const pending = new Map(); // request_id → { onResponse, onChunk, onDone, onError }

    channel
      .on("broadcast", { event: "bridge.fetch.response" }, ({ payload }) => {
        const p = pending.get(payload.request_id);
        if (p?.onResponse) p.onResponse(payload);
        pending.delete(payload.request_id);
      })
      .on("broadcast", { event: "bridge.fetch.chunk" }, ({ payload }) => {
        const p = pending.get(payload.request_id);
        if (p?.onChunk) p.onChunk(payload);
      })
      .on("broadcast", { event: "bridge.fetch.done" }, ({ payload }) => {
        const p = pending.get(payload.request_id);
        if (p?.onDone) p.onDone(payload);
        pending.delete(payload.request_id);
      })
      .on("broadcast", { event: "bridge.fetch.error" }, ({ payload }) => {
        const p = pending.get(payload.request_id);
        if (p?.onError) p.onError(payload);
        pending.delete(payload.request_id);
      });

    await new Promise((resolve) => {
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") resolve();
      });
    });
    // Supabase broadcast has a ~2s warmup window after SUBSCRIBED where
    // outgoing messages can silently drop (the channel join hasn't
    // fully propagated to the broker yet). Without this wait, app.js's
    // first batch of fetch calls (loadProjects, loadModels) never get
    // responses from the daemon and the UI sits stuck on "loading…".
    await new Promise((r) => setTimeout(r, 2500));

    // ─── 3. fetch monkeypatch ──────────────────────────────────────────────
    const _origFetch = window.fetch.bind(window);

    async function bridgeFetch(url, opts = {}) {
      // Same-origin paths only — absolute http(s)://... go to _origFetch
      const path = typeof url === "string" ? url : url.url;
      if (!path || !path.startsWith("/api/")) return _origFetch(url, opts);

      const method = (opts.method || "GET").toUpperCase();
      let body = opts.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { /* keep as string */ }
      }
      const isStream = STREAMING_PATHS.some((p) => path.startsWith(p));
      const requestId = crypto.randomUUID();

      if (!isStream) {
        // ─── One-shot JSON path ────────────────────────────────────────
        // Supabase broadcast can silently drop messages occasionally
        // (especially right after subscribe). To be resilient, we
        // retry up to 2 times on a 4-second timeout per attempt.
        return new Promise(async (resolve, reject) => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const settled = await new Promise((settleResolve) => {
              const timeout = setTimeout(() => {
                pending.delete(requestId);
                settleResolve({ kind: "timeout" });
              }, 4_000);
              pending.set(requestId, {
                onResponse: ({ status, ok, body }) => {
                  clearTimeout(timeout);
                  const text = typeof body === "string" ? body : JSON.stringify(body);
                  settleResolve({
                    kind: "response",
                    res: new Response(text, {
                      status: status || (ok ? 200 : 500),
                      headers: { "Content-Type": "application/json" },
                    }),
                  });
                },
                onError: ({ message }) => {
                  clearTimeout(timeout);
                  settleResolve({ kind: "error", message });
                },
              });
              channel.send({
                type: "broadcast",
                event: "bridge.fetch.request",
                payload: { request_id: requestId, method, path, body, stream: false },
              });
            });
            if (settled.kind === "response") return resolve(settled.res);
            if (settled.kind === "error") return reject(new Error(settled.message));
            // timeout — loop and resend if attempts left
            if (attempt < 2) {
              console.warn(`[bridge] retry ${path} (attempt ${attempt + 2}/3)`);
            }
          }
          reject(new Error(`bridge.fetch timeout after retries: ${path}`));
        });
      }

      // ─── Streaming SSE path ──────────────────────────────────────────
      let controller;
      const stream = new ReadableStream({ start(c) { controller = c; } });
      const enc = new TextEncoder();
      pending.set(requestId, {
        onChunk: ({ event, ...payload }) => {
          // Reconstruct the SSE bytes the original app.js expects.
          // Strip the request_id so the payload matches what /api/*/send
          // would have emitted in localhost mode.
          delete payload.request_id;
          const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
          controller.enqueue(enc.encode(line));
        },
        onDone: () => { try { controller.close(); } catch {} },
        onError: ({ message }) => {
          try { controller.error(new Error(message)); } catch {}
        },
      });
      channel.send({
        type: "broadcast",
        event: "bridge.fetch.request",
        payload: { request_id: requestId, method, path, body, stream: true },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    window.fetch = bridgeFetch;

    // Expose minimal handles for app.js / debug.
    window.__bridge = {
      supabase: sb,
      channel,
      bridge,
      userId,
      origFetch: _origFetch,
    };

    // Tell anyone listening that the bridge is ready (app.js can start).
    document.dispatchEvent(new CustomEvent("bridge:ready", { detail: { bridge } }));
  }

  // Wait for DOMContentLoaded + the supabase library to be available,
  // then bootstrap before app.js fires its own loadProjects/loadModels.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { bootstrap(); });
  } else {
    bootstrap();
  }
})();

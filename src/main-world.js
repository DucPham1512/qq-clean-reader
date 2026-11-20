// MAIN-world content script, runs at document_start, BEFORE any page script.
// Layer 4 (behavior half): window.open guard + click-hijack guard.
// Requires src/defaults.js loaded first in the same world.
// Note: the page can see this world. Only bundled defaults are used here (no
// messages from the page are trusted), so a hostile page cannot reconfigure it.
(() => {
  "use strict";
  const R = globalThis.QQ_DEFAULT_RULES;
  try { delete globalThis.QQ_DEFAULT_RULES; } catch (_) {}   // don't leave it for the page
  if (!R) return;
  const cfg = R.script;

  const inList = (host, list) => list.some((d) => host === d || host.endsWith("." + d));
  const hostOf = (url) => { try { return new URL(String(url), location.href).hostname; } catch (_) { return ""; } };

  // Send a finding to content.js (isolated world). Strings cross worlds safely.
  const dispatch = EventTarget.prototype.dispatchEvent;
  function report(kind, info) {
    try {
      dispatch.call(document, new CustomEvent("qq:detect", { detail: JSON.stringify({ kind, info }) }));
    } catch (_) {}
  }

  // Script URLs on the current call stack (our own extension frames are not http).
  function stackUrls() {
    const st = new Error().stack || "";
    return [...st.matchAll(/(https?:\/\/[^\s)]+?):\d+:\d+/g)].map((m) => m[1]);
  }
  // First caller that is not an allowed script (or is a known ad path).
  function foreignCaller() {
    return stackUrls().find((u) => {
      const host = hostOf(u);
      if (!inList(host, cfg.allowedScriptHosts)) return true;
      return R.network.blockUrlFilters.some((p) => u.includes(p));
    });
  }
  // Make a wrapper look native to simple "is it patched?" checks.
  function looksNative(fn, name) {
    try {
      Object.defineProperty(fn, "toString", {
        value: () => `function ${name}() { [native code] }`, configurable: true
      });
    } catch (_) {}
    return fn;
  }

  // ---------- A. window.open guard ----------
  if (cfg.guardWindowOpen) {
    const nativeOpen = window.open;
    const guardedOpen = looksNative(function open(url, ...rest) {
      const host = hostOf(url ?? "");
      if (url && inList(host, cfg.allowedOpenHosts)) return nativeOpen.call(window, url, ...rest);
      report("window.open", { url: String(url).slice(0, 200), by: foreignCaller() || "inline/eval" });
      return null;                       // looks like a popup blocker to the ad script
    }, "open");
    window.open = guardedOpen;

    // Ads sometimes grab a fresh window.open from an <iframe>. Patch those too.
    const cw = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
    if (cw && cw.get) {
      Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
        configurable: true,
        enumerable: cw.enumerable,
        get: looksNative(function contentWindow() {
          const w = cw.get.call(this);
          try { if (w && w.open !== guardedOpen) w.open = guardedOpen; } catch (_) { /* cross-origin */ }
          return w;
        }, "get contentWindow")
      });
    }
  }

  // ---------- B. click-hijack guard ----------
  if (cfg.guardClickHijack) {
    const CLICKY = new Set(["click", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend"]);
    const isPageLevel = (t) =>
      t === window || t === document || t === document.documentElement || t === document.body;

    // B1. Page-wide click listeners registered by non-allowed scripts are dropped.
    const nativeAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = looksNative(function addEventListener(type, listener, opts) {
      if (CLICKY.has(type) && isPageLevel(this)) {
        const by = foreignCaller();
        if (by) { report("click-listener", { type, by }); return; }
      }
      return nativeAdd.call(this, type, listener, opts);
    }, "addEventListener");

    // B2. Script-triggered clicks on links that open a new tab to a foreign site.
    const isAdLink = (el) =>
      el instanceof HTMLAnchorElement &&
      el.target === "_blank" &&
      !inList(hostOf(el.href), cfg.allowedOpenHosts);

    const nativeClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = looksNative(function click() {
      if (isAdLink(this)) { report("anchor-click", { url: this.href.slice(0, 200) }); return; }
      return nativeClick.call(this);
    }, "click");

    EventTarget.prototype.dispatchEvent = looksNative(function dispatchEvent(ev) {
      if (ev && ev.type === "click" && !ev.isTrusted && isAdLink(this)) {
        report("anchor-dispatch", { url: this.href.slice(0, 200) });
        return false;
      }
      return dispatch.call(this, ev);
    }, "dispatchEvent");
  }
})();

// Isolated-world content script, runs at document_start.
// Layer 3 (cosmetic) + the DOM half of layer 4 (inline loader kill, fallback strip).
// Requires src/defaults.js to be loaded first (sets globalThis.QQ_DEFAULT_RULES).
(() => {
  "use strict";
  const TAG = "[QQ]";
  let rules = globalThis.QQ_DEFAULT_RULES;
  if (!rules) return console.warn(TAG, "no default rules");

  // ---------- detection relay (to background, kept locally for step 6) ----------
  const seen = new Set();
  function detect(kind, info) {
    const key = kind + "|" + JSON.stringify(info);
    if (seen.has(key)) return;          // once per page per finding
    seen.add(key);
    console.debug(TAG, "blocked", kind, info);
    try {
      chrome.runtime.sendMessage({ type: "qq-detect", kind, info, page: location.pathname })
        .catch(() => {});
    } catch (_) { /* extension reloaded; ignore */ }
  }
  // Findings from the MAIN-world script arrive as a JSON string (objects don't cross worlds).
  document.addEventListener("qq:detect", (e) => {
    if (typeof e.detail !== "string" || e.detail.length > 2000) return;
    try {
      const d = JSON.parse(e.detail);
      if (typeof d.kind === "string") detect("main:" + d.kind.slice(0, 40), d.info);
    } catch (_) {}
  });

  // ---------- layer 3a: CSS hiding ----------
  const probe = document.createDocumentFragment();
  function validSelectors(list) {
    // One invalid selector would kill the whole CSS rule, so test each one.
    return list.filter((sel) => {
      try { probe.querySelector(sel); return true; }
      catch (_) { console.warn(TAG, "invalid selector skipped:", sel); return false; }
    });
  }
  const style = document.createElement("style");
  style.dataset.qq = "1";
  function renderCss() {
    const sels = validSelectors(rules.cosmetic.hideSelectors);
    style.textContent = sels.length
      ? sels.join(",\n") + " { display: none !important; visibility: hidden !important; }"
      : "";
  }
  function ensureStyle() {
    if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
  }
  renderCss();
  ensureStyle();

  // ---------- layer 3b: z-index sweep (overlays with unknown class names) ----------
  function checkOverlay(el) {
    if (el.dataset.qqHidden || el === style) return;
    // Cheap check first: ad overlays set z-index inline.
    const inlineZ = parseInt(el.style && el.style.zIndex, 10);
    if (!(inlineZ >= rules.cosmetic.zIndexThreshold)) return;
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") return;
    el.dataset.qqHidden = "1";
    el.style.setProperty("display", "none", "important");
    detect("overlay", { tag: el.tagName, cls: String(el.className).slice(0, 80) });
  }

  // ---------- layer 4 (DOM half): scripts ----------
  function hostOf(url) {
    try { return new URL(url, location.href).hostname; } catch (_) { return ""; }
  }
  function inList(host, list) {
    return list.some((d) => host === d || host.endsWith("." + d));
  }
  function matchesInlineRule(s, rule) {
    for (const [k, v] of Object.entries(rule.attrs || {})) {
      if (s.getAttribute(k) !== v) return false;
    }
    const text = s.textContent || "";
    return rule.textIncludesAny.some((needle) => text.includes(needle));
  }
  function inspectScript(s) {
    if (s.dataset.qqChecked) return;
    s.dataset.qqChecked = "1";
    const cfg = rules.script;

    if (!s.src) {
      // Parser-inserted inline scripts: the HTML parser runs a microtask checkpoint
      // before executing them, so this observer sees them first and can disarm them.
      for (const rule of cfg.blockInlineScripts) {
        if (matchesInlineRule(s, rule)) {
          s.type = "text/qq-blocked";
          s.textContent = "";
          detect("inline-script", { rule: rule.name });
          return;
        }
      }
      return;
    }

    // External scripts with an onerror/onload fallback (System C switches to a
    // random domain when its script fails). Remove the handlers before they fire.
    if (cfg.stripFallbackHandlers && (s.hasAttribute("onerror") || s.hasAttribute("onload"))) {
      const host = hostOf(s.src);
      const suspicious =
        inList(host, rules.network.blockDomains) || s.getAttribute("data-cfasync") === "false";
      if (suspicious) {
        s.removeAttribute("onerror");
        s.removeAttribute("onload");
        s.onerror = null;
        s.onload = null;
        detect("fallback-handler", { host });
      }
    }
  }

  // ---------- observer ----------
  function handleNode(n) {
    if (n.nodeType !== 1) return;
    if (n.tagName === "SCRIPT") return inspectScript(n);
    checkOverlay(n);
    if (n.firstElementChild) n.querySelectorAll("script").forEach(inspectScript);
  }
  const mo = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) handleNode(n);
    ensureStyle();                       // re-add if the page removed our <style>
  });
  mo.observe(document, { childList: true, subtree: true });
  // Anything parsed before we started (normally nothing at document_start).
  document.querySelectorAll("script").forEach(inspectScript);

  // ---------- newer rules from storage (written by background / remote updater) ----------
  chrome.storage.local.get("activeRules").then(({ activeRules }) => {
    if (activeRules && activeRules.version !== rules.version) {
      rules = activeRules;
      renderCss();
      console.debug(TAG, "using stored rules", rules.version);
    }
  }).catch(() => {});
})();

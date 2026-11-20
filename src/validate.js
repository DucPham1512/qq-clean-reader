// Validates a rules object before it is applied (used for the remote copy).
// Mirrors rules/rules.schema.json (structure) and adds safety checks the
// schema cannot express, e.g. "never block the site itself".
// Returns { ok: boolean, errors: string[] }.

const DOMAIN_RE = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const PATH_RE = /^\/[A-Za-z0-9._~/-]+$/;
const VERSION_RE = /^\d{4}\.\d{2}\.\d{2}-\d+$/;
const SELECTOR_BAD_CHARS = /[{}<>;]/;

// Paths the site needs to work. A block filter matching any of these is rejected.
const CRITICAL_PATHS = [
  "/template/frontend/js/main.js",
  "/template/frontend/js/jquery.lazy.min.js",
  "/template/frontend/js/readmore.min.js",
  "/template/frontend/css/"
];
// Selectors that would hide the whole page or the comic itself.
const FORBIDDEN_SELECTOR_PARTS = ["page-chapter", "chapter_content", "chapter_control", "chapter-control"];
const FORBIDDEN_SELECTORS = new Set(["*", "html", "body", "head", "main", "div", "img", "a", "span", "section", "header", "footer"]);

export function validateRules(r) {
  const errors = [];
  const err = (m) => errors.push(m);
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const onlyKeys = (obj, keys, where) => {
    for (const k of Object.keys(obj)) if (!keys.includes(k)) err(`${where}: unknown key "${k}"`);
    for (const k of keys) if (!(k in obj)) err(`${where}: missing "${k}"`);
  };
  const strList = (v, where, { max = 500, min = 0, re = null, maxLen = 253 } = {}) => {
    if (!Array.isArray(v)) return err(`${where}: must be an array`), [];
    if (v.length < min || v.length > max) err(`${where}: needs ${min}..${max} items`);
    if (new Set(v).size !== v.length) err(`${where}: duplicate items`);
    v.forEach((s, i) => {
      if (typeof s !== "string" || s.length > maxLen) err(`${where}[${i}]: bad string`);
      else if (re && !re.test(s)) err(`${where}[${i}]: invalid value "${s}"`);
    });
    return v;
  };
  const bool = (v, where) => { if (typeof v !== "boolean") err(`${where}: must be boolean`); };

  if (!isObj(r)) return { ok: false, errors: ["root: must be an object"] };
  onlyKeys(r, ["schemaVersion", "version", "site", "network", "cosmetic", "script"], "root");
  if (r.schemaVersion !== 1) err("schemaVersion: must be 1");
  if (typeof r.version !== "string" || !VERSION_RE.test(r.version)) err("version: bad format");
  if (errors.length) return { ok: false, errors };

  // site
  if (!isObj(r.site)) return { ok: false, errors: ["site: must be an object"] };
  onlyKeys(r.site, ["hosts", "hostRegex"], "site");
  const siteHosts = strList(r.site.hosts, "site.hosts", { min: 1, re: DOMAIN_RE });
  if (typeof r.site.hostRegex !== "string" || r.site.hostRegex.length > 200) err("site.hostRegex: bad");
  else { try { new RegExp(r.site.hostRegex); } catch (_) { err("site.hostRegex: invalid regex"); } }

  // network
  const n = r.network;
  if (!isObj(n)) return { ok: false, errors: [...errors, "network: must be an object"] };
  onlyKeys(n, ["blockDomains", "blockUrlFilters", "thirdPartyAllowlist", "protectedHosts"], "network");
  const blockDomains = strList(n.blockDomains, "network.blockDomains", { re: DOMAIN_RE });
  const filters = strList(n.blockUrlFilters, "network.blockUrlFilters", { max: 200, re: PATH_RE, maxLen: 200 });
  const protectedHosts = strList(n.protectedHosts, "network.protectedHosts", { min: 1, re: DOMAIN_RE });
  let frameHosts = [];
  if (!isObj(n.thirdPartyAllowlist)) err("network.thirdPartyAllowlist: must be an object");
  else {
    onlyKeys(n.thirdPartyAllowlist, ["enabled", "frameHosts"], "network.thirdPartyAllowlist");
    bool(n.thirdPartyAllowlist.enabled, "network.thirdPartyAllowlist.enabled");
    frameHosts = strList(n.thirdPartyAllowlist.frameHosts, "network.thirdPartyAllowlist.frameHosts", { re: DOMAIN_RE });
  }

  // cosmetic
  const c = r.cosmetic;
  if (!isObj(c)) err("cosmetic: must be an object");
  else {
    onlyKeys(c, ["hideSelectors", "zIndexThreshold"], "cosmetic");
    strList(c.hideSelectors, "cosmetic.hideSelectors", { max: 200, maxLen: 200 }).forEach((s, i) => {
      if (typeof s !== "string") return;
      const t = s.trim().toLowerCase();
      if (t.length < 2 || SELECTOR_BAD_CHARS.test(t)) err(`cosmetic.hideSelectors[${i}]: unsafe selector`);
      if (FORBIDDEN_SELECTORS.has(t)) err(`cosmetic.hideSelectors[${i}]: would hide the whole page`);
      if (FORBIDDEN_SELECTOR_PARTS.some((p) => t.includes(p))) err(`cosmetic.hideSelectors[${i}]: targets the comic reader`);
    });
    if (!Number.isInteger(c.zIndexThreshold) || c.zIndexThreshold < 100000 || c.zIndexThreshold > 2147483647) {
      err("cosmetic.zIndexThreshold: out of range");
    }
  }

  // script
  const s = r.script;
  let allowedScriptHosts = [];
  if (!isObj(s)) err("script: must be an object");
  else {
    onlyKeys(s, ["blockInlineScripts", "stripFallbackHandlers", "guardWindowOpen", "guardClickHijack",
      "allowedScriptHosts", "allowedOpenHosts"], "script");
    if (!Array.isArray(s.blockInlineScripts) || s.blockInlineScripts.length > 50) err("script.blockInlineScripts: bad");
    else s.blockInlineScripts.forEach((b, i) => {
      const w = `script.blockInlineScripts[${i}]`;
      if (!isObj(b)) return err(`${w}: must be an object`);
      for (const k of Object.keys(b)) if (!["name", "attrs", "textIncludesAny"].includes(k)) err(`${w}: unknown key "${k}"`);
      if (typeof b.name !== "string" || b.name.length > 50) err(`${w}.name: bad`);
      if (b.attrs !== undefined) {
        if (!isObj(b.attrs) || Object.keys(b.attrs).length > 5) err(`${w}.attrs: bad`);
        else for (const v of Object.values(b.attrs)) if (typeof v !== "string" || v.length > 100) err(`${w}.attrs: bad value`);
      }
      strList(b.textIncludesAny, `${w}.textIncludesAny`, { min: 1, max: 10, maxLen: 100 })
        .forEach((t, j) => { if (typeof t === "string" && t.length < 4) err(`${w}.textIncludesAny[${j}]: too short`); });
    });
    ["stripFallbackHandlers", "guardWindowOpen", "guardClickHijack"].forEach((k) => bool(s[k], `script.${k}`));
    allowedScriptHosts = strList(s.allowedScriptHosts, "script.allowedScriptHosts", { min: 1, re: DOMAIN_RE });
    strList(s.allowedOpenHosts, "script.allowedOpenHosts", { min: 1, re: DOMAIN_RE });
  }

  // ---- safety checks across sections ----
  const mustKeep = [...siteHosts, ...protectedHosts, ...allowedScriptHosts, ...frameHosts];
  for (const d of blockDomains) {
    // Blocking "x.com" also blocks every "*.x.com", so check both directions.
    const hit = mustKeep.find((h) => h === d || h.endsWith("." + d));
    if (hit) err(`network.blockDomains: "${d}" would block needed host "${hit}"`);
  }
  for (const f of filters) {
    if (typeof f === "string" && f.length < 8) err(`network.blockUrlFilters: "${f}" is too broad`);
    const hit = CRITICAL_PATHS.find((p) => p.includes(f) || f.startsWith(p));
    if (hit) err(`network.blockUrlFilters: "${f}" would block "${hit}"`);
  }

  return { ok: errors.length === 0, errors };
}

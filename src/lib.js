// Pure logic shared by the background script (no chrome.* calls here,
// so it can be unit-tested with Node).

// ---------- versions: "YYYY.MM.DD-N" ----------
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d{4})\.(\d{2})\.(\d{2})-(\d+)$/.exec(v || "");
    return m ? [+m[1], +m[2], +m[3], +m[4]] : [0, 0, 0, 0];
  };
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

// ---------- declarativeNetRequest rules ----------
// ID ranges: 1-99 core rules, 100 third-party allowlist, 1000+ learned hosts.
export const LEARNED_ID_START = 1000;

export function buildDnrRules(rules, learnedHosts = []) {
  const siteHosts = rules.site.hosts;
  const out = [];
  let id = 1;

  // 1. Known ad domains, only when requested from the comic site.
  if (rules.network.blockDomains.length) {
    out.push({
      id: id++, priority: 2, action: { type: "block" },
      condition: { requestDomains: rules.network.blockDomains, initiatorDomains: siteHosts }
    });
  }
  // 2. The site's own ad paths.
  for (const path of rules.network.blockUrlFilters) {
    out.push({
      id: id++, priority: 2, action: { type: "block" },
      condition: { urlFilter: path, requestDomains: siteHosts }
    });
  }
  // 3. Idea 1: third-party scripts/iframes are blocked unless allowlisted.
  //    Images, CSS and fonts are untouched so reading never breaks.
  const allow = rules.network.thirdPartyAllowlist;
  if (allow.enabled) {
    out.push({
      id: 100, priority: 1, action: { type: "block" },
      condition: {
        initiatorDomains: siteHosts,
        resourceTypes: ["script", "sub_frame"],
        excludedRequestDomains: [...new Set([...siteHosts, ...rules.script.allowedScriptHosts, ...allow.frameHosts])]
      }
    });
  }
  // 4. Idea 2: hosts learned on this device.
  if (learnedHosts.length) {
    out.push({
      id: LEARNED_ID_START, priority: 2, action: { type: "block" },
      condition: { requestDomains: learnedHosts, initiatorDomains: siteHosts }
    });
  }
  return out;
}

// ---------- local learning (idea 2) ----------
export const LEARN = {
  minDistinctPages: 2,              // seen on at least 2 different pages
  windowMs: 7 * 24 * 3600 * 1000,   // only recent detections count
  ttlMs: 7 * 24 * 3600 * 1000,      // a learned host expires 7 days after it was last seen
  maxHosts: 50
};

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ""; }
}

// Which host (if any) does a detection blame? Only script sources are learned,
// never the destination of a blocked popup (that could be any site).
export function blamedHost(d) {
  let info = {};
  try { info = JSON.parse(d.info) || {}; } catch (_) { return ""; }
  if (d.kind === "fallback-handler") return String(info.host || "").toLowerCase();
  if (d.kind === "main:click-listener" || d.kind === "main:window.open") {
    return /^https?:\/\//.test(info.by || "") ? hostOf(info.by) : "";
  }
  return "";
}

function isCovered(host, list) {
  return list.some((d) => host === d || host.endsWith("." + d));
}

// Returns the new learned state: { [host]: { firstSeen, lastSeen, pages } }.
export function learnHosts(detections, prevLearned, rules, now = Date.now()) {
  const keep = [
    ...rules.site.hosts, ...rules.network.protectedHosts,
    ...rules.script.allowedScriptHosts, ...rules.network.thirdPartyAllowlist.frameHosts
  ];
  const pagesByHost = new Map();
  for (const d of detections) {
    if (now - d.ts > LEARN.windowMs) continue;
    const h = blamedHost(d);
    if (!h || !h.includes(".")) continue;
    if (isCovered(h, keep)) continue;                          // guardrail: never learn needed hosts
    if (isCovered(h, rules.network.blockDomains)) continue;    // already blocked
    if (!pagesByHost.has(h)) pagesByHost.set(h, { pages: new Set(), lastSeen: 0 });
    const e = pagesByHost.get(h);
    e.pages.add(d.page);
    e.lastSeen = Math.max(e.lastSeen, d.ts);
  }

  const next = {};
  // keep previous entries that are still fresh (and still allowed by the current rules)
  for (const [h, e] of Object.entries(prevLearned || {})) {
    if (now - e.lastSeen < LEARN.ttlMs && !isCovered(h, keep)) next[h] = { ...e };
  }
  for (const [h, e] of pagesByHost) {
    if (next[h]) { next[h].lastSeen = Math.max(next[h].lastSeen, e.lastSeen); next[h].pages = Math.max(next[h].pages, e.pages.size); continue; }
    if (e.pages.size >= LEARN.minDistinctPages) next[h] = { firstSeen: now, lastSeen: e.lastSeen, pages: e.pages.size };
  }
  // cap: keep the most recently seen
  const hosts = Object.keys(next).sort((a, b) => next[b].lastSeen - next[a].lastSeen);
  for (const h of hosts.slice(LEARN.maxHosts)) delete next[h];
  return next;
}

// ---------- report (opens a pre-filled GitHub issue; nothing is sent automatically) ----------
export function buildReportUrl({ repo, extVersion, rulesVersion, learned, detections, now = Date.now() }) {
  const counts = {};
  const hosts = new Set();
  for (const d of detections) {
    if (now - d.ts > LEARN.windowMs) continue;
    counts[d.kind] = (counts[d.kind] || 0) + 1;
    const h = blamedHost(d);
    if (h) hosts.add(h);
  }
  const lines = [
    "**Automatic report from QQ Clean Reader** (please review before submitting)",
    "",
    `- Extension: ${extVersion}`,
    `- Rules: ${rulesVersion}`,
    "",
    "### Learned hosts on this device",
    ...(Object.keys(learned).length ? Object.entries(learned).map(([h, e]) => `- \`${h}\` (pages: ${e.pages})`) : ["- none"]),
    "",
    "### Blamed script hosts (last 7 days)",
    ...(hosts.size ? [...hosts].slice(0, 30).map((h) => `- \`${h}\``) : ["- none"]),
    "",
    "### Detections by type (last 7 days)",
    ...(Object.keys(counts).length ? Object.entries(counts).map(([k, v]) => `- ${k}: ${v}`) : ["- none"]),
    "",
    "### What did you see? (optional)",
    ""
  ];
  const title = `Report: ${hosts.size} suspicious host(s), rules ${rulesVersion}`;
  const body = lines.join("\n").slice(0, 6000);   // keep the URL under browser limits
  return `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

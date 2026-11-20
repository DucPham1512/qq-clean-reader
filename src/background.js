const BUNDLED_URL = chrome.runtime.getURL("rules/rules.json");
const MAX_DETECTIONS = 100;

async function loadBundledRules() {
  const res = await fetch(BUNDLED_URL);
  return res.json();
}

// Convert our rules format into declarativeNetRequest rules
function buildDnrRules(rules) {
  const siteHosts = rules.site.hosts;
  const out = [];
  let id = 1;

  // 1. Third-party ad domains, only when requested from the comic site
  if (rules.network.blockDomains.length) {
    out.push({
      id: id++,
      priority: 1,
      action: { type: "block" },
      condition: {
        requestDomains: rules.network.blockDomains,   // also matches subdomains
        initiatorDomains: siteHosts                   // don't affect other sites
      }
    });
  }

  // 2. The site's own ad paths (widget loader, ad API)
  for (const path of rules.network.blockUrlFilters) {
    out.push({
      id: id++,
      priority: 1,
      action: { type: "block" },
      condition: {
        urlFilter: path,
        requestDomains: siteHosts                     // st.truyenqqko.com included
      }
    });
  }
  return out;
}

async function applyRules(rules) {
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: old.map(r => r.id),     // replace everything at once
    addRules: buildDnrRules(rules)
  });
  await chrome.storage.local.set({ activeRules: rules });  // content.js reads this
  console.log("[QQ] applied rules", rules.version);
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await applyRules(await loadBundledRules());
  } catch (e) {
    console.error("[QQ] failed to apply rules", e);
  }
});

// ---------- detection log (input for step 6: local learning + reports) ----------
// Kept on this device only. Content scripts report what layers 3-4 caught.
let writeQueue = Promise.resolve();

function clean(value, max = 300) {
  return JSON.stringify(value ?? null).slice(0, max);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "qq-detect" || !sender.tab) return;
  const entry = {
    ts: Date.now(),
    kind: String(msg.kind).slice(0, 60),
    info: clean(msg.info),
    page: String(msg.page).slice(0, 200)
  };
  // Serialize writes so parallel messages don't overwrite each other.
  writeQueue = writeQueue.then(async () => {
    const { detections = [] } = await chrome.storage.local.get("detections");
    detections.push(entry);
    await chrome.storage.local.set({ detections: detections.slice(-MAX_DETECTIONS) });
  }).catch(e => console.error("[QQ] detection log failed", e));
});

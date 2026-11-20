const BUNDLED_URL = chrome.runtime.getURL("rules/rules.json");

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
  await chrome.storage.local.set({ activeRules: rules });  // content scripts read this in steps 3–4
  console.log("[QQ] applied rules", rules.version);
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await applyRules(await loadBundledRules());
  } catch (e) {
    console.error("[QQ] failed to apply rules", e);
  }
});
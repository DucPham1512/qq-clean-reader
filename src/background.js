// Background (service worker on Chrome, event page on Firefox). ES module.
import { REMOTE_RULES_URL, REPO, UPDATE_PERIOD_MIN, MAX_REMOTE_BYTES, MAX_DETECTIONS } from "./config.js";
import { validateRules } from "./validate.js";
import { compareVersions, buildDnrRules, learnHosts, buildReportUrl } from "./lib.js";

const TAG = "[QQ]";
const BUNDLED_URL = chrome.runtime.getURL("rules/rules.json");
const MANIFEST_HOSTS = ["truyenqqko.com"];           // covered by manifest content_scripts
const originFor = (h) => `*://*.${h}/*`;

// ===================== applying rules =====================

async function getState() {
  return chrome.storage.local.get(["activeRules", "remoteRules", "learned", "detections", "lastCheck"]);
}

// Apply rules + learned hosts to the network layer, store them for content scripts,
// and register content scripts on any extra (granted) site domains.
async function applyRules(rules) {
  const { learned = {} } = await chrome.storage.local.get("learned");
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: old.map((r) => r.id),
    addRules: buildDnrRules(rules, Object.keys(learned))
  });
  await chrome.storage.local.set({ activeRules: rules });
  // Non-critical extras: a failure here (e.g. an API missing on a mobile browser)
  // must not undo the network rules above.
  await syncExtraSiteScripts(rules).catch((e) => console.warn(TAG, "extra-domain scripts:", e.message));
  await updateBadge(rules).catch((e) => console.warn(TAG, "badge:", e.message));
  console.log(TAG, "applied rules", rules.version, "learned:", Object.keys(learned).length);
}

// Choose the newest valid rules: bundled vs. last good remote copy.
async function applyBest() {
  const bundled = await (await fetch(BUNDLED_URL)).json();
  const { remoteRules } = await chrome.storage.local.get("remoteRules");
  const best = remoteRules && validateRules(remoteRules).ok && compareVersions(remoteRules.version, bundled.version) > 0
    ? remoteRules : bundled;
  await applyRules(best);
  return best;
}

// ===================== step 5: remote updater =====================

async function checkForUpdate() {
  const result = { ts: Date.now(), status: "", version: "" };
  try {
    const res = await fetch(REMOTE_RULES_URL, { cache: "no-cache", credentials: "omit" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    if (text.length > MAX_REMOTE_BYTES) throw new Error("file too large");
    const remote = JSON.parse(text);

    const { ok, errors } = validateRules(remote);
    if (!ok) throw new Error("invalid rules: " + errors.slice(0, 3).join("; "));

    const { activeRules } = await chrome.storage.local.get("activeRules");
    result.version = remote.version;
    if (activeRules && compareVersions(remote.version, activeRules.version) <= 0) {
      result.status = "up-to-date";
    } else {
      try {
        await applyRules(remote);
        await chrome.storage.local.set({ remoteRules: remote });   // last good copy
        result.status = "updated";
      } catch (e) {
        // The browser refused the new rules: roll back to what worked before.
        if (activeRules) await applyRules(activeRules);
        throw new Error("apply failed, rolled back: " + e.message);
      }
    }
  } catch (e) {
    result.status = "error: " + e.message;
    console.warn(TAG, "update check failed:", e.message);
  }
  await chrome.storage.local.set({ lastCheck: result });
  return result;
}

// ===================== step 5: site moved to a new domain (option C) =====================

async function extraHosts(rules) {
  const extra = rules.site.hosts.filter((h) => !MANIFEST_HOSTS.includes(h));
  const granted = [], missing = [];
  for (const h of extra) {
    (await chrome.permissions.contains({ origins: [originFor(h)] }) ? granted : missing).push(h);
  }
  return { granted, missing };
}

// Content scripts for granted extra domains are registered at runtime.
async function syncExtraSiteScripts(rules) {
  const ids = ["qq-main-extra", "qq-iso-extra"];
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  const { granted } = await extraHosts(rules);
  if (!granted.length) return;
  const matches = granted.map(originFor);
  await chrome.scripting.registerContentScripts([
    { id: "qq-main-extra", matches, js: ["src/defaults.js", "src/main-world.js"], runAt: "document_start", world: "MAIN" },
    { id: "qq-iso-extra", matches, js: ["src/defaults.js", "src/content.js"], runAt: "document_start" }
  ]);
}

// "!" on the toolbar icon when the site has a domain we don't have permission for yet.
async function updateBadge(rules) {
  const { missing } = await extraHosts(rules);
  await chrome.action.setBadgeText({ text: missing.length ? "!" : "" });
  if (missing.length) await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
}

// ===================== step 6: detection log + local learning =====================

let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn).catch((e) => console.error(TAG, e)));

async function relearn() {
  const { detections = [], learned = {}, activeRules } = await getState();
  if (!activeRules) return;
  const next = learnHosts(detections, learned, activeRules);
  const changed = JSON.stringify(Object.keys(next).sort()) !== JSON.stringify(Object.keys(learned).sort());
  await chrome.storage.local.set({ learned: next });
  if (changed) {
    console.log(TAG, "learned hosts changed:", Object.keys(next));
    await applyRules(activeRules);
  }
}

function recordDetection(msg) {
  serial(async () => {
    const { detections = [] } = await chrome.storage.local.get("detections");
    detections.push({
      ts: Date.now(),
      kind: String(msg.kind).slice(0, 60),
      info: JSON.stringify(msg.info ?? null).slice(0, 300),
      page: String(msg.page).slice(0, 200)
    });
    await chrome.storage.local.set({ detections: detections.slice(-MAX_DETECTIONS) });
    await relearn();
  });
}

// ===================== messages (content scripts + popup) =====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  // From content scripts on the site
  if (msg.type === "qq-detect" && sender.tab) { recordDetection(msg); return; }

  // From the popup (an extension page: no sender.tab)
  if (sender.tab) return;
  const handlers = {
    "popup-status": async () => {
      const s = await getState();
      const rules = s.activeRules;
      return {
        extVersion: chrome.runtime.getManifest().version,
        rulesVersion: rules?.version,
        lastCheck: s.lastCheck || null,
        missingHosts: rules ? (await extraHosts(rules)).missing : [],
        learned: s.learned || {},
        detectionCount: (s.detections || []).length
      };
    },
    "check-update": () => checkForUpdate(),
    "hosts-granted": async () => { const r = (await getState()).activeRules; await applyRules(r); return true; },
    "clear-learned": () => serial(async () => {
      await chrome.storage.local.set({ learned: {}, detections: [] });
      await applyRules((await getState()).activeRules);
    }).then(() => true),
    "report-url": async () => {
      const s = await getState();
      return buildReportUrl({
        repo: REPO,
        extVersion: chrome.runtime.getManifest().version,
        rulesVersion: s.activeRules?.version,
        learned: s.learned || {},
        detections: s.detections || []
      });
    }
  };
  const h = handlers[msg.type];
  if (!h) return;
  h().then(sendResponse, (e) => sendResponse({ error: e.message }));
  return true;   // async response
});

// ===================== lifecycle =====================

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await applyBest();
    await chrome.alarms.create("qq-update", { delayInMinutes: 1, periodInMinutes: UPDATE_PERIOD_MIN });
  } catch (e) {
    console.error(TAG, "install setup failed", e);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  // Dynamic DNR rules persist, but registered content scripts may not on every browser.
  const { activeRules } = await chrome.storage.local.get("activeRules");
  if (activeRules) await syncExtraSiteScripts(activeRules).catch((e) => console.error(TAG, e));
  if (!(await chrome.alarms.get("qq-update"))) {
    await chrome.alarms.create("qq-update", { delayInMinutes: 1, periodInMinutes: UPDATE_PERIOD_MIN });
  }
});

chrome.alarms.onAlarm.addListener((a) => { if (a.name === "qq-update") checkForUpdate(); });

chrome.permissions.onAdded.addListener(async () => {
  const { activeRules } = await chrome.storage.local.get("activeRules");
  if (activeRules) await applyRules(activeRules);
});

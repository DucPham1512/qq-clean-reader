"use strict";
const $ = (id) => document.getElementById(id);
const ask = (type) => chrome.runtime.sendMessage({ type });
const t = (key, ...subs) => chrome.i18n.getMessage(key, subs);

// Fill static text from _locales/<lang>/messages.json.
document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString(chrome.i18n.getUILanguage()) : t("none");
}

async function render() {
  const s = await ask("popup-status");
  if (!s || s.error) { $("rules").textContent = t("statusError"); return; }

  $("ext").textContent = s.extVersion;
  $("rules").textContent = s.rulesVersion || "-";
  const st = s.lastCheck?.status || "";
  const stText = st === "updated" ? t("statusUpdated") : st === "up-to-date" ? t("statusUpToDate") : st ? t("statusError") : "";
  $("check").textContent = s.lastCheck ? `${fmtTime(s.lastCheck.ts)} (${stText})` : t("none");
  $("check").title = st;   // full error text on hover

  // New site domain waiting for permission (option C)
  $("move").hidden = !s.missingHosts.length;
  $("move-hosts").textContent = s.missingHosts.join(", ");
  $("grant").dataset.hosts = JSON.stringify(s.missingHosts);

  // Learned hosts (built with textContent: host names are untrusted data)
  const list = $("learned");
  list.replaceChildren();
  const entries = Object.entries(s.learned);
  $("learned-count").textContent = `(${entries.length})`;
  if (!entries.length) {
    const li = document.createElement("li");
    li.textContent = t("none");
    list.append(li);
  }
  for (const [host, e] of entries) {
    const li = document.createElement("li");
    li.textContent = `${host} — ${t("pages", String(e.pages))}`;
    list.append(li);
  }
}

// Must run directly in the click handler: browsers only allow permission
// requests during a user gesture.
$("grant").addEventListener("click", async () => {
  const hosts = JSON.parse($("grant").dataset.hosts || "[]");
  const granted = await chrome.permissions.request({ origins: hosts.map((h) => `*://*.${h}/*`) });
  if (granted) await ask("hosts-granted");
  render();
});

$("update").addEventListener("click", async () => {
  $("update").disabled = true;
  await ask("check-update");
  $("update").disabled = false;
  render();
});

$("report").addEventListener("click", async () => {
  const url = await ask("report-url");
  if (typeof url === "string") chrome.tabs.create({ url });
});

$("clear").addEventListener("click", async () => {
  await ask("clear-learned");
  render();
});

render();

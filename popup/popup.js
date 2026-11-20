"use strict";
const $ = (id) => document.getElementById(id);
const ask = (type) => chrome.runtime.sendMessage({ type });

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString("vi-VN") : "chưa có";
}

async function render() {
  const s = await ask("popup-status");
  if (!s || s.error) { $("rules").textContent = "lỗi"; return; }

  $("ext").textContent = s.extVersion;
  $("rules").textContent = s.rulesVersion || "-";
  const st = s.lastCheck?.status || "";
  const stText = st === "updated" ? "đã cập nhật" : st === "up-to-date" ? "đã mới nhất" : st ? "lỗi" : "";
  $("check").textContent = s.lastCheck ? `${fmtTime(s.lastCheck.ts)} (${stText})` : "chưa có";
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
    li.textContent = "chưa có";
    list.append(li);
  }
  for (const [host, e] of entries) {
    const li = document.createElement("li");
    li.textContent = `${host} — ${e.pages} trang`;
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

// Unit tests for the pure logic.  Run:  node tools/test.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { validateRules } from "../src/validate.js";
import { compareVersions, buildDnrRules, learnHosts, blamedHost, buildReportUrl, LEARN } from "../src/lib.js";

const rules = JSON.parse(readFileSync(new URL("../rules/rules.json", import.meta.url), "utf8"));
const clone = () => JSON.parse(JSON.stringify(rules));
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok -", name); };
const rejects = (mutate, why) => {
  const r = clone(); mutate(r);
  const { ok, errors } = validateRules(r);
  assert.equal(ok, false, "should reject: " + why);
  return errors;
};

// ---------- validation ----------
test("bundled rules are valid", () => assert.deepEqual(validateRules(rules), { ok: true, errors: [] }));
test("rejects unknown key", () => rejects((r) => { r.network.extra = 1; }, "unknown key"));
test("rejects wildcard domain", () => rejects((r) => r.network.blockDomains.push("*"), "wildcard"));
test("rejects blocking the site itself", () => rejects((r) => r.network.blockDomains.push("truyenqqko.com"), "site host"));
test("rejects blocking a parent of an image host", () => rejects((r) => r.network.blockDomains.push("truyenvua.com"), "image host"));
test("rejects a filter that blocks main.js", () => rejects((r) => r.network.blockUrlFilters.push("/template/frontend/js/"), "critical path"));
test("rejects too-broad filter", () => rejects((r) => r.network.blockUrlFilters.push("/a/"), "broad"));
test("rejects selector hiding the page", () => rejects((r) => r.cosmetic.hideSelectors.push("body"), "body"));
test("rejects selector hiding the comic", () => rejects((r) => r.cosmetic.hideSelectors.push(".page-chapter img"), "reader"));
test("rejects CSS injection", () => rejects((r) => r.cosmetic.hideSelectors.push("a{color:red}"), "css injection"));
test("rejects non-boolean switch", () => rejects((r) => { r.script.guardWindowOpen = "yes"; }, "boolean"));
test("rejects bad version", () => rejects((r) => { r.version = "latest"; }, "version"));

// ---------- versions ----------
test("compareVersions", () => {
  assert.equal(compareVersions("2026.11.20-10", "2026.11.20-2"), 1);
  assert.equal(compareVersions("2026.11.19-9", "2026.11.20-1"), -1);
  assert.equal(compareVersions("2026.11.20-3", "2026.11.20-3"), 0);
});

// ---------- DNR rules ----------
test("buildDnrRules: core + allowlist + learned", () => {
  const out = buildDnrRules(rules, ["evil.example"]);
  const ids = out.map((r) => r.id);
  assert.deepEqual(ids, [1, 2, 3, 100, 1000]);
  assert.equal(new Set(ids).size, ids.length);
  const allow = out.find((r) => r.id === 100);
  assert.deepEqual(allow.condition.resourceTypes, ["script", "sub_frame"]);
  assert.ok(allow.condition.excludedRequestDomains.includes("ajax.googleapis.com"));
  assert.ok(allow.condition.excludedRequestDomains.includes("truyenqqko.com"));
  out.forEach((r) => assert.ok(r.condition.initiatorDomains || r.condition.requestDomains, "every rule scoped to the site"));
});
test("buildDnrRules: allowlist can be switched off", () => {
  const r = clone(); r.network.thirdPartyAllowlist.enabled = false;
  assert.ok(!buildDnrRules(r).some((x) => x.id === 100));
});

// ---------- learning ----------
const now = Date.now();
const det = (kind, info, page, ago = 1000) => ({ ts: now - ago, kind, info: JSON.stringify(info), page });

test("blamedHost picks script sources only", () => {
  assert.equal(blamedHost(det("main:click-listener", { by: "https://bad.example/x.js" }, "/a")), "bad.example");
  assert.equal(blamedHost(det("main:window.open", { url: "https://bit.ly/x", by: "inline/eval" }, "/a")), "");
  assert.equal(blamedHost(det("fallback-handler", { host: "rand.in" }, "/a")), "rand.in");
  assert.equal(blamedHost(det("overlay", { tag: "DIV" }, "/a")), "");
});
test("learns a host seen on 2+ pages", () => {
  const d = [det("main:click-listener", { by: "https://bad.example/x.js" }, "/a"),
             det("main:click-listener", { by: "https://bad.example/x.js" }, "/b")];
  assert.deepEqual(Object.keys(learnHosts(d, {}, rules, now)), ["bad.example"]);
});
test("does not learn from a single page", () => {
  const d = [det("main:click-listener", { by: "https://bad.example/x.js" }, "/a"),
             det("main:click-listener", { by: "https://bad.example/x.js" }, "/a")];
  assert.deepEqual(learnHosts(d, {}, rules, now), {});
});
test("never learns protected / site / allowed hosts", () => {
  const hosts = ["https://st.truyenqqko.com/js/a.js", "https://i178.truyenvua.com/x.js", "https://ajax.googleapis.com/j.js"];
  const d = hosts.flatMap((u) => [det("main:click-listener", { by: u }, "/a"), det("main:click-listener", { by: u }, "/b")]);
  assert.deepEqual(learnHosts(d, {}, rules, now), {});
});
test("learned hosts expire after the TTL", () => {
  const prev = { "old.example": { firstSeen: 0, lastSeen: now - LEARN.ttlMs - 1, pages: 3 } };
  assert.deepEqual(learnHosts([], prev, rules, now), {});
});
test("learned hosts are capped", () => {
  const d = [];
  for (let i = 0; i < 60; i++) for (const p of ["/a", "/b"]) d.push(det("fallback-handler", { host: `r${i}.in` }, p, i));
  assert.equal(Object.keys(learnHosts(d, {}, rules, now)).length, LEARN.maxHosts);
});

// ---------- report ----------
test("report URL is a GitHub issue without page paths", () => {
  const d = [det("main:click-listener", { by: "https://bad.example/x.js" }, "/truyen-tranh/secret-chap-1")];
  const url = buildReportUrl({ repo: "u/r", extVersion: "0.3.0", rulesVersion: rules.version, learned: {}, detections: d, now });
  assert.ok(url.startsWith("https://github.com/u/r/issues/new?"));
  const body = decodeURIComponent(url.split("body=")[1]);
  assert.ok(body.includes("bad.example"));
  assert.ok(!body.includes("secret-chap"), "no reading history in the report");
});

console.log(`\n${passed} tests passed`);

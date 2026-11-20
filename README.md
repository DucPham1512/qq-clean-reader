# QQ Clean Reader

Browser extension that blocks gambling ads and redirects on TruyenQQ.

## Layers
| Layer | File | What it does |
|---|---|---|
| 1. Network | `src/background.js` + `src/lib.js` | Blocks known ad domains/paths; blocks third-party scripts and iframes not on the allowlist |
| 2. Cosmetic | `src/content.js` | Hides ad containers, fixed overlays, footer gambling links |
| 3. Script | `src/content.js`, `src/main-world.js` | Disables the inline ad loader, guards `window.open` and click hijacks |
| 4. Updater | `src/background.js`, `src/validate.js` | Fetches `rules/rules.json` from GitHub every 6 h, validates it, applies it, rolls back on failure |
| 5. Learning | `src/lib.js` | Learns ad hosts from what layers 2–3 catch (this device only), with guardrails |

## Editing rules
1. Edit `rules/rules.json` and bump `version` (`YYYY.MM.DD-N`).
2. `node tools/build-defaults.mjs` (regenerates `src/defaults.js`)
3. `node tools/test.mjs` (must pass)
4. Push to `main`: installed extensions pick it up within 6 hours (or via "Kiểm tra cập nhật" in the popup).

The remote URL is set in `src/config.js`.

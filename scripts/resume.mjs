#!/usr/bin/env node
// CONTINUITY CHECK — run `npm run resume` at the START of every new agent session.
// Prints masked state only (never full tokens/keys). Exit 0 = ready to serve/test.
import fs from "fs";
import path from "path";

const root = process.cwd();
const port = process.env.PORT || 3000;
const mask = (s) => (s && s.length > 12 ? `${s.slice(0, 8)}****${s.slice(-4)}` : "****");
const say = (k, v) => console.log(`[resume] ${k}: ${v}`);

say("node", process.version);
say("deps", fs.existsSync(path.join(root, "node_modules")) ? "installed" : "MISSING -> npm install");

let store = { users: [], keys: [], accounts: [] };
try { store = JSON.parse(fs.readFileSync(path.join(root, "data/api-store.json"), "utf8")); } catch {}
const envToken = fs.existsSync(path.join(root, ".env")) &&
  /^PUTER_AUTH_TOKEN=.+/m.test(fs.readFileSync(path.join(root, ".env"), "utf8"));
say("puter_accounts", `${store.accounts?.length || 0}${envToken ? " (+ .env token)" : ""}`);
(store.accounts || []).forEach((a) => say("  account", `${a.label || a.id} token=${mask(a.token)} added=${a.addedAt || "?"}`));
say("api_keys", `${store.keys?.length || 0}`);
(store.keys || []).slice(0, 5).forEach((k) => say("  key", `${k.label || k.id} secret=${k.secret ? mask(k.secret) : "(no secret stored)"}`));

try {
  const r = await fetch(`http://127.0.0.1:${port}/health`);
  say("server", r.ok ? `UP on :${port}` : `responded ${r.status}`);
} catch { say("server", `DOWN -> npm start (or npm run dev)`); }

const hasAccount = (store.accounts?.length || 0) > 0 || envToken;
const hasKey = (store.keys || []).some((k) => k.secret);
if (!hasAccount) say("NEXT", "Open the hosted page -> Sign In With Puter (token auto-saved to data/api-store.json)");
else if (!hasKey) say("NEXT", "Open the hosted page -> Keys tab -> create an sk-... key");
else say("NEXT", `Ready. Test: POST /v1/chat/completions model="fugu" or "claude-5.6" (aliases auto-resolve)`);
console.log("[resume] Full handoff: see CONTINUITY.md");

#!/usr/bin/env node
// Observer: waits for the user to Sign In With Puter on the hosted page.
// On connection: mints an sk- key for that user (same format/hash as POST /v1/keys),
// saves a masked receipt to data/connection-receipt.json, prints masked status only.
import crypto from "crypto";
import fs from "fs";
import path from "path";

const storePath = path.join(process.cwd(), "data", "api-store.json");
const receiptPath = path.join(process.cwd(), "data", "connection-receipt.json");
const mask = (s) => (s && s.length > 12 ? `${s.slice(0, 8)}****${s.slice(-4)}` : "****");
const load = () => { try { return JSON.parse(fs.readFileSync(storePath, "utf8")); } catch { return { users: [], keys: [], accounts: [] }; } };
const randomChars = (n) => { const a = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; const b = crypto.randomBytes(n); let o = ""; for (let i = 0; i < n; i++) o += a[b[i] % a.length]; return o; };

const deadline = Date.now() + Number(process.env.OBSERVE_SECONDS || 1500) * 1000;
console.log("[observer] aguardando login na pagina hospedada (Sign In With Puter)...");
while (Date.now() < deadline) {
  const store = load();
  const user = (store.users || [])[0];
  const account = (store.accounts || [])[0];
  if (user?.puterToken || account?.token) {
    const userId = user?.id || "bootstrap";
    let key = (store.keys || []).find((k) => k.userId === userId && !k.revokedAt && k.value);
    if (!key) {
      const value = `sk-${randomChars(6)}${randomChars(6)}${randomChars(6)}${randomChars(6)}`;
      key = { id: `key_${crypto.randomUUID()}`, userId, name: "auto-observer", prefix: value.slice(0, 10),
        value, hash: crypto.createHash("sha256").update(value).digest("hex"),
        createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null };
      store.keys.push(key); fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
    }
    const receipt = { connectedAt: new Date().toISOString(), username: user?.username || account?.label || "?",
      puterToken: mask(user?.puterToken || account?.token), apiKey: mask(key.value), apiKeyId: key.id, source: "observer" };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    console.log(`[observer] CONECTADO user=${receipt.username} token=${receipt.puterToken} key=${receipt.apiKey}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 4000));
}
console.log("[observer] TIMEOUT sem login. Rode de novo: node scripts/observe-connection.mjs");
process.exit(2);

try { var { JSDOM } = await import("jsdom"); } catch { console.error("Instale a sonda: npm i -D jsdom"); process.exit(2); }
const html = await (await fetch("http://127.0.0.1:3000/")).text();
const errors = [];
const dom = new JSDOM(html, {
  url: "http://127.0.0.1:3000/",
  runScripts: "dangerously",
  resources: "usable", // tries js.puter.com like a real browser; sandbox likely blocks it = worst case
  pretendToBeVisual: true,
  beforeParse(window) {
    window.EventSource = class { addEventListener() {} close() {} };
    window.fetch = async (p) => ({ ok: false, status: 401, json: async () => ({ error: { message: "Sign in required." } }) });
    window.addEventListener("error", (e) => errors.push(e.message));
  },
});
await new Promise((r) => setTimeout(r, 4000));
const d = dom.window.document;
const out = {
  clientRendered: d.documentElement.dataset.clientRendered || null,
  renderStatus: d.getElementById("renderStatus")?.textContent,
  title: d.querySelector("h1")?.textContent,
  sessionPill: d.getElementById("sessionPill")?.textContent,
  authStatus: d.getElementById("authStatus")?.textContent,
  tabs: d.querySelectorAll("[data-tab-target]").length,
  panels: d.querySelectorAll("[data-tab-panel]").length,
  errors,
};
// interatividade: trocar de aba
d.querySelector('[data-tab-target="keys"]').click();
out.activePanelAfterClick = d.querySelector("[data-tab-panel].is-active")?.dataset.tabPanel;
// clique Sign In SEM puter.js carregado -> deve mostrar erro amigavel, nao travar
d.getElementById("signInBtn").click();
await new Promise((r) => setTimeout(r, 500));
out.signInStatusWithoutPuter = d.getElementById("authStatus")?.textContent;
console.log(JSON.stringify(out, null, 2));
const pass = out.clientRendered === "true" && out.activePanelAfterClick === "keys" && /Puter\.js/.test(out.signInStatusWithoutPuter || "");
console.log(pass ? "RENDER-PROBE: PASS" : "RENDER-PROBE: FAIL");
process.exit(pass ? 0 : 1);

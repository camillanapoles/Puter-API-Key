// Prova de renderização no cliente.
// Simula um navegador (jsdom) contra a página servida pelo gateway local e
// verifica o pior caso: CDN do Puter inacessível.
// Uso: npm run probe:render  (requer o servidor rodando em http://127.0.0.1:3000)
import jsdom from "jsdom";

const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;

const target = process.argv[2] || "http://127.0.0.1:3000/";

const virtualConsole = new VirtualConsole();
const consoleErrors = [];
virtualConsole.on("jsdomError", (error) => consoleErrors.push(error.message));
virtualConsole.on("error", (...args) => consoleErrors.push(args.join(" ")));

const dom = await JSDOM.fromURL(target, {
  runScripts: "dangerously",
  resources: {
    interceptors: [
      requestInterceptor((request) => {
        // Bloqueia o CDN do Puter de propósito: a página tem que renderizar mesmo assim.
        if (String(request.url).includes("js.puter.com")) {
          return new Response("", { status: 503 });
        }
        return undefined;
      })
    ]
  },
  pretendToBeVisual: true,
  virtualConsole
});

await new Promise((resolve) => {
  if (dom.window.document.readyState === "complete") return resolve();
  dom.window.addEventListener("load", resolve);
  setTimeout(resolve, 8000);
});
// Dá tempo do boot assíncrono (probeGateway, ensurePuter, markClientRendered).
await new Promise((resolve) => setTimeout(resolve, 5000));

const { document } = dom.window;
const result = {
  clientRendered: document.documentElement.dataset.clientRendered || "false",
  renderStatus: document.getElementById("renderStatus")?.textContent?.trim() || "",
  tabs: document.querySelectorAll("[data-tab-target]").length,
  panels: document.querySelectorAll("[data-tab-panel]").length,
  clientModeVisible:
    dom.window.getComputedStyle(document.getElementById("clientModeBox")).display !== "none",
  errors: consoleErrors.filter(
    (message) => !/js\.puter\.com|Not implemented|Could not load (style|script|css)/i.test(message)
  )
};

// Interatividade: clicar numa aba precisa trocá-la.
const playgroundTab = [...document.querySelectorAll("[data-tab-target]")].find(
  (button) => button.dataset.tabTarget === "playground"
);
playgroundTab?.click();
result.playgroundActiveAfterClick = Boolean(
  document.querySelector('[data-tab-panel="playground"]')?.classList.contains("is-active")
);

// Botão de login sem o CDN carregado precisa dar erro tratado, não travar.
document.getElementById("signInBtn")?.click();
await new Promise((resolve) => setTimeout(resolve, 1000));
result.signInFeedback = document.getElementById("authStatus")?.textContent?.trim() || "";

const pass =
  result.clientRendered === "true" &&
  result.tabs === result.panels &&
  result.tabs > 0 &&
  result.playgroundActiveAfterClick === true &&
  result.errors.length === 0;

console.log(JSON.stringify(result, null, 2));
console.log(pass ? "RENDER-PROBE: PASS" : "RENDER-PROBE: FAIL");
dom.window.close();
process.exit(pass ? 0 : 1);

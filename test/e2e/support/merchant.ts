/** A merchant page on another origin (http://localhost:<port>) that frames the embedded checkout. */
import { createServer, type Server } from "node:http";

export class MerchantSite {
  private server: Server | null = null;
  port = 0;
  iframeSrc = "";
  get origin() {
    return `http://localhost:${this.port}`;
  }
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      if (!req.url?.startsWith("/shop")) {
        res.writeHead(404).end();
        return;
      }
      const target = new URL(this.iframeSrc).origin;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body><h1>Shop</h1>
<iframe id="np" src="${this.iframeSrc}" sandbox="allow-scripts allow-same-origin allow-popups allow-forms" allow="clipboard-write" style="width:460px;height:200px;border:0"></iframe>
<script>
  window.__msgs = [];
  const frame = document.getElementById("np");
  let ready = false;
  window.addEventListener("message", (e) => {
    if (e.origin !== ${JSON.stringify(target)} || e.source !== frame.contentWindow) return;
    window.__msgs.push(e.data);
    if (e.data && e.data.type === "np:ready") ready = true;
    if (e.data && e.data.type === "np:resize") frame.style.height = e.data.height + "px";
  });
  const init = () => frame.contentWindow.postMessage({ type: "np:init", v: 1, appearance: { theme: "dark", accent: "#ff5500", radius: 4 }, locale: "en" }, ${JSON.stringify(target)});
  frame.addEventListener("load", () => {
    let n = 0;
    const t = setInterval(() => { if (ready || ++n > 40) return clearInterval(t); init(); }, 250);
    init();
  });
</script></body></html>`);
    });
    await new Promise<void>((r) => this.server?.listen(0, "127.0.0.1", r));
    const a = this.server.address();
    this.port = typeof a === "object" && a ? a.port : 0;
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}

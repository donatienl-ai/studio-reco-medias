"use strict";
/* Studio reco médias OpenMedias – serveur pour Render.
   Sert la page, et remplace les fonctions de claude.ai :
   Claude (API Anthropic), stockage partagé, fichiers importés, accès administrateur. */
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const createStore = require("./store");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("om-reco:" + ADMIN_PASSWORD).digest("hex");
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const API_BASE = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
const MODELS = {default: process.env.CLAUDE_MODEL || "claude-sonnet-5", quick: process.env.CLAUDE_MODEL_QUICK || "claude-haiku-4-5"};
const MAX_TOKENS = +process.env.CLAUDE_MAX_TOKENS || 8000;
const RATE = +process.env.SAMPLE_RATE_LIMIT || 60;          // appels Claude par heure et par adresse IP
const PAGE_ID = "__page_index__";
const SHIM = '<script src="/claude-shim.js"></script>';

const store = createStore();
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

/* ---------- accès au site (facultatif) */
app.get("/healthz", (req, res) => res.json({ok: true}));
app.use((req, res, next) => {
  if (!SITE_PASSWORD) return next();
  const h = req.headers.authorization || "";
  const pass = h.startsWith("Basic ") ? Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":") : "";
  if (safeEq(pass, SITE_PASSWORD)) return next();
  res.set("WWW-Authenticate", 'Basic realm="Studio reco medias", charset="UTF-8"').status(401).send("Accès réservé : saisissez le mot de passe du studio.");
});

/* ---------- session administrateur */
function safeEq(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y) && String(a) === String(b);
}
const sign = v => crypto.createHmac("sha256", SECRET).update(v).digest("base64url");
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const m = /(?:^|;\s*)om_admin=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split(".");
  return !!exp && !!sig && +exp > Date.now() && safeEq(sig, sign(exp));
}
function setAdminCookie(req, res, on) {
  const exp = String(Date.now() + 30 * 864e5);
  const secure = req.secure ? "; Secure" : "";
  res.set("Set-Cookie", on ? `om_admin=${encodeURIComponent(exp + "." + sign(exp))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}`
    : `om_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}
const needAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(403).json({code: "not_granted", message: "Réservé à l’administrateur."});
const needXhr = (req, res, next) => req.get("X-OM") === "1" ? next() : res.status(400).json({code: "invalid_argument", message: "En-tête manquant."});

/* ---------- la page */
let pageCache = null;
async function loadPage() {
  if (pageCache) return pageCache;
  let html = null;
  const b = await store.getBlob(PAGE_ID);
  if (b) html = b.data.toString("utf8");
  else {
    const f = path.join(__dirname, "public", "index.html");
    if (fs.existsSync(f)) html = fs.readFileSync(f, "utf8");
  }
  if (html == null) return null;
  html = html.includes(SHIM) ? html : /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + "\n" + SHIM) : SHIM + html;
  pageCache = html;
  return html;
}
app.get(["/", "/index.html"], async (req, res, next) => {
  try {
    const html = await loadPage();
    res.set("Cache-Control", "no-store");
    if (html) return res.type("html").send(html);
    res.type("html").send(shell("Studio reco médias", `<p>La page n’est pas encore installée.</p><p><a class="btn" href="/admin">Installer la page</a></p>`));
  } catch (e) { next(e); }
});
app.get("/claude-shim.js", (req, res) => res.set("Cache-Control", "no-cache").sendFile(path.join(__dirname, "public", "claude-shim.js")));

/* ---------- stockage partagé (config/offres, config/sources) */
const docPath = p => /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/.test(p) ? p : null;
app.get("/api/me", (req, res) => res.json({admin: isAdmin(req)}));
app.get("/api/doc/*p", async (req, res, next) => {
  try {
    const p = docPath([].concat(req.params.p).join("/")); if (!p) return res.status(400).json({code: "invalid_argument"});
    const d = await store.getDoc(p);
    res.set("Cache-Control", "no-store");
    d == null ? res.status(404).json({code: "not_found"}) : res.json(d);
  } catch (e) { next(e); }
});
app.put("/api/doc/*p", needXhr, needAdmin, express.json({limit: "5mb"}), async (req, res, next) => {
  try {
    const p = docPath([].concat(req.params.p).join("/")); if (!p) return res.status(400).json({code: "invalid_argument"});
    await store.setDoc(p, req.body); res.json({ok: true});
  } catch (e) { next(e); }
});

/* ---------- fichiers importés (sources de la base médias) */
app.post("/api/assets", needXhr, needAdmin, express.raw({type: () => true, limit: "25mb"}), async (req, res, next) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({code: "invalid_argument"});
    const id = "a" + crypto.randomBytes(12).toString("hex");
    await store.putBlob(id, req.get("Content-Type") || "application/octet-stream", req.body);
    res.json({id});
  } catch (e) { next(e); }
});
app.delete("/api/assets/:id", needXhr, needAdmin, async (req, res, next) => {
  try { if (/^a[0-9a-f]{24}$/.test(req.params.id)) await store.delBlob(req.params.id); res.json({ok: true}); } catch (e) { next(e); }
});
app.get("/_blob/:id", async (req, res, next) => {
  try {
    if (!/^a[0-9a-f]{24}$/.test(req.params.id)) return res.status(404).end();
    const b = await store.getBlob(req.params.id);
    if (!b) return res.status(404).end();
    res.set("Cache-Control", "no-cache").type(b.type).send(b.data);
  } catch (e) { next(e); }
});

/* ---------- Claude */
const hits = new Map();
function limited(ip) {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  if (a.length >= RATE) { hits.set(ip, a); return true; }
  a.push(now); hits.set(ip, a); return false;
}
const SYSTEM = "Tu réponds uniquement avec du JSON valide, sans texte avant ni après, sans bloc de code.";
function parseJson(text) {
  const t = String(text || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try { return JSON.parse(t); } catch (e) {}
  const s = t.search(/[[{]/), e = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
  throw new Error("réponse non JSON");
}
async function askClaude(prompt, tier, attempt = 0) {
  const r = await fetch(API_BASE + "/v1/messages", {
    method: "POST", signal: AbortSignal.timeout(180e3),
    headers: {"content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01"},
    body: JSON.stringify({model: MODELS[tier], max_tokens: MAX_TOKENS, system: SYSTEM, messages: [{role: "user", content: prompt}]})
  });
  if ((r.status === 529 || r.status >= 500) && attempt < 1) { await new Promise(ok => setTimeout(ok, 1500)); return askClaude(prompt, tier, attempt + 1); }
  if (!r.ok) { const err = new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`); err.status = r.status; throw err; }
  const j = await r.json();
  return parseJson((j.content || []).filter(b => b.type === "text").map(b => b.text).join(""));
}
app.post("/api/sample", needXhr, express.json({limit: "1mb"}), async (req, res) => {
  if (!API_KEY) return res.status(503).json({code: "capability_disabled", message: "Clé API Anthropic non configurée."});
  const prompt = req.body && typeof req.body.prompt === "string" ? req.body.prompt : "";
  if (!prompt || prompt.length > 200000) return res.status(400).json({code: "invalid_argument"});
  if (limited(req.ip)) return res.status(429).json({code: "rate_limited", message: "Trop de demandes, réessayez plus tard."});
  const tier = req.body.modelTier === "quick" ? "quick" : "default";
  try { res.json({data: await askClaude(prompt, tier)}); }
  catch (e) {
    console.error("[sample]", e.message);
    const s = e.status;
    if (s === 429 || s === 529) return res.status(429).json({code: "rate_limited"});
    if (s === 401 || s === 403) return res.status(503).json({code: "capability_disabled", message: "Clé API Anthropic refusée."});
    res.status(502).json({code: "internal", message: "Réponse de Claude inexploitable."});
  }
});

/* ---------- administration */
function shell(title, body) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#F4F5FA;color:#111137}
header{background:#111137;color:#fff;padding:16px 28px;font:400 22px Georgia,serif}main{max-width:640px;margin:36px auto;padding:0 20px}
h1{font:400 30px/1.15 Georgia,serif;margin:0 0 14px}.card{background:#fff;border:1px solid #DADBE8;border-radius:10px;padding:22px;margin:0 0 18px}
input[type=password],input[type=file]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #C9CADB;border-radius:8px;font:inherit;margin:6px 0 12px;background:#fff}
.btn,button{display:inline-block;background:#3b3bfa;color:#fff;border:0;border-radius:8px;padding:10px 16px;font:600 14px system-ui,sans-serif;text-decoration:none;cursor:pointer}
button.ghost{background:transparent;color:#111137;border:1px solid #C9CADB}dl{display:grid;grid-template-columns:170px 1fr;gap:6px 14px;margin:0}dt{color:#5A5A7A}dd{margin:0}
.ok{color:#1E7A4F}.ko{color:#B4231A}#msg{min-height:1.5em;font-weight:600}</style></head><body><header>OpenMedias</header><main>${body}</main></body></html>`;
}
const escH = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
app.get("/admin", async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    if (!ADMIN_PASSWORD) return res.type("html").send(shell("Administration", `<h1>Administration</h1><div class="card"><p class="ko">La variable ADMIN_PASSWORD n’est pas définie sur Render.</p></div>`));
    if (!isAdmin(req)) return res.type("html").send(shell("Administration", `<h1>Administration</h1><div class="card"><form method="post" action="/admin/login">
      <label for="p">Mot de passe administrateur</label><input id="p" name="password" type="password" autocomplete="current-password" autofocus required>
      ${req.query.e ? `<p class="ko">Mot de passe incorrect.</p>` : ""}<button type="submit">Se connecter</button></form></div>`));
    const own = await store.getBlob(PAGE_ID), file = fs.existsSync(path.join(__dirname, "public", "index.html"));
    const src = own ? `Déposée depuis cette page (${Math.round(own.data.length / 1024)} Ko)` : file ? "Fichier public/index.html du dépôt" : `<span class="ko">Aucune page installée</span>`;
    res.type("html").send(shell("Administration", `<h1>Administration</h1>
      <div class="card"><dl><dt>Page</dt><dd>${src}</dd><dt>Claude</dt><dd>${API_KEY ? `<span class="ok">Clé configurée</span> · ${escH(MODELS.default)} / ${escH(MODELS.quick)}` : `<span class="ko">ANTHROPIC_API_KEY manquante</span>`}</dd>
      <dt>Stockage</dt><dd>${store.kind === "postgres" ? `<span class="ok">Base Postgres</span>` : `<span class="ko">Fichiers locaux (${escH(store.where)}) : effacés à chaque redéploiement sur Render sans disque</span>`}</dd>
      <dt>Accès au studio</dt><dd>${SITE_PASSWORD ? "Protégé par mot de passe" : "Ouvert à toute personne qui a le lien"}</dd></dl></div>
      <div class="card"><h2 style="font:400 20px Georgia,serif;margin:0 0 8px">Mettre à jour la page</h2>
      <p style="margin:0 0 8px;color:#5A5A7A">Déposez le fichier HTML du Studio reco médias exporté depuis claude.ai. Il remplace la version en ligne.</p>
      <input type="file" id="f" accept=".html,text/html"><button type="button" id="up">Installer cette version</button><p id="msg"></p></div>
      <p><a class="btn" href="/">Ouvrir le studio</a> <button class="ghost" form="lo">Se déconnecter</button></p><form id="lo" method="post" action="/admin/logout"></form>
      <script>document.getElementById("up").onclick=async()=>{const f=document.getElementById("f").files[0],m=document.getElementById("msg");if(!f){m.textContent="Choisissez un fichier.";return}
      m.textContent="Envoi…";const r=await fetch("/admin/page",{method:"POST",headers:{"Content-Type":"text/html","X-OM":"1"},body:f,credentials:"same-origin"});const j=await r.json().catch(()=>({}));
      if(r.ok&&!j.warning){location.reload();return}m.textContent=r.ok?"Page installée ("+j.warning+").":"Échec : "+(j.message||r.status);}</script>`));
  } catch (e) { next(e); }
});
app.post("/admin/login", express.urlencoded({extended: false, limit: "10kb"}), (req, res) => {
  if (ADMIN_PASSWORD && safeEq((req.body && req.body.password) || "", ADMIN_PASSWORD)) { setAdminCookie(req, res, true); return res.redirect(303, "/admin"); }
  setTimeout(() => res.redirect(303, "/admin?e=1"), 800);
});
app.post("/admin/logout", (req, res) => { setAdminCookie(req, res, false); res.redirect(303, "/admin"); });
app.post("/admin/page", needXhr, needAdmin, express.raw({type: () => true, limit: "40mb"}), async (req, res, next) => {
  try {
    const html = req.body ? req.body.toString("utf8") : "";
    if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) return res.status(400).json({message: "Ce fichier n’est pas une page HTML complète."});
    await store.putBlob(PAGE_ID, "text/html", Buffer.from(html, "utf8"));
    pageCache = null;
    res.json({ok: true, warning: /id="db"/.test(html) ? "" : "la base médias intégrée n’a pas été trouvée dans ce fichier"});
  } catch (e) { next(e); }
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === "entity.too.large") return res.status(413).json({code: "too_large", message: "Fichier trop volumineux."});
  res.status(500).json({code: "internal", message: "Erreur serveur."});
});

store.ready.then(() => app.listen(PORT, () => console.log(`Studio reco médias sur le port ${PORT} (stockage : ${store.kind})`)))
  .catch(e => { console.error("Stockage indisponible", e); process.exit(1); });

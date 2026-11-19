"use strict";
/* Stockage : Postgres si DATABASE_URL est défini (recommandé sur Render), sinon fichiers dans DATA_DIR. */
const fs = require("fs");
const path = require("path");

module.exports = function createStore() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const {Pool} = require("pg");
    // Adresse interne Render (hôte sans domaine) ou locale : sans SSL ; adresse externe : SSL. PGSSL=on|off force le choix.
    let host = ""; try { host = new URL(url).hostname; } catch (e) {}
    const plain = process.env.PGSSL ? process.env.PGSSL === "off" : (!host.includes(".") || /^(localhost|127\.0\.0\.1)$/.test(host) || /sslmode=disable/.test(url));
    const pool = new Pool({connectionString: url, ssl: plain ? false : {rejectUnauthorized: false}, max: 5});
    const ready = pool.query(`CREATE TABLE IF NOT EXISTS om_docs (path text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS om_blobs (id text PRIMARY KEY, type text NOT NULL, data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now());`);
    return {
      kind: "postgres", where: "DATABASE_URL", ready,
      async getDoc(p) { const r = await pool.query("SELECT data FROM om_docs WHERE path = $1", [p]); return r.rows.length ? r.rows[0].data : null; },
      async setDoc(p, d) { await pool.query("INSERT INTO om_docs (path, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()", [p, JSON.stringify(d)]); },
      async putBlob(id, type, buf) { await pool.query("INSERT INTO om_blobs (id, type, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, data = EXCLUDED.data, created_at = now()", [id, type, buf]); },
      async getBlob(id) { const r = await pool.query("SELECT type, data FROM om_blobs WHERE id = $1", [id]); return r.rows[0] || null; },
      async delBlob(id) { await pool.query("DELETE FROM om_blobs WHERE id = $1", [id]); }
    };
  }
  const dir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
  const docs = path.join(dir, "docs"), blobs = path.join(dir, "blobs");
  const f = (d, k) => path.join(d, encodeURIComponent(k));
  const ready = Promise.all([fs.promises.mkdir(docs, {recursive: true}), fs.promises.mkdir(blobs, {recursive: true})]);
  const read = p => fs.promises.readFile(p).catch(e => { if (e.code === "ENOENT") return null; throw e; });
  async function write(p, data) { const t = p + ".tmp" + process.pid; await fs.promises.writeFile(t, data); await fs.promises.rename(t, p); }
  return {
    kind: "files", where: dir, ready,
    async getDoc(p) { const b = await read(f(docs, p)); return b ? JSON.parse(b.toString("utf8")) : null; },
    async setDoc(p, d) { await write(f(docs, p), JSON.stringify(d)); },
    async putBlob(id, type, buf) { await write(f(blobs, id), buf); await write(f(blobs, id) + ".type", type); },
    async getBlob(id) { const b = await read(f(blobs, id)); if (!b) return null; const t = await read(f(blobs, id) + ".type"); return {type: t ? t.toString() : "application/octet-stream", data: b}; },
    async delBlob(id) { await Promise.all([f(blobs, id), f(blobs, id) + ".type"].map(p => fs.promises.rm(p, {force: true}))); }
  };
};

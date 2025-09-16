// server.mjs
// SERPAVI scraper HTTP (Express + Playwright)
// - POST /  { rc, ascensor, planta, estado, etiqueta, aparcamiento?, amueblado?, dormitorios?, banos?, exterior? }
// - GET  /health
// - GET  /diag
// Devuelve: { ok:true, min, max, precio_ref, psqm, total, rc, via:"playwright" }  (o { ok:false, error, ...debug })

import express from "express";
import { chromium } from "playwright";

const app = express();

// --------- timeouts globales
app.use((req, res, next) => {
  req.setTimeout?.(70000);
  res.setTimeout?.(70000);
  next();
});

app.use(express.json({ limit: "1mb" }));

// --------- CORS
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});
app.options("*", (_, res) => res.sendStatus(204));

// =============================================
// Helpers numéricos / extracción
// =============================================
function eurToNum(s) {
  if (!s) return null;
  const v = Number(String(s).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(v) ? v : null;
}
function plausib(n) { return n != null && n >= 100 && n <= 20000; }
function plausibPsqm(n) { return n != null && n >= 2 && n <= 100; }

function sanitizeRange({ min, max, precio_ref }) {
  if (min != null && max != null && min > max) [min, max] = [max, min];
  if (min != null && !plausib(min)) min = null;
  if (max != null && !plausib(max)) max = null;
  if (precio_ref != null && !plausib(precio_ref)) precio_ref = null;
  return { min, max, precio_ref };
}

// Busca todos los €/m² y € sueltos dentro de un texto de resultados
function extractFromText(t) {
  const text = String(t || "").replace(/\s+/g, " ");

  // €/m²
  let psqm = null;
  const rxPsqm = /([\d]{1,3}(?:\.\d{3})*(?:,\d{1,2})?)\s*(?:€|euros?)\s*\/\s*m[²2]/i;
  const mPsqm = text.match(rxPsqm);
  if (mPsqm) psqm = eurToNum(mPsqm[1]);

  // Precio de referencia (si lo hubiera)
  let precio_ref = null;
  const refPatterns = [
    /precio\s+de\s+referencia[^\d€]*([\d\.\,]+)/i,
    /precio\s+referencia[^\d€]*([\d\.\,]+)/i,
    /precio\s+m[aá]ximo\s+de\s+referencia[^\d€]*([\d\.\,]+)/i,
    /referencia:\s*([\d\.\,]+)\s*(?:€|euros?)/i,
  ];
  for (const rx of refPatterns) {
    const m = text.match(rx);
    if (m) { precio_ref = eurToNum(m[1]); break; }
  }

  // Rango con “–”, “a”, “entre … y …”
  let min = null, max = null;
  const rangePatterns = [
    /rango[^0-9€]*([\d\.\,]+)\D+([\d\.\,]+)\s*(?:€|euros?)/i,
    /entre[^0-9€]*([\d\.\,]+)\D+([\d\.\,]+)\s*(?:€|euros?)/i,
    /([\d\.\,]+)\s*(?:€|euros?)\s*(?:a|-|–|—)\s*([\d\.\,]+)\s*(?:€|euros?)/i,
    /m[ií]nimo[^0-9€]*([\d\.\,]+)[^\d]+m[aá]ximo[^0-9€]*([\d\.\,]+)\s*(?:€|euros?)/i,
  ];
  for (const rx of rangePatterns) {
    const m = text.match(rx);
    if (m) { min = eurToNum(m[1]); max = eurToNum(m[2]); break; }
  }

  // Si no hay rango, intenta coger dos importes con € en orden ascendente
  if (min == null && max == null) {
    const all = [];
    const rxAll = /([\d]{2,3}(?:\.\d{3})*(?:,\d{1,2})?)\s*(?:€|euros?)/gi;
    let m;
    while ((m = rxAll.exec(text)) !== null) all.push(eurToNum(m[1]));
    const nums = all.filter(plausib).sort((a,b)=>a-b);
    if (nums.length >= 2) { min = nums[0]; max = nums[nums.length-1]; }
  }

  const san = sanitizeRange({ min, max, precio_ref });
  if (!plausibPsqm(psqm)) psqm = null;
  return { ...san, psqm };
}

function isOnSerpavi(urlStr) {
  try { return new URL(urlStr).hostname.includes("serpavi.mivau.gob.es"); } catch { return false; }
}

// =============================================
// Playwright helpers
// =============================================
async function acceptCookies(target) {
  const btns = [
    'button:has-text("Aceptar")',
    'button:has-text("Acepto")',
    'button:has-text("ACEPTAR")',
    '[id*="acept"]', '[id*="accept"]',
    'role=button[name=/acept|accept/i]',
    'text=/De acuerdo/i', 'text=/Aceptar cookies/i'
  ];
  for (const sel of btns) {
    try {
      const el = target.locator(sel).first();
      if (await el.count()) { await el.click({ timeout: 1000 }).catch(()=>{}); }
    } catch {}
  }
}

function getSerpaviFrame(page) {
  for (const f of page.frames()) {
    try { if (isOnSerpavi(f.url())) return f; } catch {}
  }
  return null;
}

async function gotoSerpavi(ctx) {
  let page = await ctx.newPage();
  await page.goto("https://serpavi.mivau.gob.es/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{});
  await acceptCookies(page).catch(()=>{});
  let target = getSerpaviFrame(page) ?? page;
  if (isOnSerpavi(target.url ? target.url() : page.url())) return { page, target };

  // página informativa → abrir app
  await page.goto("https://www.mivau.gob.es/vivienda/alquila-bien-es-tu-derecho/serpavi", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{});
  await acceptCookies(page).catch(()=>{});
  const link = page.locator('a[href*="serpavi.mivau.gob.es"], a:has-text("SERPAVI"), a:has-text("precio del alquiler")').first();
  if (await link.count()) {
    const [newPage] = await Promise.all([ctx.waitForEvent("page").catch(()=>null), link.click().catch(()=>{})]);
    const p = newPage || page;
    await p.waitForLoadState("domcontentloaded").catch(()=>{});
    await acceptCookies(p).catch(()=>{});
    target = getSerpaviFrame(p) ?? p;
    return { page: p, target };
  }
  return { page, target };
}

// Home: buscar por RC y abrir sugerencia
async function searchByRCOnHome(target, rc) {
  // input “Buscar vivienda / Introduzca referencia…”
  const input = target.locator(
    'input[placeholder*="Introduzca"][placeholder*="referencia" i], input[placeholder*="buscar" i], input[type="search"]'
  ).first();
  await input.waitFor({ timeout: 10000 });
  await input.fill(rc);
  await target.waitForTimeout?.(600);

  // esperar listbox y elegir primera sugerencia
  const list = target.locator('[role="listbox"], ul[role="listbox"]').first();
  await list.waitFor({ timeout: 8000 }).catch(()=>{});
  const firstOpt = target.locator('[role="option"], li[role="option"]').first();
  if (await firstOpt.count()) {
    await firstOpt.click({ timeout: 2000 }).catch(()=>{});
  } else {
    await input.press("Enter").catch(()=>{});
  }

  // esperar que cargue formulario (anclas típicas)
  await target.waitForSelector('text=/Municipio\\*/i', { timeout: 15000 });
}

// Buscar un control por label (select o input)
async function setSelectOrInput(target, labelRegex, value) {
  if (value == null || value === "") return;
  const sel = target.getByLabel(labelRegex, { exact: false }).first();
  if (!(await sel.count())) return;
  try {
    const tag = await sel.evaluate(el => el.tagName.toLowerCase());
    if (tag === "select") await sel.selectOption(String(value));
    else await sel.fill(String(value));
  } catch {}
}

// Radio/checkbox SÍ/NO por grupo
async function setRadioYesNo(target, labelRegex, yes) {
  if (yes == null) return;
  // checkboxes con label
  const chk = target.getByLabel(labelRegex, { exact:false }).first();
  if (await chk.count()) { if (yes) await chk.check().catch(()=>{}); else await chk.uncheck?.().catch(()=>{}); return; }

  // grupo de radios
  const group = target.getByRole("group", { name: labelRegex }).first();
  if (await group.count()) {
    const radio = group.getByRole("radio", { name: yes ? /s[ií]|yes/i : /no/i }).first();
    if (await radio.count()) await radio.check().catch(()=>{});
  }
}

// leer m² del propio formulario
async function readM2FromForm(target) {
  // 1) por etiqueta
  const lab = target.getByLabel(/superficie\s+construida/i).first();
  if (await lab.count()) {
    const v = await lab.inputValue().catch(()=>null);
    const n = Number(String(v||"").replace(/[^\d.,]/g,"").replace(",","."));
    if (Number.isFinite(n)) return n;
  }
  // 2) por texto
  const txt = await (target.evaluate
    ? target.evaluate(() => document.body.innerText || "")
    : Promise.resolve(""));
  const m = txt.match(/superficie\s+construida[^0-9]+([\d.,]+)/i);
  if (m) {
    const n = Number(m[1].replace(/\./g,"").replace(",","."));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// extrae resultados intentando contenedores “Precio/Rango/Resultado”
async function extractResults(target) {
  const candidates = [
    'section:has-text("Rango")',
    'section:has-text("Precio")',
    'div:has-text("Rango")',
    'div:has-text("Precio")',
    'main:has-text("Precio")',
    'main:has-text("Rango")'
  ];
  let min=null,max=null,precio_ref=null,psqm=null;

  for (const sel of candidates) {
    const el = target.locator(sel).first();
    if (await el.count()) {
      const txt = await el.evaluate(n=>n.innerText||"");
      const r = extractFromText(txt);
      if (r.psqm!=null && (psqm==null || r.psqm>psqm)) psqm = r.psqm;
      if (r.min!=null && (min==null || r.min<min)) min = r.min;
      if (r.max!=null && (max==null || r.max>max)) max = r.max;
      if (r.precio_ref!=null) precio_ref = r.precio_ref;
    }
  }

  if (min==null && max==null && precio_ref==null && psqm==null) {
    const full = await (target.evaluate
      ? target.evaluate(()=>document.body.innerText||"")
      : Promise.resolve(""));
    const r = extractFromText(full);
    min = r.min; max = r.max; precio_ref = r.precio_ref; psqm = r.psqm;
  }

  const out = sanitizeRange({ min, max, precio_ref });
  return { ...out, psqm: plausibPsqm(psqm) ? psqm : null };
}

// =============================================
// Rutas
// =============================================
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Diagnóstico simple de conectividad desde Render
app.get("/diag", async (_req, res) => {
  try {
    const hdrs = { "User-Agent":"Mozilla/5.0", "Accept-Language":"es-ES,es;q=0.9" };
    const a = await fetch("https://serpavi.mivau.gob.es/", { headers: hdrs, redirect:"follow" });
    const at = await a.text();
    const b = await fetch("https://www.mivau.gob.es/vivienda/alquila-bien-es-tu-derecho/serpavi", { headers: hdrs, redirect:"follow" });
    const bt = await b.text();
    res.json({
      ok: true,
      serpavi: { status: a.status, length: at.length, sample: at.slice(0,200) },
      info: { status: b.status, length: bt.length, sample: bt.slice(0,200) }
    });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.get("/", (_req, res) => {
  res.type("text/plain").send(
`SERPAVI scraper
POST /  { rc, ascensor, planta, estado, etiqueta, aparcamiento?, amueblado?, dormitorios?, banos?, exterior? }
→ { ok:true, min, max, precio_ref, psqm, total }`
  );
});

app.post("/", async (req, res) => {
  try {
    const {
      rc,
      ascensor, planta, estado, etiqueta,
      aparcamiento, amueblado, dormitorios, banos, exterior,
    } = req.body || {};

    if (!rc || !/^[A-Z0-9]{20}$/.test(String(rc))) {
      return res.status(400).json({ ok:false, error:"RC inválida (debe tener 20 caracteres alfanuméricos)" });
    }

    // Estos 4 ayudan a la exactitud en SERPAVI
    const required = { ascensor, planta, estado, etiqueta };
    const missing = Object.entries(required).filter(([_,v]) => v===undefined || v===null || v==="").map(([k])=>k);
    if (missing.length) {
      return res.status(200).json({ ok:true, needs: missing, hint: "Faltan atributos para completar el cálculo en SERPAVI" });
    }

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const ctx = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      locale: "es-ES",
      ignoreHTTPSErrors: true,
    });

    // Bloqueo de recursos pesados
    await ctx.route("**/*", (route) => {
      const req = route.request();
      const t = req.resourceType();
      const url = req.url();
      if (["image","font","media"].includes(t)) return route.abort();
      if (/analytics|googletag|gtm|hotjar|matomo|doubleclick|facebook|cook/i.test(url)) return route.abort();
      return route.continue();
    });

    const work = (async () => {
      // 1) Llegar a SERPAVI (home)
      const { page, target } = await Promise.race([
        gotoSerpavi(ctx),
        new Promise((_, rej) => setTimeout(()=>rej(new Error("SERPAVI_UNREACHABLE")), 25000))
      ]);
      page.setDefaultTimeout(15000);
      target.setDefaultTimeout?.(15000);
      await acceptCookies(target).catch(()=>{});

      // 2) Buscar por RC en el buscador de la home y abrir sugerencia
      await searchByRCOnHome(target, String(rc));

      // 3) Completar atributos manuales (si aparecen)
      await setSelectOrInput(target, /planta/i, planta);
      await setSelectOrInput(target, /estado/i, estado);
      const et = String(etiqueta || "").trim().toUpperCase();
      if (["A","B","C","D","E","F","G"].includes(et)) await setSelectOrInput(target, /etiqueta/i, et);

      await setRadioYesNo(target, /ascensor/i, !!ascensor);
      await setRadioYesNo(target, /(aparcamiento|parking)/i, !!aparcamiento);
      await setRadioYesNo(target, /amueblad[oa]/i, !!amueblado);
      await setRadioYesNo(target, /exterior/i, !!exterior);
      if (dormitorios != null) await setSelectOrInput(target, /dormitorios|habitaciones/i, dormitorios);
      if (banos != null)       await setSelectOrInput(target, /ba(ñ|n)os/i, banos);

      // 4) Calcular
      const btnCalc = target.locator('button:has-text("Calcular"), [role="button"]:has-text("Calcular"), button:has-text("Consultar"), [role="button"]:has-text("Consultar")').first();
      if (await btnCalc.count()) await btnCalc.click().catch(()=>{});
      await target.waitForLoadState?.("domcontentloaded", { timeout: 15000 }).catch(()=>{});
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(()=>{});
      await target.waitForTimeout?.(1200).catch(()=>{});

      // 5) Extraer resultados
      const r = await extractResults(target);

      // 6) Leer m² del formulario si hace falta para calcular total desde €/m²
      let m2 = null, total = null;
      if (r.psqm != null) {
        m2 = await readM2FromForm(target);
        if (m2 != null && m2 > 0) total = Math.round(r.psqm * m2);
      }

      if (r.min==null && r.max==null && r.precio_ref==null && r.psqm==null && total==null) {
        const cur = target.url ? target.url() : page.url();
        const sample = await (target.evaluate ? target.evaluate(()=>document.body.innerText||"") : page.evaluate(()=>document.body.innerText||""));
        return { ok:false, error:"UI_CHANGED", currentUrl: cur, sample: sample.slice(0,2000) };
      }

      return { ok:true, min:r.min, max:r.max, precio_ref:r.precio_ref, psqm:r.psqm, total, rc, via:"playwright" };
    })();

    const result = await Promise.race([
      work,
      new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT_GLOBAL_65s")), 65000))
    ]);

    if (result && result.ok) return res.json(result);
    if (result && result.ok === false) return res.status(200).json(result);
    return res.status(504).json({ ok:false, error:String(result || "timeout") });

  } catch (err) {
    console.error("FATAL:", err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SERPAVI scraper listening on", PORT));

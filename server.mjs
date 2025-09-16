// server.mjs
// SERPAVI scraper HTTP (Express + Playwright)
// - POST /  { rc, ascensor, planta, estado, etiqueta, aparcamiento?, amueblado?, dormitorios?, banos?, exterior?, m2? }
// - GET  /health
// - GET  /diag
// Respuesta: { ok:true, min, max, precio_ref, total, psqm, via:"playwright" }  (o { ok:false, error,… })

import express from "express";
import { chromium } from "playwright";

const app = express();

// ---------- timeouts globales
app.use((req, res, next) => { req.setTimeout?.(70000); res.setTimeout?.(70000); next(); });
app.use(express.json({ limit: "1mb" }));

// ---------- CORS
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
function plausible(x) { return x != null && x >= 100 && x <= 20000; }

function sanitizeRange({ min, max, precio_ref, total, psqm }, text) {
  if (min != null && max != null && min > max) [min, max] = [max, min];
  if (min != null && !plausible(min)) min = null;
  if (max != null && !plausible(max)) max = null;

  // si el texto menciona explícitamente “Precio de referencia”, prioriza ese número como total
  if ((total == null || !plausible(total)) && text && /precio\s+de\s+referencia/i.test(text)) {
    const m = text.match(/precio\s+de\s+referencia[^\d\u20AC]*([\d\.\,]+)/i);
    const v = m ? eurToNum(m[1]) : null;
    if (plausible(v)) total = v;
  }
  // si hay rango pero no total, usa media
  if (total == null && plausible(min) && plausible(max)) total = Math.round(((min + max) / 2) * 100) / 100;

  return { min, max, precio_ref, total, psqm };
}

// Busca listas de importes con € por si no hay etiquetas claras
function pickRangeFromText(text) {
  const nums = [];
  const rx = /([\d]{2,3}(?:\.\d{3})*(?:,\d{1,2})?)\s*(?:\u20AC|€|euros?|eur)(?!\s*\/\s*m(?:2|²))/gi;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const v = eurToNum(m[1]);
    if (v != null) nums.push(v);
  }
  nums.sort((a,b)=>a-b);
  for (let i=0;i<nums.length-1;i++){
    const a=nums[i], b=nums[i+1];
    if (plausible(a) && plausible(b) && b-a>=10) return { min:a, max:b };
  }
  return { min: nums[0] ?? null, max: nums[1] ?? null };
}

// Extrae total (€ / mes), €/m², rango y precio_ref
function extractAll(raw) {
  const t = String(raw || "");
  const oneLine = t.replace(/\s+/g, " ");

  // €/m² explícito
  const psqmPatterns = [
    /([\d\.\,]+)\s*(?:\u20AC|€)\s*\/\s*m(?:2|²)/i,
    /m(?:2|²)\s*[:\-]?\s*([\d\.\,]+)\s*(?:\u20AC|€)/i,
    /euros?\s*\/\s*m(?:2|²)\s*[:\-]?\s*([\d\.\,]+)/i,
  ];
  let psqm = null;
  for (const rx of psqmPatterns) {
    const m = oneLine.match(rx);
    if (m) { psqm = eurToNum(m[1]); break; }
  }

  // total explícito “€/mes” o similar
  const totalPatterns = [
    /([\d\.\,]+)\s*(?:\u20AC|€)\s*\/\s*mes/i,
    /total\s*[:\-]?\s*([\d\.\,]+)\s*(?:\u20AC|€)/i,
    /importe\s*[:\-]?\s*([\d\.\,]+)\s*(?:\u20AC|€)/i,
    /precio\s+de\s+referencia[^\d\u20AC]*([\d\.\,]+)\s*(?:\u20AC|€)/i,
  ];
  let total = null;
  for (const rx of totalPatterns) {
    const m = oneLine.match(rx);
    if (m) { total = eurToNum(m[1]); if (plausible(total)) break; }
  }

  // precio_ref (alias de total si aparece con esa etiqueta)
  const refPatterns = [
    /precio\s+de\s+referencia[^\d\u20AC]*([\d\.\,]+)/i,
    /precio\s+referencia[^\d\u20AC]*([\d\.\,]+)/i,
    /precio\s+m[aá]ximo\s+de\s+referencia[^\d\u20AC]*([\d\.\,]+)/i,
    /referencia:\s*([\d\.\,]+)\s*(?:\u20AC|€|euros?)/i,
  ];
  let precio_ref = null;
  for (const rx of refPatterns) {
    const m = oneLine.match(rx);
    if (m) { precio_ref = eurToNum(m[1]); break; }
  }
  if (precio_ref != null && total == null) total = precio_ref;

  // rango
  const rangePatterns = [
    /rango[^\d\u20AC]*([\d\.\,]+)\D+([\d\.\,]+)/i,
    /entre[^\d\u20AC]*([\d\.\,]+)\D+([\d\.\,]+)\s*(?:\u20AC|€|euros?|eur)?/i,
    /m[ií]nimo[^\d\u20AC]*([\d\.\,]+)[^\d]+m[aá]ximo[^\d\u20AC]*([\d\.\,]+)/i,
    /([\d\.\,]+)\s*(?:\u20AC|€|euros?)\s*(?:a|-|–|—)\s*([\d\.\,]+)\s*(?:\u20AC|€|euros?)/i,
  ];
  let min = null, max = null;
  for (const rx of rangePatterns) {
    const m = oneLine.match(rx);
    if (m) { min = eurToNum(m[1]); max = eurToNum(m[2]); break; }
  }

  let out = sanitizeRange({ min, max, precio_ref, total, psqm }, oneLine);

  // Fallback si no hay nada claro: usa lista de importes con € (no €/m²)
  if ((out.min == null && out.max == null && out.total == null && out.precio_ref == null)) {
    const fb = pickRangeFromText(oneLine);
    out = sanitizeRange({ ...out, ...fb }, oneLine);
  }

  return out; // { min, max, precio_ref, total, psqm }
}

// =============================================
// Playwright helpers
// =============================================
function isOnSerpavi(urlStr) {
  try { return new URL(urlStr).hostname.includes("serpavi.mivau.gob.es"); } catch { return false; }
}
async function acceptCookiesIfAny(target) {
  const btns = [
    'button:has-text("Aceptar")','button:has-text("Acepto")','button:has-text("ACEPTAR")',
    '[id*="aceptar"]','[id*="accept"]','role=button[name=/acept|accept/i]',
    'text=/De acuerdo/i','text=/Aceptar cookies/i'
  ];
  for (const sel of btns) {
    try { const el = target.locator(sel).first(); if (await el.count()) { await el.click({ timeout: 1000 }).catch(()=>{}); } } catch {}
  }
}
async function clickAny(target, selectors, ctx = null) {
  for (const sel of selectors) {
    const el = target.locator(sel).first();
    if (await el.count()) {
      let popup = null;
      if (ctx) {
        popup = await Promise.race([
          ctx.waitForEvent("page", { timeout: 7000 }).catch(()=>null),
          el.click({ timeout: 2000 }).then(()=>null).catch(()=>null)
        ]);
      } else {
        await el.click({ timeout: 2000 }).catch(()=>{});
      }
      return popup || true;
    }
  }
  return false;
}
function getSerpaviFrame(page) {
  const frames = page.frames();
  for (const f of frames) { try { if (isOnSerpavi(f.url())) return f; } catch {} }
  return null;
}
async function gotoSerpavi(ctx) {
  let page = await ctx.newPage();
  await page.goto("https://serpavi.mivau.gob.es/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{});
  await acceptCookiesIfAny(page).catch(()=>{});
  let frame = getSerpaviFrame(page);
  if (isOnSerpavi(page.url()) || frame) return { page, target: frame ?? page };

  await page.goto("https://www.mivau.gob.es/vivienda/alquila-bien-es-tu-derecho/serpavi", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{});
  await acceptCookiesIfAny(page).catch(()=>{});
  const candidates = [
    'a[href*="serpavi.mivau.gob.es"]','a:has-text("SERPAVI")',
    'a:has-text("Sistema Estatal de Referencia")','a:has-text("precio del alquiler")',
  ];
  const opened = await clickAny(page, candidates, ctx);
  if (opened && opened !== true) {
    const newPage = opened;
    await newPage.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(()=>{});
    await acceptCookiesIfAny(newPage).catch(()=>{});
    frame = getSerpaviFrame(newPage);
    if (isOnSerpavi(newPage.url()) || frame) return { page: newPage, target: frame ?? newPage };
  }

  await page.goto("https://serpavi.mivau.gob.es/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{});
  await acceptCookiesIfAny(page).catch(()=>{});
  frame = getSerpaviFrame(page);
  return { page, target: frame ?? page };
}
async function ensureSerpaviContext(ctx) {
  const { page, target } = await Promise.race([
    gotoSerpavi(ctx),
    new Promise((_, rej) => setTimeout(() => rej(new Error("SERPAVI_UNREACHABLE")), 25000))
  ]);
  const curUrl = target.url ? target.url() : page.url();
  if (curUrl.includes("/buscador")) {
    await page.goto("https://serpavi.mivau.gob.es/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{});
    await acceptCookiesIfAny(page).catch(()=>{});
    const frame = getSerpaviFrame(page);
    const t2 = frame ?? page;
    if (!isOnSerpavi(t2.url())) throw new Error("SERPAVI_UNREACHABLE");
    return { page, target: t2 };
  }
  return { page, target };
}
async function findInput(target, selectors) {
  for (const sel of selectors) { const el = target.locator(sel).first(); if (await el.count()) return el; }
  return null;
}
async function fillRC(target, rc) {
  await clickAny(target, [
    'role=tab[name=/referencia\\s*catastral/i]','role=radio[name=/(referencia|ref\\.)\\s*catastral/i]','text=/Referencia\\s*catastral/i'
  ]).catch(()=>{});
  const input = await findInput(target, [
    'input[placeholder*="catastral" i]','input[name*="catastral" i]','input[aria-label*="catastral" i]',
    'input[placeholder*="referencia" i]','input[name*="referencia" i]','input[aria-label*="referencia" i]',
    'input[type="text"]'
  ]);
  if (!input) return false;
  try { const max = await input.evaluate(el => el.maxLength); if (max && max !== -1 && max < 20) return false; } catch {}
  await input.fill(rc, { timeout: 4000 }).catch(()=>{});
  return true;
}
async function setSelectOrInput(target, labelRegex, value) {
  if (value == null || value === "") return;
  const sel = target.getByLabel(labelRegex, { exact: false }).first();
  if (!(await sel.count())) return;
  try { const tag = await sel.evaluate((el) => el.tagName.toLowerCase()); if (tag === "select") await sel.selectOption(String(value)); else await sel.fill(String(value)); } catch {}
}
async function setRadioYesNo(target, groupRegex, yes) {
  if (yes == null) return;
  const group = target.getByRole("group", { name: groupRegex }).first();
  if (!(await group.count())) return;
  const radio = group.getByRole("radio", { name: yes ? /s[ií]|yes/i : /no/i }).first();
  if (await radio.count()) await radio.check().catch(()=>{});
}

// =============================================
// Rutas
// =============================================
app.get("/health", (_req, res) => { res.json({ ok: true, ts: new Date().toISOString() }); });

app.get("/diag", async (_req, res) => {
  try {
    const hdrs = { "User-Agent":"Mozilla/5.0", "Accept-Language":"es-ES,es;q=0.9" };
    const a = await fetch("https://serpavi.mivau.gob.es/", { headers: hdrs, redirect:"follow" }); const at = await a.text();
    const b = await fetch("https://www.mivau.gob.es/vivienda/alquila-bien-es-tu-derecho/serpavi", { headers: hdrs, redirect:"follow" }); const bt = await b.text();
    res.json({ ok: true, serpavi: { status: a.status, finalUrl: a.url, length: at.length }, info: { status: b.status, finalUrl: b.url, length: bt.length } });
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

app.get("/", (_req, res) => {
  res.type("text/plain").send(
`SERPAVI scraper
POST /  { rc, ascensor, planta, estado, etiqueta, aparcamiento?, amueblado?, dormitorios?, banos?, exterior?, m2? }
→ { ok:true, min, max, precio_ref, total, psqm }`
  );
});

app.post("/", async (req, res) => {
  try {
    const {
      rc,
      ascensor, planta, estado, etiqueta,
      aparcamiento, amueblado, dormitorios, banos, exterior,
      m2
    } = req.body || {};

    if (!rc || !/^[A-Z0-9]{20}$/.test(String(rc))) {
      return res.status(400).json({ ok:false, error:"RC inválida (debe tener 20 caracteres alfanuméricos)" });
    }

    const required = { ascensor, planta, estado, etiqueta };
    const missing = Object.entries(required).filter(([_,v]) => v===undefined || v===null || v==="").map(([k])=>k);
    if (missing.length) return res.status(200).json({ ok:true, needs: missing, hint: "Faltan atributos para completar el cálculo en SERPAVI" });

    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      locale: "es-ES", ignoreHTTPSErrors: true,
    });

    // permitir JS/CSS; bloquear imágenes/analytics
    await ctx.route("**/*", (route) => {
      const r = route.request(); const t = r.resourceType(); const url = r.url();
      if (["image","font","media"].includes(t)) return route.abort();
      if (/analytics|googletag|gtm|hotjar|matomo|doubleclick|facebook|cook/i.test(url)) return route.abort();
      return route.continue();
    });

    const work = (async () => {
      const { page, target } = await ensureSerpaviContext(ctx);
      page.setDefaultTimeout(15000); target.setDefaultTimeout?.(15000);

      // entrar/continuar flujo en SERPAVI (solo botones)
      await clickAny(target, [
        'button:has-text("Iniciar")','button:has-text("Acceder")',
        'button:has-text("Consultar")','button:has-text("Calcular")',
        'button:has-text("Siguiente")','button[aria-label*="consultar" i]','button[aria-label*="calcular" i]'
      ], ctx).catch(()=>{});

      // RC
      const rcOk = await fillRC(target, String(rc));
      if (!rcOk) return { ok:false, error:"RC_INPUT_NOT_FOUND", currentUrl: page.url(), frameUrl: target.url ? target.url() : null };
      await clickAny(target, [
        'button:has-text("Consultar")','button:has-text("Calcular")','button:has-text("Continuar")','button:has-text("Siguiente")',
        'button[aria-label*="consultar" i]','button[aria-label*="calcular" i]'
      ], ctx);

      // atributos
      await setSelectOrInput(target, /planta/i, planta);
      await setSelectOrInput(target, /estado/i, estado);
      const et = String(etiqueta || "").trim().toUpperCase();
      if (["A","B","C","D","E","F","G"].includes(et)) await setSelectOrInput(target, /etiqueta/i, et);
      await setRadioYesNo(target, /ascensor/i, !!ascensor);
      await setRadioYesNo(target, /(aparcamiento|parking)/i, !!aparcamiento);
      await setRadioYesNo(target, /amueblado/i, !!amueblado);
      await setRadioYesNo(target, /exterior/i, !!exterior);
      if (dormitorios != null) await setSelectOrInput(target, /dormitorios|habitaciones/i, dormitorios);
      if (banos != null)       await setSelectOrInput(target, /ba(ñ|n)os/i, banos);

      // calcular
      await clickAny(target, [
        'button:has-text("Calcular")','button:has-text("Continuar")','button:has-text("Siguiente")','button[aria-label*="calcular" i]'
      ], ctx);

      // esperar render
      await target.waitForLoadState?.("domcontentloaded", { timeout: 15000 }).catch(()=>{});
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(()=>{});
      await target.waitForTimeout?.(1500).catch(()=>{});

      // extraer cerca de “Precio”/“Rango”
      const anchors = [
        'text=/Precio\\s+de\\s+referencia/i','text=/Rango/i','section:has-text("Precio")','div:has-text("Precio")','main:has-text("Precio")'
      ];
      let acc = { min:null, max:null, precio_ref:null, total:null, psqm:null };
      for (const sel of anchors) {
        const el = target.locator(sel).first();
        if (await el.count()) {
          const txt = await el.evaluate(n => n.innerText || "");
          const r = extractAll(txt);
          acc.min = (acc.min==null || (r.min!=null && r.min<acc.min)) ? r.min : acc.min;
          acc.max = (acc.max==null || (r.max!=null && r.max>acc.max)) ? r.max : acc.max;
          acc.precio_ref = acc.precio_ref ?? r.precio_ref;
          acc.total = acc.total ?? r.total;
          acc.psqm = acc.psqm ?? r.psqm;
        }
      }

      // fallback a body completo
      if (acc.min==null && acc.max==null && acc.precio_ref==null && acc.total==null && acc.psqm==null) {
        const fullText = await (target.evaluate
          ? target.evaluate(() => document.body.innerText || "")
          : page.evaluate(() => document.body.innerText || ""));
        const r = extractAll(fullText);
        acc = { ...acc, ...r };
        if (acc.min==null && acc.max==null && acc.precio_ref==null && acc.total==null && acc.psqm==null) {
          return { ok:false, error:"UI_CHANGED", currentUrl: page.url(), frameUrl: target.url ? target.url() : null, sample: fullText.slice(0,2000) };
        }
      }

      // si tenemos psqm pero no total y recibimos m2 → calculamos total
      if (acc.psqm != null && (acc.total == null) && Number(m2)>0) {
        acc.total = Math.round(acc.psqm * Number(m2));
      }

      const out = sanitizeRange(acc, "");
      return { ok:true, min: out.min ?? null, max: out.max ?? null, precio_ref: out.precio_ref ?? null, total: out.total ?? null, psqm: out.psqm ?? null, rc, via:"playwright" };
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

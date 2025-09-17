// server.mjs
// SERPAVI scraper HTTP (Express + Playwright)
// - POST /  { rc, ascensor, planta, estado, etiqueta, aparcamiento?, amueblado?, dormitorios?, banos?, exterior? }
// - GET  /health
// - GET  /diag
// Devuelve: { ok:true, min, max, precio_ref, total?, psqm?, via:"playwright" }  (o { ok:false, error, ...debug })

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

function sanitizeRange({ min, max, precio_ref }, text) {
  if (min != null && max != null && min > max) [min, max] = [max, min];
  const plausible = (x) => x != null && x >= 100 && x <= 20000;
  if (min != null && !plausible(min)) min = null;
  if (max != null && !plausible(max)) max = null;

  if (precio_ref == null && text && /precio\s+de\s+referencia/i.test(text)) {
    const m = text.match(/precio\s+de\s+referencia[^\d\u20AC]*([\d\.\,]+)/i);
    if (m) precio_ref = eurToNum(m[1]);
  }
  return { min, max, precio_ref };
}

function pickRangeFromText(text) {
  // Solo importes con símbolo de € para evitar años como 2023
  const nums = [];
  const rx = /([\d]{1,3}(?:\.\d{3})*(?:,\d{1,2})?)\s*(?:\u20AC|€|euros?|eur)/gi;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const v = eurToNum(m[1]);
    if (v != null) nums.push(v);
  }
  nums.sort((a, b) => a - b);
  if (nums.length >= 2) return { min: nums[0], max: nums[nums.length - 1] };
  if (nums.length === 1) return { min: null, max: nums[0] };
  return { min: null, max: null };
}

function extractRangeAndRef(raw) {
  const t = String(raw || "").replace(/\s+/g, " ");

  // Precio de referencia (solo si aparece el texto clave)
  let precio_ref = null;
  {
    const m = t.match(/precio\s+(?:de\s+)?referencia[^\d€]*([\d\.]+,\d{1,2}|[\d\.]+)/i);
    if (m) {
      const v = eurToNum(m[1]);
      if (v != null && v >= 200 && v <= 20000) precio_ref = v;
    }
  }

  // Rango explícito (con palabras clave y € cerca)
  const rangeRegs = [
    /rango[^€\d]*([\d\.]+(?:,\d{1,2})?)\s*(?:€|euros?)\D+([\d\.]+(?:,\d{1,2})?)\s*(?:€|euros?)/i,
    /entre[^€\d]*([\d\.]+(?:,\d{1,2})?)\s*(?:€|euros?)\D+([\d\.]+(?:,\d{1,2})?)\s*(?:€|euros?)/i,
    /m[ií]nimo[^€\d]*([\d\.]+(?:,\d{1,2})?)\s*(?:€|euros?).{0,40}?m[aá]ximo[^€\d]*([\d\.]+(?:,\d{1,2})?)\s*(?:€|euros?)/i,
    /([\d\.]+(?:,\d{1,2})?)\s*(?:€|euros?)\s*(?:a|-|–|—)\s*([\d\.]+(?:,\d{1,2})?)\s*(?:€|euros?)/i
  ];
  let min = null, max = null;
  for (const rx of rangeRegs) {
    const m = t.match(rx);
    if (m) {
      const a = eurToNum(m[1]), b = eurToNum(m[2]);
      if (a!=null && b!=null) { min = Math.min(a,b); max = Math.max(a,b); }
      break;
    }
  }

  // Filtro anti-años: descarta 1800–2100
  const isYearLike = (v) => v>=1800 && v<=2100;
  if (min!=null && isYearLike(min)) min=null;
  if (max!=null && isYearLike(max)) max=null;

  // Si seguimos sin rango, intenta recoger TODOS los importes con € del bloque y escoger 2 plausibles
  if (min==null && max==null) {
    const euros = [...t.matchAll(/([\d]{1,3}(?:\.\d{3})*(?:,\d{1,2})?)\s*(?:€|euros?)/gi)]
      .map(m=>eurToNum(m[1]))
      .filter(v => v!=null && v>=200 && v<=20000 && !isYearLike(v))
      .sort((a,b)=>a-b);
    if (euros.length>=2) { min = euros[0]; max = euros[euros.length-1]; }
  }

  // Saneado final
  const out = sanitizeRange({ min, max, precio_ref }, t);
  if (out.min!=null && out.max!=null && out.min>out.max) [out.min,out.max]=[out.max,out.min];
  return out;
}


// =============================================
// Playwright helpers
// =============================================
function isOnSerpavi(urlStr) {
  try { return new URL(urlStr).hostname.includes("serpavi.mivau.gob.es"); } catch { return false; }
}

async function acceptCookiesIfAny(target) {
  const btns = [
    'button:has-text("Aceptar")',
    'button:has-text("Acepto")',
    'button:has-text("ACEPTAR")',
    'button:has-text("De acuerdo")',
    '[id*="aceptar"]',
    '[id*="accept"]',
    'role=button[name=/acept|accept|de acuerdo/i]',
    'text=/Aceptar cookies/i',
  ];
  for (const sel of btns) {
    try {
      const el = target.locator(sel).first();
      if (await el.count()) { await el.click({ timeout: 1200 }).catch(() => {}); }
    } catch {}
  }
}

async function clickAny(target, selectors) {
  for (const sel of selectors) {
    const el = target.locator(sel).first();
    if (await el.count()) {
      await el.click({ timeout: 2000 }).catch(()=>{});
      return true;
    }
  }
  return false;
}

function serpaviFrame(page) {
  const frames = page.frames();
  for (const f of frames) {
    try { if (isOnSerpavi(f.url())) return f; } catch {}
  }
  return null;
}

async function gotoSerpavi(ctx) {
  // Intento directo
  let page = await ctx.newPage();
  await page.goto("https://serpavi.mivau.gob.es/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{});
  await acceptCookiesIfAny(page).catch(()=>{});
  let target = serpaviFrame(page) || page;
  if (isOnSerpavi(target.url?.() || page.url())) return { page, target };

  // Reintento directo (a veces carga lento)
  await page.goto("https://serpavi.mivau.gob.es/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{});
  await acceptCookiesIfAny(page).catch(()=>{});
  target = serpaviFrame(page) || page;
  return { page, target };
}

async function ensureSerpaviContext(ctx) {
  const { page, target } = await Promise.race([
    gotoSerpavi(ctx),
    new Promise((_, rej) => setTimeout(() => rej(new Error("SERPAVI_UNREACHABLE")), 25000))
  ]);
  if (!isOnSerpavi(target.url?.() || page.url())) throw new Error("SERPAVI_UNREACHABLE");
  return { page, target };
}

async function findSerpaviSearchInput(target) {
  const candidates = [
    // Muy específico
    'input[placeholder*="Introduzca"][placeholder*="referencia" i]',
    'input[placeholder*="referencia catastral" i]',
    'input[aria-label*="Buscar vivienda" i]',
    'input[placeholder*="Buscar vivienda" i]',
    // Genérico pero solo en SERPAVI
    'input[type="search"]',
    'input[type="text"]',
  ];
  for (const sel of candidates) {
    const loc = target.locator(sel).first();
    if (await loc.count()) {
      // Evita inputs ocultos (display:none/visibility:hidden)
      try { await loc.waitFor({ state: "visible", timeout: 1500 }); } catch {}
      if (await loc.isVisible()) return loc;
    }
  }
  return null;
}

async function typeRCAndPickFirst(target, rc) {
  const input = await findSerpaviSearchInput(target);
  if (!input) return false;

  await input.click({ timeout: 1500 }).catch(()=>{});
  await input.fill(rc, { timeout: 3000 }).catch(()=>{});
  // esperar dropdown de sugerencias o resultados
  await target.waitForTimeout?.(800);

  // 1) Intento: pulsar ↓ + Enter
  try {
    await input.press("ArrowDown");
    await input.press("Enter");
  } catch {}

  // 2) Clic en primera sugerencia visible
  const suggestionSelectors = [
    '[role="option"]',
    'ul[role="listbox"] li',
    'li[role="option"]',
    '.autocomplete li',
    '.mat-option',
    'li:has-text("C/"), li:has-text("CL "), li:has-text("Av")',
  ];
  for (const ss of suggestionSelectors) {
    const first = target.locator(ss).first();
    if (await first.count()) {
      await first.click({ timeout: 1200 }).catch(()=>{});
      break;
    }
  }

  return true;
}

async function setSelectOrInput(target, labelRegex, value) {
  if (value == null || value === "") return;
  const sel = target.getByLabel(labelRegex, { exact: false }).first();
  if (!(await sel.count())) return;
  try {
    const tag = await sel.evaluate((el) => el.tagName.toLowerCase());
    if (tag === "select") await sel.selectOption(String(value));
    else await sel.fill(String(value));
  } catch {}
}

async function setRadioYesNo(target, groupRegex, yes) {
  if (yes == null) return;
  // Radios en grupo
  const group = target.getByRole("group", { name: groupRegex }).first();
  if (await group.count()) {
    const radio = group.getByRole("radio", { name: yes ? /s[ií]|yes/i : /no/i }).first();
    if (await radio.count()) { await radio.check().catch(()=>{}); return; }
  }
  // Checkbox con label directo (por si son checkboxes)
  const check = target.getByLabel(groupRegex, { exact: false }).first();
  if (await check.count()) {
    const isChecked = await check.isChecked().catch(()=>false);
    if (!!yes !== isChecked) await check.click().catch(()=>{});
  }
}

// =============================================
// Rutas
// =============================================
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get("/diag", async (_req, res) => {
  try {
    const hdrs = { "User-Agent":"Mozilla/5.0", "Accept-Language":"es-ES,es;q=0.9" };
    const a = await fetch("https://serpavi.mivau.gob.es/", { headers: hdrs, redirect:"follow" });
    const at = await a.text();
    res.json({ ok: true, serpavi: { status: a.status, length: at.length, sample: at.slice(0,200) }});
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.get("/", (_req, res) => {
  res.type("text/plain").send(
`SERPAVI scraper
POST /  { rc, ascensor, planta, estado, etiqueta, aparcamiento?, amueblado?, dormitorios?, banos?, exterior? }
→ { ok:true, min, max, precio_ref }`
  );
});

app.post("/", async (req, res) => {
  const started = Date.now();
  try {
    const {
      rc,
      ascensor, planta, estado, etiqueta,
      aparcamiento, amueblado, dormitorios, banos, exterior,
    } = req.body || {};

    if (!rc || !/^[A-Z0-9]{20}$/.test(String(rc))) {
      return res.status(400).json({ ok:false, error:"RC inválida (debe tener 20 caracteres alfanuméricos)" });
    }

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

    // Bloqueo ligero (dejamos CSS/JS)
    await ctx.route("**/*", (route) => {
      const r = route.request();
      const t = r.resourceType();
      const url = r.url();
      if (["image","font","media"].includes(t)) return route.abort();
      if (/analytics|googletag|gtm|hotjar|matomo|doubleclick|facebook|cook/i.test(url)) return route.abort();
      return route.continue();
    });

    const work = (async () => {
      const { page, target } = await ensureSerpaviContext(ctx);

      page.setDefaultTimeout(15000);
      target.setDefaultTimeout?.(15000);

      // Aceptar cookies en la app
      await acceptCookiesIfAny(target).catch(()=>{});

      // Buscar vivienda por RC (campo correcto)
      const okInput = await typeRCAndPickFirst(target, String(rc));
      if (!okInput) {
        const html = await page.content().catch(()=>null);
        const shot = await page.screenshot({ fullPage: true }).catch(()=>null);
        return { ok:false, error:"RC_INPUT_NOT_FOUND_ON_APP", currentUrl: page.url(), frameUrl: target.url ? target.url() : null, html: html ? html.slice(0,1200) : null, screenshot_base64: shot ? Buffer.from(shot).toString("base64") : null };
      }

      // Esperar a que cargue la ficha/formulario con datos del catastro
      // (miramos la presencia de campos típicos)
      await target.waitForTimeout?.(1200);
      await acceptCookiesIfAny(target).catch(()=>{});
      const formAnchor = target.locator('text=/Sistema Estatal de Referencia|Municipio\\*|Provincia\\*|Referencia\\s+Catastral\\*/i').first();
      await formAnchor.waitFor({ state: 'visible', timeout: 12000 }).catch(()=>{});

      // Rellenar atributos no automáticos
      await setSelectOrInput(target, /planta/i, planta);
      await setSelectOrInput(target, /estado/i, estado);
      const et = String(etiqueta || "").trim().toUpperCase();
      if (["A","B","C","D","E","F","G"].includes(et)) await setSelectOrInput(target, /etiqueta/i, et);
      await setRadioYesNo(target, /ascensor|ascens/i, !!ascensor);
      await setRadioYesNo(target, /(aparcamiento|parking)/i, !!aparcamiento);
      await setRadioYesNo(target, /amueblad/i, !!amueblado);
      await setRadioYesNo(target, /exterior/i, !!exterior);
      if (dormitorios != null) await setSelectOrInput(target, /dormitorios|habitaciones/i, dormitorios);
      if (banos != null)       await setSelectOrInput(target, /ba(ñ|n)os/i, banos);

      // Calcular / Consultar / Siguiente
      await clickAny(target, [
        'role=button[name=/calcular|consultar|siguiente|ver precio/i]',
        'text=/Calcular|Consultar|Siguiente|Ver precio/i'
      ]);

      // Espera de render
      await target.waitForLoadState?.("domcontentloaded", { timeout: 12000 }).catch(()=>{});
      await target.waitForTimeout?.(2000).catch(()=>{});

      // Extraer importes
      const anchors = [
        'text=/Precio\\s+de\\s+referencia/i',
        'text=/Rango/i',
        'section:has-text("Precio")',
        'div:has-text("Precio")',
        'main:has-text("Precio")',
        '[class*="precio"]',
      ];
      let min=null,max=null,precio_ref=null, scopeText = "";
      for (const sel of anchors) {
        const el = target.locator(sel).first();
        if (await el.count()) {
          const txt = await el.evaluate(n => n.innerText || "");
          scopeText += " " + txt;
          const r = extractRangeAndRef(txt);
          if (r.min!=null && (min==null || r.min<min)) min = r.min;
          if (r.max!=null && (max==null || r.max>max)) max = r.max;
          if (r.precio_ref!=null) precio_ref = r.precio_ref;
        }
      }

      if (min==null && max==null && precio_ref==null) {
        const fullText = await (target.evaluate
          ? target.evaluate(() => document.body.innerText || "")
          : page.evaluate(() => document.body.innerText || ""));
        const r = extractRangeAndRef(fullText);
        min = r.min; max = r.max; precio_ref = r.precio_ref;

        if (!min && !max && !precio_ref) {
          const shot = await page.screenshot({ fullPage: true }).catch(()=>null);
          return { ok:false, error:"UI_CHANGED", currentUrl: page.url(), frameUrl: target.url ? target.url() : null, sample: fullText.slice(0,2000), screenshot_base64: shot ? Buffer.from(shot).toString("base64") : null };
        }
      }

      const out = sanitizeRange({ min, max, precio_ref }, "");
      const total = out.precio_ref ?? out.max ?? out.min ?? null;
      const psqm = null; // si en el futuro se obtiene €/m², completar aquí

      return {
        ok:true,
        min: out.min ?? null,
        max: out.max ?? null,
        precio_ref: out.precio_ref ?? null,
        total, psqm,
        rc, via:"playwright",
        ms: Date.now()-started
      };
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

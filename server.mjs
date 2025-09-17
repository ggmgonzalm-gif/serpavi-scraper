// server.mjs
// SERPAVI scraper HTTP (Express + Playwright)
// - POST /  { rc, etiqueta, estado, planta, ascensor?, aparcamiento?, amueblada?, conserjeria?, vistas?, piscina?, zonas?, debug? }
// - GET  /health
// - GET  /diag
// Devuelve: { ok:true, min, max, precio_ref, total, psqm, via:"playwright" }  (debug: +html/sample/screenshot)

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

// Solo aceptamos importes con € (evita años como 2023)
function pickRangeFromText(text) {
  const nums = [];
  const rx = /([\d]{2,3}(?:\.\d{3})*(?:,\d{1,2})?)\s*(?:€|euros?)/gi;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const v = eurToNum(m[1]);
    if (v != null) nums.push(v);
  }
  nums.sort((a, b) => a - b);
  if (nums.length >= 2) return { min: nums[0], max: nums[1] };
  if (nums.length === 1) return { min: null, max: nums[0] };
  return { min: null, max: null };
}

function sanitizeRange({ min, max, precio_ref }) {
  if (min != null && max != null && min > max) [min, max] = [max, min];
  const plausible = (x) => x != null && x >= 100 && x <= 20000;
  if (min != null && !plausible(min)) min = null;
  if (max != null && !plausible(max)) max = null;
  if (precio_ref != null && !plausible(precio_ref)) precio_ref = null;
  return { min, max, precio_ref };
}

// Extrae precios desde texto visible (requiere €)
function extractRangeAndRef(raw) {
  const t = String(raw || "").replace(/\s+/g, " ");

  // Precio referencia – exige símbolo de € o 'euros'
  const refPatterns = [
    /precio\s+de\s+referencia[^€\d]*([\d\.\,]+)\s*(?:€|euros?)/i,
    /precio\s+referencia[^€\d]*([\d\.\,]+)\s*(?:€|euros?)/i,
    /precio\s+m[aá]ximo\s+de\s+referencia[^€\d]*([\d\.\,]+)\s*(?:€|euros?)/i,
  ];
  let precio_ref = null;
  for (const rx of refPatterns) {
    const m = t.match(rx);
    if (m) { precio_ref = eurToNum(m[1]); break; }
  }

  // Rango (…€ a …€, …€ – …€)
  const rangePatterns = [
    /entre[^€\d]*([\d\.\,]+)\s*(?:€|euros?).{0,20}?([\d\.\,]+)\s*(?:€|euros?)/i,
    /([\d\.\,]+)\s*(?:€|euros?)\s*(?:a|-|–|—)\s*([\d\.\,]+)\s*(?:€|euros?)/i,
    /m[ií]nimo[^€\d]*([\d\.\,]+)\s*(?:€|euros?).{0,30}?m[aá]ximo[^€\d]*([\d\.\,]+)\s*(?:€|euros?)/i,
  ];
  let min = null, max = null;
  for (const rx of rangePatterns) {
    const m = t.match(rx);
    if (m) { min = eurToNum(m[1]); max = eurToNum(m[2]); break; }
  }

  // Fallback con lista de importes con €
  if (min == null && max == null) {
    const fb = pickRangeFromText(t);
    min = fb.min; max = fb.max;
  }

  // €/m² si aparece
  let psqm = null;
  const m2a = t.match(/([\d\.\,]+)\s*€\s*\/\s*m²/i) || t.match(/([\d\.\,]+)\s*€\s*\/\s*m2/i);
  if (m2a) psqm = eurToNum(m2a[1]);

  const out = sanitizeRange({ min, max, precio_ref });
  return { ...out, psqm };
}

// =============================================
// Playwright helpers
// =============================================
const SERPAVI = "https://serpavi.mivau.gob.es/";

function isOnSerpavi(urlStr) {
  try { return new URL(urlStr).hostname.includes("serpavi.mivau.gob.es"); } catch { return false; }
}

async function acceptCookiesIfAny(target) {
  const btns = [
    'button:has-text("Aceptar")',
    'button:has-text("Acepto")',
    'button:has-text("ACEPTAR")',
    '[id*="aceptar"]',
    '[id*="accept"]',
    'role=button[name=/acept|accept/i]',
    'text=/De acuerdo/i',
    'text=/Aceptar cookies/i'
  ];
  for (const sel of btns) {
    try {
      const el = target.locator(sel).first();
      if (await el.count()) { await el.click({ timeout: 800 }).catch(() => {}); }
    } catch {}
  }
}

function getSerpaviFrame(page) {
  const frames = page.frames();
  for (const f of frames) {
    try { if (isOnSerpavi(f.url())) return f; } catch {}
  }
  return null;
}

async function gotoSerpavi(ctx) {
  let page = await ctx.newPage();

  // intento directo
  await page.goto(SERPAVI, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{});
  await acceptCookiesIfAny(page).catch(()=>{});
  let target = getSerpaviFrame(page) ?? page;
  if (isOnSerpavi(target.url())) return { page, target };

  // informativa + click a la app (misma pestaña o popup)
  await page.goto("https://www.mivau.gob.es/vivienda/alquila-bien-es-tu-derecho/serpavi", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{});
  await acceptCookiesIfAny(page).catch(()=>{});
  const link = page.locator('a[href*="serpavi.mivau.gob.es"], a:has-text("SERPAVI")').first();
  if (await link.count()) {
    const [popup] = await Promise.all([
      ctx.waitForEvent("page").catch(()=>null),
      link.click({ timeout: 2000 }).catch(()=>{})
    ]);
    const newPage = popup || page;
    await newPage.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(()=>{});
    await acceptCookiesIfAny(newPage).catch(()=>{});
    target = getSerpaviFrame(newPage) ?? newPage;
    return { page: newPage, target };
  }

  // reintento directo
  await page.goto(SERPAVI, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{});
  await acceptCookiesIfAny(page).catch(()=>{});
  target = getSerpaviFrame(page) ?? page;
  return { page, target };
}

async function ensureSerpaviContext(ctx) {
  const { page, target } = await Promise.race([
    gotoSerpavi(ctx),
    new Promise((_, rej) => setTimeout(() => rej(new Error("SERPAVI_UNREACHABLE")), 25000))
  ]);
  return { page, target };
}

// Busca el input “Introduzca referencia catastral o dirección…”, rellena y lanza búsqueda
async function searchByRC(target, rc) {
  const searchBox = target.locator(
    [
      'input[placeholder*="Introduzca"][placeholder*="referencia" i]',
      'input[placeholder*="referencia catastral" i]',
      'input[aria-label*="Buscar vivienda" i]',
      'input[placeholder*="Buscar vivienda" i]',
      'input[type="search"]'
    ].join(",")
  ).first();

  if (!(await searchBox.count())) return false;

  // limpiar y escribir
  await searchBox.click({ timeout: 2000 }).catch(()=>{});
  await searchBox.fill(" ", { timeout: 1500 }).catch(()=>{});
  await searchBox.fill(rc, { timeout: 2500 }).catch(()=>{});
  await searchBox.press("Enter").catch(()=>{});

  // esperar panel de sugerencias (Material/ARIA)
  const panel = target.locator(
    [
      '[role="listbox"]',
      '.mat-mdc-autocomplete-panel',
      'ul[role="listbox"]'
    ].join(",")
  ).first();

  await panel.waitFor({ state: "visible", timeout: 4000 }).catch(()=>{});

  // elegir la primera opción válida (evitar “No se han encontrado direcciones”)
  const options = target.locator(
    [
      '[role="listbox"] [role="option"]',
      '.mat-mdc-autocomplete-panel [role="option"]',
      'ul[role="listbox"] li'
    ].join(",")
  );

  const count = await options.count().catch(()=>0);
  if (count > 0) {
    for (let i=0;i<Math.min(count,5);i++){
      const opt = options.nth(i);
      const txt = (await opt.innerText().catch(()=>"")) || "";
      if (!/no se han encontrado/i.test(txt)) {
        await opt.click({ timeout: 2000 }).catch(()=>{});
        break;
      }
    }
  } else {
    // si no hay opciones, reintenta enter
    await searchBox.press("Enter").catch(()=>{});
  }

  // éxito si vemos bloques típicos de la ficha
  await target.waitForTimeout?.(800).catch(()=>{});
  const ficha = target.locator('text=/Datos del catastro|Vivienda\\*|Referencia Catastral\\*|Año de construcción\\*/i').first();
  if (await ficha.count()) return true;

  // si desaparece el input, puede haber navegado a la ficha
  const stillVisible = await searchBox.isVisible().catch(()=>false);
  return !stillVisible;
}

// set de campos manuales
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
  const group = target.getByRole("group", { name: groupRegex }).first();
  if (!(await group.count())) return;
  const radio = group.getByRole("radio", { name: yes ? /s[ií]|yes/i : /no/i }).first();
  if (await radio.count()) await radio.check().catch(()=>{});
}

// =============================================
// Rutas utilitarias
// =============================================
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get("/diag", async (_req, res) => {
  try {
    const hdrs = { "User-Agent":"Mozilla/5.0", "Accept-Language":"es-ES,es;q=0.9" };
    const a = await fetch(SERPAVI, { headers: hdrs, redirect:"follow" });
    const at = await a.text();
    res.json({ ok: true, serpavi: { status: a.status, length: at.length, sample: at.slice(0,180) } });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.get("/", (_req, res) => {
  res.type("text/plain").send(
`SERPAVI scraper
POST /  { rc, etiqueta, estado, planta, ascensor?, aparcamiento?, amueblada?, conserjeria?, vistas?, piscina?, zonas?, debug? }
→ { ok:true, min, max, precio_ref, total, psqm }`
  );
});

// =============================================
// POST principal
// =============================================
app.post("/", async (req, res) => {
  const t0 = Date.now();
  try {
    const {
      rc,
      // obligatorios manuales
      etiqueta,   // A..G
      estado,     // nuevo|reformado|bueno|a_reformar (o variantes)
      planta,     // número (Altura)
      // binarios opcionales
      ascensor, aparcamiento, amueblada, conserjeria, vistas, piscina, zonas,
      // debug
      debug
    } = req.body || {};

    if (!rc || !/^[A-Z0-9]{20}$/.test(String(rc))) {
      return res.status(400).json({ ok:false, error:"RC inválida (20 caracteres alfanuméricos)" });
    }
    if (!etiqueta || !estado || (planta===undefined || planta===null || String(planta)==="")) {
      return res.status(200).json({ ok:false, error:"FALTAN_CAMPOS", needs: ["etiqueta","estado","planta"].filter(k => !({etiqueta,estado,planta}[k] && String({etiqueta,estado,planta}[k]).length)) });
    }

    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process"
      ]
    });

    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      locale: "es-ES",
      ignoreHTTPSErrors: true,
    });

    // Bloqueo de recursos pesados (CSS/JS permitidos)
    await ctx.route("**/*", (route) => {
      const req = route.request();
      const t = req.resourceType();
      const url = req.url();
      if (["image","font","media"].includes(t)) return route.abort();
      if (/analytics|googletag|gtm|hotjar|matomo|doubleclick|facebook|cook/i.test(url)) return route.abort();
      return route.continue();
    });

    const work = (async () => {
      const { page, target } = await ensureSerpaviContext(ctx);

      // timeouts por página/frame (ahora sí existe page/target)
      page.setDefaultTimeout(12000);
      page.setDefaultNavigationTimeout(15000);
      target.setDefaultTimeout?.(12000);

      // 1) Buscar por RC en el input grande
      const okSearch = await searchByRC(target, String(rc));
      if (!okSearch) {
        const html = await (target.content ? target.content() : page.content()).catch(()=>null);
        const txt = await (target.evaluate ? target.evaluate(()=>document.body.innerText||"") : page.evaluate(()=>document.body.innerText||""));
        return { ok:false, error:"RC_INPUT_NOT_FOUND_ON_APP", currentUrl: page.url(), frameUrl: target.url ? target.url() : null, sample: (txt||"").slice(0,1800), html: debug? (html||"").slice(0,1800) : undefined };
      }

      // 2) Completar SOLO campos manuales
      const et = String(etiqueta).trim().toUpperCase();
      if (["A","B","C","D","E","F","G"].includes(et)) {
        await setSelectOrInput(target, /(Certificado|Etiqueta)\s+energ(é|e)tic/i, et);
      }
      await setSelectOrInput(target, /Estado\s+de\s+conservaci(ó|o)n/i, String(estado));
      await setSelectOrInput(target, /Altura/i, String(planta));
      await setRadioYesNo(target, /Ascensor/i, !!ascensor);
      await setRadioYesNo(target, /Aparcamiento/i, !!aparcamiento);
      await setRadioYesNo(target, /Amueblad[ao]/i, !!amueblada);
      await setRadioYesNo(target, /Conserjer(í|i)a/i, !!conserjeria);
      await setRadioYesNo(target, /Vistas\s+especiales/i, !!vistas);
      await setRadioYesNo(target, /(Piscina\s+comunitaria|gimnasio|equipamiento\s+an(á|a)logo)/i, !!piscina);
      await setRadioYesNo(target, /Zonas\s+comunitarias/i, !!zonas);

      // 3) Calcular / Consultar
      const btnCalc = target.locator(
        [
          'role=button[name=/Calcular|Consultar|Siguiente|Generar/i]',
          'button:has-text("Calcular")',
          'button:has-text("Consultar")'
        ].join(",")
      ).first();
      if (await btnCalc.count()) await btnCalc.click({ timeout: 2000 }).catch(()=>{});
      await target.waitForTimeout?.(2000).catch(()=>{});
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(()=>{});

      // 4) Extraer importes
      const anchors = [
        'text=/Precio\\s+de\\s+referencia/i',
        'text=/Rango/i',
        'section:has-text("Precio")',
        'div:has-text("Precio")',
        'main:has-text("Precio")',
      ];
      let min=null,max=null,precio_ref=null,psqm=null;
      for (const sel of anchors) {
        const el = target.locator(sel).first();
        if (await el.count()) {
          const txt = await el.evaluate(n => n.innerText || "");
          const r = extractRangeAndRef(txt);
          if (r.min!=null && (min==null || r.min<min)) min = r.min;
          if (r.max!=null && (max==null || r.max>max)) max = r.max;
          if (r.precio_ref!=null) precio_ref = r.precio_ref;
          if (r.psqm!=null) psqm = r.psqm;
        }
      }

      if (min==null && max==null && precio_ref==null) {
        const full = await (target.evaluate ? target.evaluate(()=>document.body.innerText||"") : page.evaluate(()=>document.body.innerText||""));
        const r = extractRangeAndRef(full);
        min = r.min; max = r.max; precio_ref = r.precio_ref; psqm = r.psqm ?? psqm;
        if (!min && !max && !precio_ref) {
          const html = await (target.content ? target.content() : page.content()).catch(()=>null);
          return { ok:false, error:"UI_CHANGED", currentUrl: page.url(), frameUrl: target.url ? target.url() : null, sample: (full||"").slice(0,2000), html: debug? (html||"").slice(0,2000) : undefined };
        }
      }

      const out = sanitizeRange({ min, max, precio_ref });
      const total = out.precio_ref ?? out.max ?? out.min ?? null;
      return { ok:true, min: out.min ?? null, max: out.max ?? null, precio_ref: out.precio_ref ?? null, total, psqm: psqm ?? null, rc, via:"playwright", ms: Date.now()-t0 };
    })();

    const result = await Promise.race([
      work,
      new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT_GLOBAL_40s")), 40000))
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

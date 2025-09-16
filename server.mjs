// server.mjs
// SERPAVI scraper HTTP (Express + Playwright)
// - POST /  { rc, ascensor, planta, estado, etiqueta, aparcamiento?, amueblado?, dormitorios?, banos?, exterior? }
// - GET  /health
// Devuelve: { ok:true, min, max, precio_ref, via:"playwright" }  (o { ok:false, error, ...debug })

import express from "express";
import { chromium } from "playwright";

const app = express();

// --- timeouts para que no “cuelgue” al cliente
app.use((req, res, next) => {
  req.setTimeout?.(70000);
  res.setTimeout?.(70000);
  next();
});

app.use(express.json({ limit: "1mb" }));

// --- CORS básico
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});
app.options("*", (_, res) => res.sendStatus(204));

// ---------- Helpers numéricos / extracción ----------
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
  const nums = [];
  const rx = /([\d]{2,3}(?:\.\d{3})*(?:,\d{1,2})?)\s*(?:\u20AC|euros?|eur)/gi;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const v = eurToNum(m[1]);
    if (v != null) nums.push(v);
  }
  nums.sort((a, b) => a - b);
  for (let i = 0; i < nums.length - 1; i++) {
    const a = nums[i], b = nums[i + 1];
    if (a >= 100 && b >= 100 && b - a >= 10) return { min: a, max: b };
  }
  return { min: nums[0] ?? null, max: nums[1] ?? null };
}

// Extrae precios desde texto visible
function extractRangeAndRef(raw) {
  const t = String(raw || "").replace(/\s+/g, " ");

  const refPatterns = [
    /precio\s+de\s+referencia[^\d\u20AC]*([\d\.\,]+)/i,
    /precio\s+referencia[^\d\u20AC]*([\d\.\,]+)/i,
    /precio\s+m[aá]ximo\s+de\s+referencia[^\d\u20AC]*([\d\.\,]+)/i,
    /referencia:\s*([\d\.\,]+)\s*(?:\u20AC|euros?)/i,
  ];
  let precio_ref = null;
  for (const rx of refPatterns) {
    const m = t.match(rx);
    if (m) { precio_ref = eurToNum(m[1]); break; }
  }

  const rangePatterns = [
    /rango[^\d\u20AC]*([\d\.\,]+)\D+([\d\.\,]+)/i,
    /entre[^\d\u20AC]*([\d\.\,]+)\D+([\d\.\,]+)\s*(?:\u20AC|euros?|eur)?/i,
    /m[ií]nimo[^\d\u20AC]*([\d\.\,]+)[^\d]+m[aá]ximo[^\d\u20AC]*([\d\.\,]+)/i,
    /([\d\.\,]+)\s*(?:\u20AC|euros?)\s*(?:a|-|–|—)\s*([\d\.\,]+)\s*(?:\u20AC|euros?)/i,
  ];
  let min = null, max = null;
  for (const rx of rangePatterns) {
    const m = t.match(rx);
    if (m) { min = eurToNum(m[1]); max = eurToNum(m[2]); break; }
  }

  let out = sanitizeRange({ min, max, precio_ref }, t);
  if ((out.min == null && out.max == null) || (out.max != null && out.max < 100)) {
    const fb = pickRangeFromText(t);
    out = sanitizeRange({ ...out, ...fb }, t);
  }
  return out;
}

// ---------- Playwright helpers ----------
function isOnSerpavi(urlStr) {
  try { return new URL(urlStr).hostname.includes("serpavi.mivau.gob.es"); } catch { return false; }
}

async function acceptCookiesIfAny(target /* page or frame */) {
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
      if (await el.count()) { await el.click({ timeout: 1000 }).catch(() => {}); }
    } catch {}
  }
}

async function clickAny(target /* page or frame */, selectors) {
  for (const sel of selectors) {
    const el = target.locator(sel).first();
    if (await el.count()) {
      await Promise.race([
        target.waitForLoadState?.("domcontentloaded", { timeout: 6000 }).catch(()=>{}),
        el.click({ timeout: 1500 }).catch(() => {})
      ]);
      return true;
    }
  }
  return false;
}

async function findInput(target /* page or frame */, selectors) {
  for (const sel of selectors) {
    const el = target.locator(sel).first();
    if (await el.count()) return el;
  }
  return null;
}

function getSerpaviFrame(page) {
  const frames = page.frames();
  for (const f of frames) {
    try {
      const u = f.url();
      if (isOnSerpavi(u)) return f;
    } catch {}
  }
  return null;
}

async function gotoSerpavi(ctx) {
  const page = await ctx.newPage();

  // Intento directo
  await page.goto("https://serpavi.mivau.gob.es/", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(()=>{});
  await acceptCookiesIfAny(page).catch(()=>{});
  if (isOnSerpavi(page.url()) || getSerpaviFrame(page)) return { page, frame: getSerpaviFrame(page) };

  // Página informativa y click a la app (mismo tab)
  await page.goto("https://www.mivau.gob.es/vivienda/alquila-bien-es-tu-derecho/serpavi", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(()=>{});
  await acceptCookiesIfAny(page).catch(()=>{});
  await clickAny(page, [
    'a[href*="serpavi.mivau.gob.es"]',
    'a:has-text("SERPAVI")',
    'a:has-text("Sistema Estatal de Referencia")',
    'a:has-text("precio del alquiler")',
  ]);
  await acceptCookiesIfAny(page).catch(()=>{});
  if (isOnSerpavi(page.url()) || getSerpaviFrame(page)) return { page, frame: getSerpaviFrame(page) };

  // Reintento directo
  await page.goto("https://serpavi.mivau.gob.es/", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(()=>{});
  await acceptCookiesIfAny(page).catch(()=>{});
  return { page, frame: getSerpaviFrame(page) };
}

async function ensureSerpaviContext(ctx) {
  const { page } = await Promise.race([
    gotoSerpavi(ctx),
    new Promise((_, rej) => setTimeout(() => rej(new Error("SERPAVI_UNREACHABLE")), 20000))
  ]);
  await acceptCookiesIfAny(page).catch(()=>{});
  const frame = getSerpaviFrame(page);
  return { page, target: frame ?? page };
}

async function fillRC(target /* frame or page */, rc) {
  // Activar pestaña "Referencia catastral" si existe
  await clickAny(target, [
    'role=tab[name=/referencia\\s*catastral/i]',
    'role=radio[name=/(referencia|ref\\.)\\s*catastral/i]',
    'text=/Referencia\\s*catastral/i'
  ]);

  const input = await findInput(target, [
    'input[placeholder*="catastral" i]',
    'input[name*="catastral" i]',
    'input[aria-label*="catastral" i]',
    'input[placeholder*="referencia" i]',
    'input[name*="referencia" i]',
    'input[aria-label*="referencia" i]',
    'input[type="text"]'
  ]);
  if (!input) return false;
  await input.fill(rc, { timeout: 4000 }).catch(()=>{});
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
  const group = target.getByRole("group", { name: groupRegex }).first();
  if (!(await group.count())) return;
  const radio = group.getByRole("radio", { name: yes ? /s[ií]|yes/i : /no/i }).first();
  if (await radio.count()) await radio.check().catch(()=>{});
}

// ---------- Rutas ----------
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get("/", (_req, res) => {
  res.type("text/plain").send(
`SERPAVI scraper
POST /  { rc, ascensor, planta, estado, etiqueta, aparcamiento?, amueblado?, dormitorios?, banos?, exterior? }
→ { ok:true, min, max, precio_ref }`
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
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      locale: "es-ES",
      ignoreHTTPSErrors: true,
    });

    // Bloquea recursos pesados/analytics para acelerar y evitar cuelgues (permitimos CSS)
    await ctx.route("**/*", (route) => {
      const req = route.request();
      const t = req.resourceType();
      const url = req.url();
      if (["image","font","media"].includes(t)) return route.abort();
      if (/analytics|googletag|gtm|hotjar|matomo|doubleclick|facebook|cook/i.test(url)) return route.abort();
      return route.continue();
    });

    const doWork = (async () => {
      // 1) Llegar a SERPAVI (page + target = frame|page)
      const { page, target } = await ensureSerpaviContext(ctx);

      target.setDefaultTimeout?.(12000);
      page.setDefaultTimeout(12000);
      page.setDefaultNavigationTimeout(15000);

      // 2) Entrar/continuar flujo dentro de SERPAVI
      await clickAny(target, [
        'role=button[name=/iniciar|acceder|consultar|buscar|calcular/i]',
        'text=/Iniciar|Acceder|Consultar|Buscar|Calcular/i'
      ]).catch(()=>{});

      // 3) RC (dentro del frame o página de la app)
      const rcOk = await fillRC(target, String(rc));
      if (!rcOk) {
        return {
          ok:false,
          error:`RC_INPUT_NOT_FOUND`,
          currentUrl: page.url(),
          frameUrl: target.url ? target.url() : null
        };
      }
      await clickAny(target, [
        'role=button[name=/buscar|consultar|calcular|continuar|siguiente/i]',
        'text=/Buscar|Consultar|Calcular|Continuar|Siguiente/i'
      ]);
      const firstInput = target.getByRole ? target.getByRole("textbox").first() : null;
      if (firstInput && await firstInput.count()) await firstInput.press("Enter").catch(()=>{});

      // 4) Atributos
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

      // 5) Calcular
      await clickAny(target, [
        'role=button[name=/buscar|calcular|continuar|siguiente/i]',
        'text=/Buscar|Calcular|Continuar|Siguiente/i'
      ]);

      // 6) Esperar resultados
      await target.waitForLoadState?.("domcontentloaded", { timeout: 12000 }).catch(()=>{});
      await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(()=>{});
      await target.waitForTimeout?.(1500).catch(()=>{});
      await page.waitForTimeout(1500).catch(()=>{});

      // 7) Extraer importes
      const anchors = [
        'text=/Precio\\s+de\\s+referencia/i',
        'text=/Rango/i',
        'section:has-text("Precio")',
        'div:has-text("Precio")',
        'main:has-text("Precio")',
      ];
      let min = null, max = null, precio_ref = null;

      for (const sel of anchors) {
        const el = target.locator(sel).first();
        if (await el.count()) {
          const txt = await el.evaluate(n => n.innerText || "");
          const r = extractRangeAndRef(txt);
          if (r.min != null && (min == null || r.min < min)) min = r.min;
          if (r.max != null && (max == null || r.max > max)) max = r.max;
          if (r.precio_ref != null) precio_ref = r.precio_ref;
        }
      }

      if (min == null && max == null && precio_ref == null) {
        const fullText = await (target.evaluate
          ? target.evaluate(() => document.body.innerText || "")
          : page.evaluate(() => document.body.innerText || ""));
        const r = extractRangeAndRef(fullText);
        min = r.min; max = r.max; precio_ref = r.precio_ref;

        if (!min && !max && !precio_ref) {
          return {
            ok:false,
            error:"UI_CHANGED",
            hint:"Ajustar patrones en extractRangeAndRef()",
            currentUrl: page.url(),
            frameUrl: target.url ? target.url() : null,
            sample: fullText.slice(0, 2000)
          };
        }
      }

      const out = sanitizeRange({ min, max, precio_ref }, "");
      return { ok:true, min: out.min ?? null, max: out.max ?? null, precio_ref: out.precio_ref ?? null, rc, via:"playwright" };
    })();

    const result = await Promise.race([
      doWork,
      new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT_GLOBAL_65s")), 65000))
    ]);

    if (result && result.ok) return res.json(result);
    if (result && result.ok === false) return res.status(200).json(result);
    return res.status(504).json({ ok:false, error:String(result || "timeout") });

  } catch (err) {
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SERPAVI scraper listening on", PORT));

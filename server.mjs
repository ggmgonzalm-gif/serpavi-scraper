// server.mjs
// SERPAVI scraper HTTP (Express + Playwright)
// - POST /  { rc, ascensor, planta, estado, etiqueta, aparcamiento?, amueblado?, dormitorios?, banos?, exterior? }
// - GET  /health
// Devuelve: { ok:true, min, max, precio_ref, via:"playwright" }  (o { ok:false, error, ...debug })

import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- CORS básico
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- Helpers numéricos / extracción ----------
function eurToNum(s) {
  if (!s) return null;
  const v = Number(String(s).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(v) ? v : null;
}
function sanitizeRange({ min, max, precio_ref }, text) {
  // Intercambia si vienen cruzados (p.ej. min=4213, max=30)
  if (min != null && max != null && min > max) [min, max] = [max, min];

  // Plausibilidad (€/mes)
  const plausible = (x) => x != null && x >= 100 && x <= 20000;
  if (min != null && !plausible(min)) min = null;
  if (max != null && !plausible(max)) max = null;

  // Si hay “Precio de referencia” explícito, úsalo
  if (precio_ref == null && text && /precio\s+de\s+referencia/i.test(text)) {
    const m = text.match(/precio\s+de\s+referencia[^\d\u20AC]*([\d\.\,]+)/i);
    if (m) precio_ref = eurToNum(m[1]);
  }

  return { min, max, precio_ref };
}
// Busca TODOS los importes con € y escoge un rango coherente
function pickRangeFromText(text) {
  const nums = [];
  const rx = /([\d]{2,3}(?:\.\d{3})*(?:,\d{1,2})?)\s*(?:\u20AC|euros?|eur)/gi;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const v = eurToNum(m[1]);
    if (v != null) nums.push(v);
  }
  nums.sort((a,b)=>a-b);
  // candidatos plausibles y separados razonablemente
  for (let i=0;i<nums.length-1;i++){
    const a=nums[i], b=nums[i+1];
    if (a>=100 && b>=100 && b-a>=10) return { min:a, max:b };
  }
  return { min: nums[0] ?? null, max: nums[1] ?? null };
}
// Extrae precios desde texto visible (varias variantes de SERPAVI)
function extractRangeAndRef(raw) {
  const t = String(raw || "").replace(/\s+/g, " ");

  // Precio referencia (dirigido)
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

  // Rango (900 – 1.100 €, 900-1100 €, etc.)
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

  // Saneado inicial
  let out = sanitizeRange({ min, max, precio_ref }, t);

  // Fallback: elegir por lista de importes con €
  if ((out.min == null && out.max == null) || (out.max != null && out.max < 100)) {
    const fb = pickRangeFromText(t);
    out = sanitizeRange({ ...out, ...fb }, t);
  }

  return out; // { min, max, precio_ref }
}

// ---------- Playwright helpers ----------
async function acceptCookiesIfAny(page) {
  const btns = [
    'button:has-text("Aceptar")',
    'button:has-text("Acepto")',
    'button:has-text("ACEPTAR")',
    '[id*="aceptar"]',
    '[id*="accept"]',
    'role=button[name=/acept|accept/i]',
  ];
  for (const sel of btns) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ timeout: 1000 }).catch(()=>{}); }
    } catch {}
  }
}
async function tryClick(page, selectors) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count()) {
      await el.click({ timeout: 1500 }).catch(()=>{});
      return true;
    }
  }
  return false;
}
async function fillRC(page, rc) {
  // Pestaña "Referencia catastral"
  const tabRC = page.getByRole("tab", { name: /referencia\s+catastral/i }).first();
  if (await tabRC.count()) await tabRC.click().catch(()=>{});

  const inputs = [
    'input[placeholder*="catastral" i]',
    'input[name*="catastral" i]',
    'input[aria-label*="catastral" i]',
    'input[type="search"]',
  ];
  for (const sel of inputs) {
    const el = page.locator(sel).first();
    if (await el.count()) { await el.fill(rc); return true; }
  }
  const any = page.getByRole("textbox").first();
  if (await any.count()) { await any.fill(rc); return true; }
  return false;
}
async function setSelectOrInput(page, labelRegex, value) {
  if (value == null || value === "") return;
  const sel = page.getByLabel(labelRegex, { exact: false }).first();
  if (!(await sel.count())) return;
  try {
    const tag = await sel.evaluate(el => el.tagName.toLowerCase());
    if (tag === "select") await sel.selectOption(String(value));
    else await sel.fill(String(value));
  } catch {}
}
async function setRadioYesNo(page, groupRegex, yes) {
  if (yes == null) return;
  const group = page.getByRole("group", { name: groupRegex }).first();
  if (!(await group.count())) return;
  const target = group.getByRole("radio", { name: yes ? /s[ií]|yes/i : /no/i }).first();
  if (await target.count()) await target.check().catch(()=>{});
}

async function reachSerpaviApp(ctx) {
  let page = await ctx.newPage();
  // 1) Intento directo
  await page.goto("https://serpavi.mivau.gob.es/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
  await acceptCookiesIfAny(page).catch(()=>{});
  try { if (new URL(page.url()).hostname === "serpavi.mivau.gob.es") return page; } catch {}
  // 2) Fallback: página informativa y salto a la app
  await page.goto("https://www.mivau.gob.es/vivienda/alquila-bien-es-tu-derecho/serpavi", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
  await acceptCookiesIfAny(page).catch(()=>{});
  const candidates = [
    'a[href*="serpavi.mivau.gob.es"]',
    'a:has-text("SERPAVI")',
    'a:has-text("Sistema Estatal de Referencia")',
    'a:has-text("precio del alquiler")',
  ];
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if (await el.count()) {
      const [newPage] = await Promise.all([
        ctx.waitForEvent("page").catch(()=>null),
        el.click({ button:"middle" }).catch(()=>{})
      ]);
      if (newPage) {
        await newPage.waitForLoadState("domcontentloaded").catch(()=>{});
        await acceptCookiesIfAny(newPage).catch(()=>{});
        try { if (new URL(newPage.url()).hostname === "serpavi.mivau.gob.es") return newPage; } catch {}
      }
    }
  }
  // 3) Último intento directo
  await page.goto("https://serpavi.mivau.gob.es/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
  await acceptCookiesIfAny(page).catch(()=>{});
  return page;
}

// ---------- Rutas ----------
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});
app.get("/", (req, res) => {
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
      // obligatorios para exactitud
      ascensor, planta, estado, etiqueta,
      // opcionales (no imprescindibles para scraping)
      aparcamiento, amueblado, dormitorios, banos, exterior,
      m2, dir, prov, muni, antiguedad
    } = req.body || {};

    if (!rc || !/^[A-Z0-9]{20}$/.test(String(rc))) {
      return res.status(400).json({ ok:false, error:"RC inválida (debe tener 20 caracteres alfanuméricos)" });
    }

    const required = { ascensor, planta, estado, etiqueta };
    const missing = Object.entries(required)
      .filter(([_,v]) => v===undefined || v===null || v==="")
      .map(([k])=>k);
    if (missing.length) {
      return res.status(200).json({ ok:true, needs: missing, hint: "Faltan atributos para completar el cálculo en SERPAVI" });
    }

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    });
    const page = await reachSerpaviApp(ctx);
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(20000);

    const doWork = (async () => {
      // Flujo principal
      await tryClick(page, [
        'role=button[name=/iniciar|acceder|consultar|buscar|calcular/i]',
        'text=/Iniciar|Acceder|Consultar|Buscar|Calcular/i'
      ]).catch(()=>{});

      // RC
      await fillRC(page, String(rc));
      await tryClick(page, [
        'role=button[name=/buscar|consultar|calcular|continuar|siguiente/i]',
        'text=/Buscar|Consultar|Calcular|Continuar|Siguiente/i'
      ]);
      const firstInput = page.getByRole("textbox").first();
      if (await firstInput.count()) await firstInput.press("Enter").catch(()=>{});

      // Atributos (si aparecen)
      await setSelectOrInput(page, /planta/i, planta);
      await setSelectOrInput(page, /estado/i, estado);
      const et = String(etiqueta || "").trim().toUpperCase();
      if (["A","B","C","D","E","F","G"].includes(et)) {
        await setSelectOrInput(page, /etiqueta/i, et);
      }
      await setRadioYesNo(page, /ascensor/i, !!ascensor);
      await setRadioYesNo(page, /(aparcamiento|parking)/i, !!aparcamiento);
      await setRadioYesNo(page, /amueblado/i, !!amueblado);
      await setRadioYesNo(page, /exterior/i, !!exterior);
      if (dormitorios != null) await setSelectOrInput(page, /dormitorios|habitaciones/i, dormitorios);
      if (banos != null)       await setSelectOrInput(page, /ba(ñ|n)os/i, banos);

      // Calcular
      await tryClick(page, [
        'role=button[name=/buscar|calcular|continuar|siguiente/i]',
        'text=/Buscar|Calcular|Continuar|Siguiente/i'
      ]);

      // Esperas
      await page.waitForTimeout(2500);
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(()=>{});

      // Intentar extraer desde nodos ancla
      const anchors = [
        'text=/Precio\\s+de\\s+referencia/i',
        'text=/Rango/i',
        'section:has-text("Precio")',
        'div:has-text("Precio")',
        'main:has-text("Precio")',
      ];
      let min=null,max=null,precio_ref=null;
      for (const sel of anchors) {
        const el = page.locator(sel).first();
        if (await el.count()) {
          const txt = await el.evaluate(n=>n.innerText||"");
          const r = extractRangeAndRef(txt);
          if (r.min!=null && (min==null || r.min<min)) min = r.min;
          if (r.max!=null && (max==null || r.max>max)) max = r.max;
          if (r.precio_ref!=null) precio_ref = r.precio_ref;
        }
      }

      // Fallback: texto completo del body
      if (min==null && max==null && precio_ref==null) {
        const fullText = await page.evaluate(() => document.body.innerText || "");
        const r = extractRangeAndRef(fullText);
        min = r.min; max = r.max; precio_ref = r.precio_ref;
        if (!min && !max && !precio_ref) {
          const html = await page.content().catch(()=>null);
          const shot = await page.screenshot({ fullPage: true }).catch(()=>null);
          return { ok:false,
            error:"No se pudo extraer el rango. La UI puede haber cambiado.",
            debug_hint:"Ajusta patrones/seletores en extractRangeAndRef()",
            sample: fullText.slice(0,2000),
            html: html ? html.slice(0,2000) : null,
            screenshot_base64: shot ? Buffer.from(shot).toString("base64") : null
          };
        }
      }

      // Saneado final
      const out = sanitizeRange({ min, max, precio_ref }, "");
      return { ok:true, min: out.min ?? null, max: out.max ?? null, precio_ref: out.precio_ref ?? null, rc, via:"playwright" };
    })();

    const result = await Promise.race([
      doWork,
      new Promise((_, rej) => setTimeout(()=>rej(new Error("TIMEOUT 45s")), 45000))
    ]);

    if (result && result.ok) {
      return res.json(result);
    } else if (result && result.ok === false) {
      return res.status(200).json(result);
    } else {
      return res.status(504).json({ ok:false, error:String(result || "timeout") });
    }

  } catch (err) {
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SERPAVI scraper listening on", PORT));

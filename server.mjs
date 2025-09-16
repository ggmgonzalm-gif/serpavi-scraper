// server.mjs
// SERPAVI scraper HTTP (Express + Playwright)
// - POST /  { rc, ascensor, planta, estado, etiqueta, aparcamiento?, amueblado?, dormitorios?, banos?, exterior?, m2?, dir?, prov?, muni?, antiguedad? }
// - GET  /health
// Devuelve: { ok:true, min, max, precio_ref }  (o { ok:false, error })

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
async function reachSerpaviApp(ctx) {
  let page = await ctx.newPage();
  // intento directo
  await page.goto("https://serpavi.mivau.gob.es/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
  await acceptCookiesIfAny(page).catch(()=>{});
  try { if (new URL(page.url()).hostname === "serpavi.mivau.gob.es") return page; } catch {}
  // fallback: entrar por la página informativa y saltar a SERPAVI
  await page.goto("https://www.mivau.gob.es/vivienda/alquila-bien-es-tu-derecho/serpavi", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
  await acceptCookiesIfAny(page).catch(()=>{});
  const candidates = [
    'a[href*="serpavi.mivau.gob.es"]',
    'a:has-text("SERPAVI")',
    'a:has-text("Sistema Estatal de Referencia")'
  ];
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if (await el.count()) {
      const [newPage] = await Promise.all([ctx.waitForEvent("page").catch(()=>null), el.click({ button:"middle" }).catch(()=>{})]);
      if (newPage) {
        await newPage.waitForLoadState("domcontentloaded").catch(()=>{});
        await acceptCookiesIfAny(newPage).catch(()=>{});
        try { if (new URL(newPage.url()).hostname === "serpavi.mivau.gob.es") return newPage; } catch {}
      }
    }
  }
  return page;
}

// --- Utils
const toNum = (s) => {
  if (s == null) return null;
  const v = parseFloat(String(s).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(v) ? v : null;
};

// Extrae precios desde texto visible (varias variantes de SERPAVI)
function extractRangeAndRef(raw) {
  const t = String(raw || "").replace(/\s+/g, " ");

  // Precio referencia
  const refPatterns = [
    /precio\s+de\s+referencia[^\d\u20AC]*([\d\.\,]+)/i,
    /precio\s+referencia[^\d\u20AC]*([\d\.\,]+)/i,
    /precio\s+m[aá]ximo\s+de\s+referencia[^\d\u20AC]*([\d\.\,]+)/i,
  ];
  let precio_ref = null;
  for (const rx of refPatterns) {
    const m = t.match(rx);
    if (m) { precio_ref = toNum(m[1]); break; }
  }

  // Rango (900 – 1.100 €, 900-1100 €, etc.)
  const rangePatterns = [
    /rango[^\d\u20AC]*([\d\.\,]+)\D+([\d\.\,]+)/i,
    /entre[^\d\u20AC]*([\d\.\,]+)\D+([\d\.\,]+)\s*(?:\u20AC|eur)?/i,
    /m[ií]nimo[^\d\u20AC]*([\d\.\,]+)[^\d]+m[aá]ximo[^\d\u20AC]*([\d\.\,]+)/i,
  ];
  let min = null, max = null;
  for (const rx of rangePatterns) {
    const m = t.match(rx);
    if (m) { min = toNum(m[1]); max = toNum(m[2]); break; }
  }

  return { min, max, precio_ref };
}

async function acceptCookiesIfAny(page) {
  const btns = [
    'button:has-text("Aceptar")',
    'button:has-text("Acepto")',
    'button:has-text("ACEPTAR")',
    'role=button[name=/acept/i]',
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

  // Inputs típicos
  const inputs = [
    'input[placeholder*="catastral" i]',
    'input[name*="catastral" i]',
    'input[aria-label*="catastral" i]',
  ];
  for (const sel of inputs) {
    const el = page.locator(sel).first();
    if (await el.count()) { await el.fill(rc); return true; }
  }
  // Fallback
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

// --- Rutas
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
      // opcionales
      aparcamiento, amueblado, dormitorios, banos, exterior,
      // info extra (no imprescindible para el scraping)
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

    // Navegador (flags seguros para PaaS)
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    });
    const page = await ctx.newPage();

    try {
      // 1) SERPAVI
      await page.goto("https://serpavi.mivau.gob.es/", { waitUntil: "domcontentloaded", timeout: 60000 });
      await acceptCookiesIfAny(page);

      // 2) Entrar al flujo
      await tryClick(page, [
        'role=button[name=/iniciar|acceder|consultar|buscar/i]',
        'text=/Iniciar|Acceder|Consultar/i'
      ]);

      // 3) RC
      await fillRC(page, String(rc));

      // 4) Atributos (si aparecen)
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

      // 5) Calcular
      await tryClick(page, [
        'role=button[name=/buscar|calcular|continuar|siguiente/i]',
        'text=/Buscar|Calcular|Continuar|Siguiente/i'
      ]);

      // 6) Esperar resultados
      await page.waitForTimeout(2500);
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(()=>{});

      // 7) Extraer del DOM
      const fullText = await page.evaluate(() => document.body.innerText || "");
      const { min, max, precio_ref } = extractRangeAndRef(fullText);

      if (!min && !max && !precio_ref) {
        return res.status(200).json({
          ok:false,
          error: "No se pudo extraer el rango. La UI puede haber cambiado.",
          debug_hint: "Actualiza los patrones de extracción en extractRangeAndRef()",
          sample: fullText.slice(0, 3000)
        });
      }

      return res.json({ ok:true, min, max, precio_ref, rc, via:"playwright" });
    } catch (e) {
      return res.status(500).json({ ok:false, error: String(e) });
    } finally {
      await ctx.close().catch(()=>{});
      await browser.close().catch(()=>{});
    }
  } catch (err) {
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SERPAVI scraper listening on", PORT));

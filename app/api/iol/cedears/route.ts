// Route handler (App Router) — proxy autenticado a la API de InvertirOnline (IOL).
//
// El navegador llama a /api/iol/cedears?plazo=t0 (o t1) y recibe un array con la
// MISMA forma que el feed de data912 (CedearRow), para que el frontend y el motor
// de arbitraje no distingan la fuente. Las credenciales viven SOLO como env vars
// del lado servidor (IOL_USERNAME / IOL_PASSWORD) — nunca llegan al cliente.
//
// Plazos (auditoría 2026-06-09):
//  - El PANEL (/api/v2/Cotizaciones/cedears/argentina/Todos) IGNORA el parámetro
//    plazo: siempre devuelve el libro de 24hs (t0/t1/orleans dan lo mismo).
//  - El único endpoint que honra el plazo es la cotización POR SÍMBOLO
//    (/api/v2/bCBA/Titulos/{sym}/Cotizacion?model.plazo=t0).
//
// Por eso:
//  - plazo=t1 → panel completo (libro 24hs real, ~900 símbolos).
//  - plazo=t0 → panel para descubrir pares (base + baseD/baseC) con liquidez,
//    y luego cotización por símbolo en paralelo acotado SOLO para ese subset.
//    Devuelve menos filas, pero todas con libro CI (T+0) real.

import type { CedearRow } from '@/lib/market.config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IOL = 'https://api.invertironline.com';

// Selección del subset CI: pares con volumen efectivo (USD) mínimo en alguna
// punta, rankeados por liquidez, con tope por sufijo para acotar las llamadas.
const CI_MIN_USD = Number(process.env.IOL_CI_MIN_USD) || 500;
const CI_TOP_PER_SUFFIX = Number(process.env.IOL_CI_TOP) || 30;
const CI_CONCURRENCY = 20;

// Cache muy corto del panel: sólo deduplica requests del panel que caen casi
// simultáneas (t1 + el panel que necesita el burst t0). Bajo a 500ms para no
// agregar staleness: el panel es 1 sola request, no hace falta cachearlo más.
const PANEL_TTL_MS = 500;
let panelCache: { rows: CedearRow[] | null; exp: number } = { rows: null, exp: 0 };

// Cache del token a nivel de módulo (persiste entre invocaciones "warm").
let tokenCache: { access: string | null; refresh: string | null; exp: number } = {
  access: null,
  refresh: null,
  exp: 0,
};

// Error con status HTTP propio (el original le colgaba `err.status = 502`).
interface HttpError extends Error {
  status?: number;
}

// Respuesta del endpoint /token de IOL (OAuth2 password / refresh_token grant).
interface IolTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number | string;
}

// Puntas del libro tal como las devuelve IOL (todo puede venir null/string).
interface IolPuntas {
  cantidadCompra?: number | string | null;
  precioCompra?: number | string | null;
  precioVenta?: number | string | null;
  cantidadVenta?: number | string | null;
}

// Título del panel. `simbolo` se tipa requerido porque el .filter(x => x.symbol)
// de abajo es el que cubre el caso real de que venga vacío.
interface IolTitulo {
  simbolo: string;
  puntas?: IolPuntas | null;
  volumen?: number | string | null;
  cantidadOperaciones?: number | string | null;
  ultimoCierre?: number | string | null;
  variacionPorcentual?: number | string | null;
}

interface IolPanelResponse {
  titulos?: IolTitulo[] | null;
}

// Cotización por símbolo (/Cotizacion?model.plazo=…) — otra forma de dato:
// puntas es un ARRAY y los campos de volumen/cierre/variación cambian de nombre.
interface IolCotizacion {
  puntas?: IolPuntas[] | null;
  volumenNominal?: number | string | null;
  cantidadOperaciones?: number | string | null;
  cierreAnterior?: number | string | null;
  variacion?: number | string | null;
}

async function authPassword(): Promise<Response> {
  const username = process.env.IOL_USERNAME;
  const password = process.env.IOL_PASSWORD;
  if (!username || !password) {
    throw new Error('IOL credentials not configured (set IOL_USERNAME / IOL_PASSWORD)');
  }
  const body = new URLSearchParams({ grant_type: 'password', username, password });
  return fetch(`${IOL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function authRefresh(refresh: string): Promise<Response> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh });
  return fetch(`${IOL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function getToken(): Promise<string> {
  const now = Date.now();
  // Token vigente (con 30s de margen).
  if (tokenCache.access && now < tokenCache.exp - 30_000) return tokenCache.access;

  // 1) Intento refrescar si tengo refresh_token.
  let res: Response | null = null;
  if (tokenCache.refresh) {
    try {
      res = await authRefresh(tokenCache.refresh);
      if (!res.ok) res = null;
    } catch {
      res = null;
    }
  }
  // 2) Si no, auth con usuario/contraseña.
  if (!res) res = await authPassword();
  if (!res.ok) {
    throw new Error(`IOL auth failed (${res.status})`);
  }

  const j = (await res.json()) as IolTokenResponse;
  const access = j.access_token;
  tokenCache = {
    access,
    refresh: j.refresh_token || tokenCache.refresh,
    exp: Date.now() + (Number(j.expires_in) || 1200) * 1000,
  };
  return access;
}

// IOL titulo del panel → CedearRow (misma forma que data912 /live/arg_cedears).
function mapRow(t: IolTitulo): CedearRow {
  const p: IolPuntas = t.puntas || {};
  return {
    symbol: t.simbolo,
    q_bid: Number(p.cantidadCompra) || 0,
    px_bid: Number(p.precioCompra) || 0,
    px_ask: Number(p.precioVenta) || 0,
    q_ask: Number(p.cantidadVenta) || 0,
    v: Number(t.volumen) || 0,
    q_op: Number(t.cantidadOperaciones) || 0,
    c: Number(t.ultimoCierre) || 0,
    pct_change: Number(t.variacionPorcentual) || 0,
  };
}

// Panel completo de CEDEARs (libro 24hs). Reintenta una vez ante 401.
async function fetchPanel(token: string): Promise<CedearRow[]> {
  if (panelCache.rows && Date.now() < panelCache.exp) return panelCache.rows;
  const url =
    `${IOL}/api/v2/Cotizaciones/cedears/argentina/Todos` +
    `?cotizacionInstrumentoModel.instrumento=cedears` +
    `&cotizacionInstrumentoModel.pais=argentina`;

  let r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  // 401 → token vencido en medio: forzar re-auth una vez.
  if (r.status === 401) {
    tokenCache = { access: null, refresh: null, exp: 0 };
    const fresh = await getToken();
    r = await fetch(url, { headers: { Authorization: `Bearer ${fresh}` } });
  }

  if (!r.ok) {
    const err: HttpError = new Error(`IOL panel error (${r.status})`);
    err.status = 502;
    throw err;
  }

  const data = (await r.json()) as IolPanelResponse;
  const rows = (data.titulos || []).map(mapRow).filter((x) => x.symbol);
  panelCache = { rows, exp: Date.now() + PANEL_TTL_MS };
  return rows;
}

// Cotización por símbolo con plazo REAL. puntas[0] = tope del libro.
async function fetchT0Quote(token: string, sym: string): Promise<CedearRow | null> {
  const url =
    `${IOL}/api/v2/bCBA/Titulos/${encodeURIComponent(sym)}/Cotizacion` +
    `?model.mercado=bCBA&model.simbolo=${encodeURIComponent(sym)}&model.plazo=t0`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const j = (await r.json()) as IolCotizacion;
  const p: IolPuntas = (Array.isArray(j.puntas) && j.puntas[0]) || {};
  return {
    symbol: sym,
    q_bid: Number(p.cantidadCompra) || 0,
    px_bid: Number(p.precioCompra) || 0,
    px_ask: Number(p.precioVenta) || 0,
    q_ask: Number(p.cantidadVenta) || 0,
    v: Number(j.volumenNominal) || 0,
    q_op: Number(j.cantidadOperaciones) || 0,
    c: Number(j.cierreAnterior) || 0,
    pct_change: Number(j.variacion) || 0,
  };
}

// Desde el panel de 24hs, elegir los símbolos (base + pata USD) de los pares
// más líquidos por sufijo. Volumen efectivo = misma convención que el motor:
//   buyLeg  = min(qArsAsk, qUsdBid) * usdBid
//   sellLeg = min(qUsdAsk, qArsBid) * usdAsk
//
// La selección (qué símbolos entran, top N por volumen) es independiente por
// sufijo D/C — eso NO cambia. Lo que sí importa es el ORDEN del array final:
// las dos pasadas se resuelven primero, y recién después se arma un único
// array agrupando TODAS las patas de un mismo base de forma contigua (base,
// baseD si aplica, baseC si aplica). Antes se armaba con un Set poblado en
// dos pasadas (D completa, después C): un base líquido en ambos sufijos
// quedaba con su pata D temprano (primera pasada) y su pata C recién al
// final (Set.add es no-op si ya existe, así que la posición original de
// `base` no se movía, pero `baseC` se insertaba después de hasta ~60
// entradas D). Con mapLimit despachando por índice entre 20 workers, eso
// separaba ambas patas del mismo par por el largo entero del burst (medido:
// hasta ~1.4s — ver vicend-arbitraje-batch). Agrupar por base elimina esa
// separación: las patas de un mismo par quedan en la misma ronda de
// concurrencia o una adyacente.
function pickLiquidSymbols(rows: CedearRow[], minUsd: number, topPerSuffix: number): string[] {
  const bySymbol = new Map<string, CedearRow>(rows.map((r) => [r.symbol, r]));

  // Selección sin cambios: top N por volumen efectivo, independiente por sufijo.
  const selectedBySuffix = { D: new Set<string>(), C: new Set<string>() };
  for (const suffix of ['D', 'C'] as const) {
    const scored: { base: string; vol: number }[] = [];
    for (const ars of rows) {
      const base = ars.symbol;
      if (base.endsWith('C') || base.endsWith('D')) continue;
      const usd = bySymbol.get(base + suffix);
      if (!usd) continue;
      if (!(ars.px_bid > 0 && ars.px_ask > 0 && usd.px_bid > 0 && usd.px_ask > 0)) continue;
      const buyLeg = Math.min(ars.q_ask, usd.q_bid) * usd.px_bid;
      const sellLeg = Math.min(usd.q_ask, ars.q_bid) * usd.px_ask;
      const vol = Math.max(buyLeg, sellLeg);
      if (vol < minUsd) continue;
      scored.push({ base, vol });
    }
    scored.sort((a, b) => b.vol - a.vol);
    for (const s of scored.slice(0, topPerSuffix)) selectedBySuffix[suffix].add(s.base);
  }

  // Array final: un base por vez, con TODAS sus patas seleccionadas justo
  // al lado (base, baseD, baseC) — sin duplicados, sin cambiar qué se eligió.
  const bases = new Set([...selectedBySuffix.D, ...selectedBySuffix.C]);
  const symbols: string[] = [];
  for (const base of bases) {
    symbols.push(base);
    if (selectedBySuffix.D.has(base)) symbols.push(base + 'D');
    if (selectedBySuffix.C.has(base)) symbols.push(base + 'C');
  }
  return symbols;
}

// map con concurrencia acotada; los fallos individuales devuelven null.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R | null>,
): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch(() => null);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function GET(req: Request) {
  try {
    const raw = new URL(req.url).searchParams.get('plazo') || 't1';
    const plazo = raw === 't0' || raw === 't1' || raw === 't2' ? raw : 't1';

    const token = await getToken();
    const panel = await fetchPanel(token);

    // 24hs (o t2): el panel ya es ese libro.
    if (plazo !== 't0') {
      // no-store: el CDN no debe servir cotizaciones viejas. La frescura manda
      // sobre el ahorro de requests (era el mayor ofensor de latencia).
      return Response.json(panel, { status: 200, headers: { 'Cache-Control': 'no-store' } });
    }

    // CI: cotización por símbolo (plazo real) para el subset líquido.
    const symbols = pickLiquidSymbols(panel, CI_MIN_USD, CI_TOP_PER_SUFFIX);
    const quotes = await mapLimit(symbols, CI_CONCURRENCY, (s) => fetchT0Quote(token, s));
    const rows = quotes.filter((q) => q && q.symbol && (q.px_bid > 0 || q.px_ask > 0));

    // Si el burst falló por completo, [] dispara el fallback (data912 estimado)
    // en el frontend en vez de mostrar un CI "real" vacío.
    return Response.json(rows, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const err = e as HttpError | undefined;
    const status = (err && err.status) || 500;
    return Response.json({ error: String((err && err.message) || err) }, { status });
  }
}

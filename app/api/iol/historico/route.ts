// Route handler (App Router) — serie histórica (OHLC) de un título en IOL.
//
// El navegador llama a /api/iol/historico?mercado=bCBA&simbolo=AL30&rango=1M
// (&ajustada=ajustada|sinAjustar, default 'sinAjustar') y recibe el array tal
// cual lo entrega IOL — no se remapea a CedearRow: es una forma de dato nueva
// (serie, no punta). Mismo patrón de auth/caché que api/iol/panel.js: token
// cacheado a nivel de módulo, re-auth ante 401. Las credenciales viven SOLO
// como env vars del lado servidor (IOL_USERNAME / IOL_PASSWORD) — nunca
// llegan al cliente.
//
// GET /api/v2/{mercado}/Titulos/{simbolo}/Cotizacion/seriehistorica/{fechaDesde}/{fechaHasta}/{ajustada}
// (docs/api-iol.md §2.4)
//
// OJO — auditado contra la respuesta real 2026-07-14: los nombres de campo NO
// son los que sugiere la doc (no hay "cierre" ni "fecha" ni "volumen"). Cada
// punto trae, entre otros, `fechaHora` (ISO), `apertura`, `maximo`, `minimo`,
// `ultimoPrecio` (el cierre de esa rueda, en una serie diaria) y
// `volumenNominal`. Además el array viene con la fecha más reciente PRIMERO
// (orden descendente) — el frontend lo reordena a ascendente para el gráfico.
//
// OJO 2 — auditado 2026-07-14: en esta cuenta, la variante `ajustada` viene
// VACÍA para CEDEARs/bonos y muy truncada para acciones (∼19 puntos en vez de
// ~1300 en el mismo rango). `sinAjustar` sí trae la serie completa para TODOS
// los tipos de instrumento probados (GGAL, PAMP, YPFD, AAPL, KO, MSFT, VALE,
// BABA, AL30). Por eso el default es `sinAjustar`, no `ajustada`.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IOL = 'https://api.invertironline.com';

// El CDN no debe servir series viejas (mismo criterio que el resto de /api/iol/*).
// En el original era un res.setHeader() ANTES del try, así que aplica a TODAS
// las respuestas de este handler — incluidos el 400 y el 200 vacío del catch.
const NO_STORE = { 'Cache-Control': 'no-store' };

// Días atrás por rango. MAX es un tope razonable (5 años), no todo el historial.
const RANGO_DIAS: Record<string, number> = {
  '1S': 7,
  '1M': 30,
  '6M': 182,
  '1A': 365,
  MAX: 1825,
};

const MERCADOS = new Set<string>(['bCBA', 'nYSE', 'nASDAQ', 'aMEX', 'bCS', 'rOFX']);

// Cache del token a nivel de módulo (persiste entre invocaciones "warm").
let tokenCache: { access: string | null; refresh: string | null; exp: number } = {
  access: null,
  refresh: null,
  exp: 0,
};

// Respuesta del endpoint /token de IOL (OAuth2 password / refresh_token grant).
interface IolTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number | string;
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
  if (tokenCache.access && now < tokenCache.exp - 30_000) return tokenCache.access;

  let res: Response | null = null;
  if (tokenCache.refresh) {
    try {
      res = await authRefresh(tokenCache.refresh);
      if (!res.ok) res = null;
    } catch {
      res = null;
    }
  }
  if (!res) res = await authPassword();
  if (!res.ok) throw new Error(`IOL auth failed (${res.status})`);

  const j = (await res.json()) as IolTokenResponse;
  const access = j.access_token;
  tokenCache = {
    access,
    refresh: j.refresh_token || tokenCache.refresh,
    exp: Date.now() + (Number(j.expires_in) || 1200) * 1000,
  };
  return access;
}

// yyyy-MM-dd — formato de fecha que pide el endpoint de serie histórica.
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams;
    const simbolo = String(q.get('simbolo') || '').trim();
    if (!simbolo) {
      return Response.json({ error: 'falta simbolo' }, { status: 400, headers: NO_STORE });
    }
    const rawMercado = q.get('mercado') || '';
    const mercado = MERCADOS.has(rawMercado) ? rawMercado : 'bCBA';
    const rawRango = q.get('rango') || '';
    const rango = RANGO_DIAS[rawRango] ? rawRango : '1M';
    // Default 'sinAjustar': 'ajustada' devuelve vacío/truncado en esta cuenta
    // (ver nota arriba) — sólo se usa 'ajustada' si el caller la pide explícito.
    const ajustada = q.get('ajustada') === 'ajustada' ? 'ajustada' : 'sinAjustar';

    const dias = RANGO_DIAS[rango];
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - dias * 86_400_000);

    const url =
      `${IOL}/api/v2/${mercado}/Titulos/${encodeURIComponent(simbolo)}/Cotizacion/seriehistorica/` +
      `${ymd(desde)}/${ymd(hasta)}/${ajustada}`;

    const token = await getToken();
    let r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    // 401 → token vencido en medio: forzar re-auth una vez.
    if (r.status === 401) {
      tokenCache = { access: null, refresh: null, exp: 0 };
      const fresh = await getToken();
      r = await fetch(url, { headers: { Authorization: `Bearer ${fresh}` } });
    }

    // Serie histórica es sólo para el gráfico de Ficha: si IOL falla o viene
    // vacío, el frontend debe poder mostrar un estado vacío, no romper.
    if (!r.ok) {
      return Response.json([], { status: 200, headers: NO_STORE });
    }

    const data: unknown = await r.json();
    return Response.json(Array.isArray(data) ? data : [], { status: 200, headers: NO_STORE });
  } catch (e) {
    const err = e as Error | undefined;
    console.error('iol/historico error:', err && err.message ? err.message : err);
    return Response.json([], { status: 200, headers: NO_STORE });
  }
}

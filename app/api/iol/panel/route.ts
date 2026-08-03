// Route handler (App Router) — panel genérico de cotizaciones de IOL.
//
// El navegador llama a /api/iol/panel?id=bonos (acciones | bonos | letras |
// ons | opciones | usa) y recibe un array con la MISMA forma que los feeds de
// data912, para que el frontend no distinga la fuente. IOL es la fuente
// PRIMARIA de la pantalla Cotizaciones; si esta función falla o devuelve
// vacío, el frontend cae a data912 (ver refreshFast en app.ts). Las
// credenciales viven SOLO como env vars del lado servidor
// (IOL_USERNAME / IOL_PASSWORD) — nunca llegan al cliente.

import type { CedearRow } from '@/lib/market.config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IOL = 'https://api.invertironline.com';

// id de panel del frontend → {instrumento, pais} de IOL (relevado 2026-07-08:
// 'bonos' devuelve 0 títulos; los bonos soberanos viven en 'titulosPublicos').
const PANELS: Record<string, { instrumento: string; pais: string } | undefined> = {
  acciones: { instrumento: 'acciones',                pais: 'argentina' },
  bonos:    { instrumento: 'titulosPublicos',         pais: 'argentina' },
  letras:   { instrumento: 'letras',                  pais: 'argentina' },
  ons:      { instrumento: 'obligacionesNegociables', pais: 'argentina' },
  opciones: { instrumento: 'opciones',                pais: 'argentina' },
  usa:      { instrumento: 'acciones',                pais: 'estados_Unidos' },
};

// Fila del panel: misma forma que CedearRow, más `desc` opcional. Espeja
// PanelRow de lib/operar.types.ts (el consumidor); acá se declara del lado
// del productor para que el handler no dependa de un archivo de otro agente.
interface PanelRow extends CedearRow {
  desc?: string;
}

// Cache corto por panel: dedupea el polling de 1s del frontend (6 paneles)
// sin sumar staleness relevante — estos paneles no son el camino crítico del
// arbitraje (ese sigue en api/iol/cedears.js con su propio ciclo).
const PANEL_TTL_MS = 3000;
const cache = new Map<string, { rows: PanelRow[]; exp: number }>(); // id -> { rows, exp }

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
  descripcion?: string | null;
}

interface IolPanelResponse {
  titulos?: IolTitulo[] | null;
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

// IOL titulo del panel → misma forma que data912, más `desc` (descripción
// legible del título; data912 no la trae y para ONs/bonos suma mucho).
function mapRow(t: IolTitulo): PanelRow {
  const p: IolPuntas = t.puntas || {};
  const row: PanelRow = {
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
  if (t.descripcion) row.desc = t.descripcion;
  return row;
}

export async function GET(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get('id') || '';
    const def = PANELS[id];
    if (!def) {
      return Response.json({ error: `panel desconocido: ${id}` }, { status: 400 });
    }

    const hit = cache.get(id);
    if (hit && Date.now() < hit.exp) {
      return Response.json(hit.rows, { status: 200, headers: { 'Cache-Control': 'no-store' } });
    }

    const token = await getToken();
    const url =
      `${IOL}/api/v2/Cotizaciones/${def.instrumento}/${def.pais}/Todos` +
      `?cotizacionInstrumentoModel.instrumento=${def.instrumento}` +
      `&cotizacionInstrumentoModel.pais=${def.pais}`;

    let r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    // 401 → token vencido en medio: forzar re-auth una vez.
    if (r.status === 401) {
      tokenCache = { access: null, refresh: null, exp: 0 };
      const fresh = await getToken();
      r = await fetch(url, { headers: { Authorization: `Bearer ${fresh}` } });
    }

    if (!r.ok) {
      return Response.json({ error: `IOL panel error (${r.status})` }, { status: 502 });
    }

    const data = (await r.json()) as IolPanelResponse;
    const rows = (data.titulos || []).map(mapRow).filter((x) => x.symbol);
    cache.set(id, { rows, exp: Date.now() + PANEL_TTL_MS });

    // no-store: el CDN no debe servir cotizaciones viejas.
    return Response.json(rows, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const err = e as Error | undefined;
    return Response.json({ error: String((err && err.message) || err) }, { status: 500 });
  }
}

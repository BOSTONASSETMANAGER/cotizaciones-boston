// Route handler (App Router) — FCIs (fondos comunes de inversión) de IOL.
//
// El navegador llama a /api/iol/fondos y recibe un array normalizado de
// fondos para la sección "Fondos" del Home de Operar. A diferencia de
// panel.js/cedears.js, NO hay feed de fallback: data912 no cubre FCIs (sólo
// acciones/cedears/bonos/letras/ONs/opciones ARG, ver market.config.ts) — si
// esta función falla, el frontend muestra un estado vacío/error explícito,
// nunca un valor inventado ($0 o similar). Las credenciales viven SOLO como
// env vars del lado servidor (IOL_USERNAME / IOL_PASSWORD) — nunca llegan al
// cliente.
//
// GET /api/v2/Titulos/FCI (docs/api-iol.md §2.7) no requiere el permiso de
// Operatoria que la cuenta de Boston todavía no tiene habilitado (eso sólo
// aplica a comprar/vender/suscripción/rescate de fondos, §4) — es un
// endpoint de CONSULTA con el mismo token básico que ya usan panel.js/
// cedears.js. Probado 2026-07-20 contra la cuenta real: 200 OK, 20 fondos.
//
// La doc (§2.7) no documentaba la forma de la respuesta — el mapeo de campos
// de abajo sale de inspeccionar la respuesta real, no del swagger:
//   simbolo, descripcion, tipoFondo (enum: renta_fija_pesos,
//   renta_fija_dolares, renta_variable_pesos, renta_mixta_pesos,
//   plazo_fijo_pesos, plazo_fijo_dolares, …), moneda, ultimoOperado,
//   variacion (diaria), variacionMensual, variacionAnual, montoMinimo,
//   perfilInversor, horizonteInversion. NO hay ningún campo "TNA" ni tasa
//   nominal — variacion/variacionMensual/variacionAnual son todos
//   rendimientos reales con signo (ver operar.component.ts, homeFondos()).

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IOL = 'https://api.invertironline.com';

// Cache corto: los FCI no cambian de valor cuota más de una vez al día (no
// son como una acción que se mueve cada segundo), pero se mantiene un TTL
// chico simplemente para dedupear navegación rápida entre Home y otras
// vistas, mismo mecanismo que panel.js (ahí el TTL es corto por el polling
// de 1s; acá no hay polling, así que un TTL algo mayor no cuesta nada).
const FONDOS_TTL_MS = 30_000;

// Fila de FCI que devuelve este handler. Espeja FondoRow de
// lib/operar.types.ts (el consumidor); acá se declara del lado del productor
// para que el handler no dependa de un archivo de otro agente.
interface FondoRow {
  symbol: string;
  name: string;
  tipoFondo: string | null;
  moneda: string | null;
  valorCuota: number;
  variacionDiaria: number;
  variacionMensual: number;
  variacionAnual: number;
  montoMinimo: number;
  perfilInversor: string | null;
}

let fondosCache: { rows: FondoRow[] | null; exp: number } = { rows: null, exp: 0 };

// Cache del token a nivel de módulo (persiste entre invocaciones "warm") —
// mismo mecanismo que panel.js/cedears.js.
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

// FCI tal como lo devuelve /api/v2/Titulos/FCI. `simbolo` se tipa requerido
// porque el .filter(x => x.symbol) de abajo cubre el caso real de que falte.
interface IolFondo {
  simbolo: string;
  descripcion?: string | null;
  tipoFondo?: string | null;
  moneda?: string | null;
  ultimoOperado?: number | string | null;
  variacion?: number | string | null;
  variacionMensual?: number | string | null;
  variacionAnual?: number | string | null;
  montoMinimo?: number | string | null;
  perfilInversor?: string | null;
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

// FCI real de IOL → forma propia (FondoRow, ver operar.types.ts). No se
// reusa la forma CedearRow/PanelRow (symbol/px_bid/px_ask/…): un FCI no
// tiene libro de puntas, su "precio" es el valor cuota (ultimoOperado) y su
// variación relevante para el Home es la anual, no una variación diaria de
// mercado abierto.
function mapRow(f: IolFondo): FondoRow {
  return {
    symbol: f.simbolo,
    name: f.descripcion || f.simbolo,
    tipoFondo: f.tipoFondo || null,
    moneda: f.moneda || null,
    valorCuota: Number(f.ultimoOperado) || 0,
    variacionDiaria: Number(f.variacion) || 0,
    variacionMensual: Number(f.variacionMensual) || 0,
    variacionAnual: Number(f.variacionAnual) || 0,
    montoMinimo: Number(f.montoMinimo) || 0,
    perfilInversor: f.perfilInversor || null,
  };
}

export async function GET() {
  try {
    const hit = fondosCache;
    if (hit.rows && Date.now() < hit.exp) {
      return Response.json(hit.rows, { status: 200, headers: { 'Cache-Control': 'no-store' } });
    }

    const token = await getToken();
    const url = `${IOL}/api/v2/Titulos/FCI`;

    let r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    // 401 → token vencido en medio: forzar re-auth una vez.
    if (r.status === 401) {
      tokenCache = { access: null, refresh: null, exp: 0 };
      const fresh = await getToken();
      r = await fetch(url, { headers: { Authorization: `Bearer ${fresh}` } });
    }

    if (!r.ok) {
      return Response.json({ error: `IOL FCI error (${r.status})` }, { status: 502 });
    }

    const data: unknown = await r.json();
    const rows = (Array.isArray(data) ? (data as IolFondo[]) : []).map(mapRow).filter((x) => x.symbol);
    fondosCache = { rows, exp: Date.now() + FONDOS_TTL_MS };

    // no-store: mismo criterio que panel.js/cedears.js, aunque acá el dato
    // cambie mucho menos seguido — consistencia con el resto de los proxies.
    return Response.json(rows, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const err = e as Error | undefined;
    return Response.json({ error: String((err && err.message) || err) }, { status: 500 });
  }
}

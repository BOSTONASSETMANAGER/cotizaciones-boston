// Route handler (App Router) — proxy al feed Cohen (Primary/XOMS) que corre
// en el VPS de Boston (backend/cohen-feed/feed.py).
//
// El navegador llama a /api/cohen/cedears?plazo=t0|t1 y recibe CedearRow[]
// (mismo contrato que /api/iol/cedears). El feed real vive detrás de un token
// que SOLO conoce esta función (env vars COHEN_FEED_URL / COHEN_FEED_TOKEN) —
// nunca llega al cliente. Servidor→servidor no hay mixed content, así el
// sitio HTTPS puede consumir un feed HTTP interno.
//
// Respuestas:
//  - 200 con filas: libro Cohen del plazo pedido.
//  - 200 con []: feed alcanzable pero sin datos (auth Cohen pendiente,
//    mercado cerrado o sin puntas) → el frontend cae a IOL.
//  - 502/500: feed no configurado o inalcanzable → el frontend cae a IOL.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 4000;

// En el original era un res.setHeader('Cache-Control','no-store') como PRIMERA
// línea del handler: aplica a TODAS las respuestas, incluidos los errores.
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req: Request) {
  const base = process.env.COHEN_FEED_URL;
  if (!base) {
    return Response.json({ error: 'COHEN_FEED_URL not configured' }, { status: 500, headers: NO_STORE });
  }

  const raw = new URL(req.url).searchParams.get('plazo') || 't1';
  const plazo = raw === 't0' || raw === 't1' ? raw : 't1';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const upstream = await fetch(
      `${base.replace(/\/+$/, '')}/cedears?plazo=${plazo}`,
      {
        headers: process.env.COHEN_FEED_TOKEN
          ? { 'X-Feed-Token': process.env.COHEN_FEED_TOKEN }
          : {},
        signal: controller.signal,
      },
    );
    clearTimeout(timer);

    if (!upstream.ok) {
      return Response.json({ error: `feed responded ${upstream.status}` }, { status: 502, headers: NO_STORE });
    }
    const rows: unknown = await upstream.json();
    return Response.json(Array.isArray(rows) ? rows : [], { status: 200, headers: NO_STORE });
  } catch (e) {
    const err = e as Error | undefined;
    return Response.json({ error: String((err && err.message) || err) }, { status: 502, headers: NO_STORE });
  }
}

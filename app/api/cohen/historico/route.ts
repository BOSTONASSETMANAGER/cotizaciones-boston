// Route handler (App Router) — proxy al feed Cohen (Primary/XOMS) que corre
// en el VPS de Boston (backend/cohen-feed/feed.py), rama histórico.
//
// El navegador llama a /api/cohen/historico?symbol=AAPL&plazo=t1&dias=30 y
// recibe HistoricoPoint[] — MISMO contrato que /api/iol/historico
// (fechaHora, apertura, maximo, minimo, ultimoPrecio, volumenNominal),
// ascendente por fecha, para que el gráfico de Ficha no distinga la fuente.
// El feed real vive detrás de un token que SOLO conoce esta función
// (env vars COHEN_FEED_URL / COHEN_FEED_TOKEN) — nunca llega al cliente.
//
// Respuestas:
//  - 200 con puntos: serie diaria de Cohen (get_trade_history vía pyRofex).
//  - 200 con []: feed alcanzable pero sin trades en el rango (símbolo sin
//    operar, plazo sin universo, o mercado cerrado sin histórico local) →
//    el frontend cae a IOL.
//  - 502/500: feed no configurado o inalcanzable → el frontend cae a IOL.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 6000;

// En el original era un res.setHeader('Cache-Control','no-store') como PRIMERA
// línea del handler: aplica a TODAS las respuestas, incluidos los errores.
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req: Request) {
  const base = process.env.COHEN_FEED_URL;
  if (!base) {
    return Response.json({ error: 'COHEN_FEED_URL not configured' }, { status: 500, headers: NO_STORE });
  }

  const q = new URL(req.url).searchParams;
  const symbol = String(q.get('symbol') || '').trim().toUpperCase();
  if (!symbol) {
    return Response.json({ error: 'falta symbol' }, { status: 400, headers: NO_STORE });
  }
  const rawPlazo = q.get('plazo') || 't1';
  const plazo = rawPlazo === 't0' || rawPlazo === 't1' ? rawPlazo : 't1';
  const dias = Math.max(1, Math.min(Number(q.get('dias')) || 30, 1825));

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const upstream = await fetch(
      `${base.replace(/\/+$/, '')}/historico?symbol=${encodeURIComponent(symbol)}&plazo=${plazo}&dias=${dias}`,
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
    const points: unknown = await upstream.json();
    return Response.json(Array.isArray(points) ? points : [], { status: 200, headers: NO_STORE });
  } catch (e) {
    const err = e as Error | undefined;
    return Response.json({ error: String((err && err.message) || err) }, { status: 502, headers: NO_STORE });
  }
}

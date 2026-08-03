import type {
  ArbPair,
  ArbTab,
  CedearRow,
  DollarType,
  NominalsPlan,
  Settlement,
  TradeResult,
} from './market.config';
import { ARB_TABS, SUFFIX } from './market.config';

/**
 * Lower/upper sanity bounds for a plausible ARS/USD rate. Anything outside this
 * range is treated as a bad/stale quote and discarded.
 */
const MIN_DOLLAR = 500;
const MAX_DOLLAR = 5000;

/** True when `n` is a usable, strictly-positive price. */
function validPrice(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/**
 * Floor de una cantidad de nominales, estable ante el ruido de IEEE-754. Sin
 * esto, `Math.floor(0.3 / 0.1)` daría 2 en vez de 3. Redondeamos a 8 decimales
 * (más fino que cualquier cotización real) antes del floor para absorber el
 * error de coma flotante sin alterar resultados genuinamente fraccionarios.
 */
function floorQty(value: number): number {
  return Math.floor(Math.round(value * 1e8) / 1e8);
}

/**
 * Build the arbitrage pairs from a raw feed snapshot.
 *
 * For every ARS leg (a symbol that does NOT end in 'C'/'D') we look up its USD
 * twin `base + suffix`. The dollar rate is derived per the shared convention:
 *
 *   dolarCompra = arsBid / usdAsk   (you SELL usd → bring dollars in, LOWEST)
 *   dolarVenta  = arsAsk / usdBid   (you BUY usd  → take dollars out, HIGHEST)
 *
 * For CI settlement the 24h book is widened by `ciAdjustPct` (venta up,
 * compra down), since CI typically trades with a slightly wider spread.
 */
export function buildPairs(
  rows: CedearRow[],
  opts: { suffix: 'D' | 'C'; settlement: Settlement; ciAdjustPct: number },
): ArbPair[] {
  const { suffix, settlement, ciAdjustPct } = opts;

  const bySymbol = new Map<string, CedearRow>();
  for (const row of rows) {
    if (row && typeof row.symbol === 'string') {
      bySymbol.set(row.symbol, row);
    }
  }

  const pairs: ArbPair[] = [];

  for (const ars of bySymbol.values()) {
    const base = ars.symbol;

    // Skip USD legs themselves so we only iterate ARS bases once.
    if (base.endsWith('C') || base.endsWith('D')) continue;

    const usd = bySymbol.get(base + suffix);
    if (!usd) continue;

    const arsBid = +ars.px_bid;
    const arsAsk = +ars.px_ask;
    const usdBid = +usd.px_bid;
    const usdAsk = +usd.px_ask;

    if (
      !validPrice(arsBid) ||
      !validPrice(arsAsk) ||
      !validPrice(usdBid) ||
      !validPrice(usdAsk)
    ) {
      continue;
    }

    // 24h book (real order book).
    let dolarCompra = arsBid / usdAsk;
    let dolarVenta = arsAsk / usdBid;

    // CI is estimated from the 24h book with a configurable wider spread.
    if (settlement === 'CI') {
      dolarVenta = dolarVenta * (1 + ciAdjustPct / 100);
      dolarCompra = dolarCompra * (1 - ciAdjustPct / 100);
    }

    if (
      dolarVenta < MIN_DOLLAR ||
      dolarVenta > MAX_DOLLAR ||
      dolarCompra < MIN_DOLLAR ||
      dolarCompra > MAX_DOLLAR
    ) {
      continue;
    }

    const mid = (dolarVenta + dolarCompra) / 2;
    const spreadPct = mid > 0 ? ((dolarVenta - dolarCompra) / mid) * 100 : 0;

    pairs.push({
      base,
      arsBid,
      arsAsk,
      usdBid,
      usdAsk,
      qArsBid: +ars.q_bid || 0,
      qArsAsk: +ars.q_ask || 0,
      qUsdBid: +usd.q_bid || 0,
      qUsdAsk: +usd.q_ask || 0,
      dolarCompra,
      dolarVenta,
      spreadPct,
    });
  }

  return pairs;
}

/**
 * Effective USD volume available on the BUY leg of a pair: buy the CEDEAR in
 * ARS (bounded by qArsAsk), sell it in USD (bounded by qUsdBid) — the smaller
 * depth valued at usdBid (the dollars you receive).
 */
export function buyLegUsd(p: ArbPair): number {
  return Math.min(p.qArsAsk, p.qUsdBid) * p.usdBid;
}

/**
 * Effective USD volume available on the SELL leg of a pair: buy the CEDEAR in
 * USD (bounded by qUsdAsk), sell it in ARS (bounded by qArsBid) — the smaller
 * depth valued at usdAsk (the dollars you deploy).
 */
export function sellLegUsd(p: ArbPair): number {
  return Math.min(p.qUsdAsk, p.qArsBid) * p.usdAsk;
}

/**
 * Best place to BUY dollars: the pair with the LOWEST dolarVenta
 * (cheapest rate at which you take dollars out), considering ONLY pairs whose
 * buy-leg effective USD volume is at least `minUsdVol`. `null` if none qualify.
 */
export function bestBuy(pairs: ArbPair[], minUsdVol = 0): ArbPair | null {
  let best: ArbPair | null = null;
  for (const p of pairs) {
    if (buyLegUsd(p) < minUsdVol) continue;
    if (best === null || p.dolarVenta < best.dolarVenta) best = p;
  }
  return best;
}

/**
 * Best place to SELL dollars: the pair with the HIGHEST dolarCompra
 * (best rate at which you bring dollars in), considering ONLY pairs whose
 * sell-leg effective USD volume is at least `minUsdVol`. `null` if none qualify.
 */
export function bestSell(pairs: ArbPair[], minUsdVol = 0): ArbPair | null {
  let best: ArbPair | null = null;
  for (const p of pairs) {
    if (sellLegUsd(p) < minUsdVol) continue;
    if (best === null || p.dolarCompra > best.dolarCompra) best = p;
  }
  return best;
}

/**
 * Simulate the full ARS → USD → ARS round-trip:
 *   1) Buy `n1` CEDEAR units in ARS at the buy leg's ask.
 *   2) Sell them in USD at the buy leg's bid → usdMid dollars.
 *   3) Buy `n2` CEDEAR units in USD at the sell leg's ask.
 *   4) Sell them in ARS at the sell leg's bid → arsOut.
 *
 * Returns `null` for non-positive amounts or invalid prices.
 */
export function computeTrade(
  buy: ArbPair,
  sell: ArbPair,
  opts: { amountArs: number; commissionPct: number },
): TradeResult | null {
  const { amountArs, commissionPct } = opts;

  if (!(amountArs > 0)) return null;
  if (
    !validPrice(buy.arsAsk) ||
    !validPrice(buy.usdBid) ||
    !validPrice(sell.usdAsk) ||
    !validPrice(sell.arsBid)
  ) {
    return null;
  }

  const n1 = amountArs / buy.arsAsk;
  const usdMid = n1 * buy.usdBid;
  const n2 = usdMid / sell.usdAsk;
  const arsOut = n2 * sell.arsBid;

  const grossProfit = arsOut - amountArs;
  const grossPct = (grossProfit / amountArs) * 100;

  // commissionPct is the TOTAL cost as a % of the operated amount, covering
  // both legs of the round-trip (buy + sell fees, market, etc.).
  const netProfit = grossProfit - amountArs * (commissionPct / 100);
  const netPct = (netProfit / amountArs) * 100;

  // Real tradeable depth: each leg is bounded by the two punta it crosses, and
  // the round-trip is limited by the SMALLER of the buy and sell legs.
  const buyVolUnits = Math.min(buy.qArsAsk, buy.qUsdBid);
  const sellVolUnits = Math.min(sell.qUsdAsk, sell.qArsBid);
  const tradeableUnits = Math.min(buyVolUnits, sellVolUnits);
  const tradeableArs = tradeableUnits * buy.arsAsk;
  const tradeableUsd = tradeableUnits * buy.usdBid;

  return {
    buy,
    sell,
    n1,
    usdMid,
    n2,
    arsOut,
    grossProfit,
    grossPct,
    commissionPct,
    netProfit,
    netPct,
    buyVolUnits,
    sellVolUnits,
    tradeableUnits,
    tradeableArs,
    tradeableUsd,
  };
}

/**
 * Resuelve cuántos nominales ENTEROS apretar en el broker para un presupuesto
 * en ARS, sobre un par comprador y uno vendedor ya elegidos.
 *
 * Modelo (ejercicio Arbitrage.xlsx): cada compra se redondea con `floor` al
 * dinero disponible y la pata de venta se financia con los dólares REALMENTE
 * obtenidos en la pata de compra — no con el presupuesto en pesos. Ambas patas
 * se clampean por la profundidad del libro (misma convención que computeTrade).
 *
 * Devuelve `null` si el presupuesto es no-positivo, algún precio es inválido, o
 * no alcanza ni para 1 nominal de compra. Si se compra pero los USD no alcanzan
 * para cerrar (nSell=0), devuelve un plan válido (informativo) con arsOut=0.
 *
 * Función pura: no muta su entrada ni produce efectos secundarios.
 */
export function solveNominals(
  buy: ArbPair,
  sell: ArbPair,
  opts: { budgetArs: number; commissionPct: number; usdSuffix: 'D' | 'C' },
): NominalsPlan | null {
  const { budgetArs, commissionPct, usdSuffix } = opts;

  if (!(budgetArs > 0)) return null;
  if (
    !validPrice(buy.arsAsk) ||
    !validPrice(buy.usdBid) ||
    !validPrice(sell.usdAsk) ||
    !validPrice(sell.arsBid)
  ) {
    return null;
  }

  // Paso 1 — compro CEDEAR en ARS, clampeado por la profundidad de la pata.
  const buyDepth = Math.min(buy.qArsAsk, buy.qUsdBid);
  const nBuy = Math.min(floorQty(budgetArs / buy.arsAsk), Math.floor(buyDepth));
  if (nBuy <= 0) return null;

  const arsSpent = nBuy * buy.arsAsk;
  const arsLeftover = budgetArs - arsSpent;

  // Paso 2 — vendo el par en USD: dólares realmente obtenidos.
  const usdObtained = nBuy * buy.usdBid;

  // Paso 3 — compro CEDEAR en USD: limitado por los USD del paso 2 y la profundidad.
  const sellDepth = Math.min(sell.qUsdAsk, sell.qArsBid);
  const nSell = Math.max(
    0,
    Math.min(floorQty(usdObtained / sell.usdAsk), Math.floor(sellDepth)),
  );

  const usdSpent = nSell * sell.usdAsk;
  const usdLeftover = usdObtained - usdSpent;

  // Paso 4 — vendo el par en ARS (sólo los nominales ENTEROS comprados en USD).
  const arsOut = nSell * sell.arsBid;

  // El floor de nSell deja USD ociosos. Comparar lo invertido (arsSpent) contra el
  // ARS de MENOS dólares de los que se obtuvieron subestima la ganancia (puede dar
  // pérdida falsa). Se valúa el sobrante USD al tipo de la pata vendedora —equivale
  // a desplegar TODOS los dólares obtenidos en la 1.ª pata— y se suma a la salida.
  const usdSellRate = sell.arsBid / sell.usdAsk; // validPrice ya garantizó usdAsk > 0
  const usdLeftoverArs = usdLeftover * usdSellRate;
  const arsOutFull = arsOut + usdLeftoverArs; // = usdObtained * usdSellRate

  const grossProfit = arsOutFull - arsSpent;
  const netProfit = grossProfit - arsSpent * (commissionPct / 100);
  const netPct = arsSpent > 0 ? (netProfit / arsSpent) * 100 : 0;

  return {
    buyBase: buy.base,
    buyArsTicker: buy.base,
    sellUsdTicker: buy.base + usdSuffix,
    buyUsdTicker: sell.base + usdSuffix,
    sellBase: sell.base,
    buyArsAsk: buy.arsAsk,
    buyUsdBid: buy.usdBid,
    sellUsdAsk: sell.usdAsk,
    sellArsBid: sell.arsBid,
    nBuy,
    arsSpent,
    arsLeftover,
    usdObtained,
    nSell,
    usdSpent,
    usdLeftover,
    arsOut,
    usdSellRate,
    usdLeftoverArs,
    arsOutFull,
    commissionPct,
    grossProfit,
    netProfit,
    netPct,
  };
}

// ── Tipos para el monitor de oportunidades ──────────────────────────────────

/** Configuración del escáner de oportunidades y la máquina de alertas. */
export interface MonitorSettings {
  commissionPct: number;  // % de comisión total round-trip
  minUsdVol: number;      // volumen efectivo mínimo USD por punta
  ciAdjustPct: number;    // ajuste para estimar CI cuando no hay IOL
}

/** Una oportunidad de arbitraje detectada en una pestaña concreta. */
export interface ArbOpportunity {
  tabId: string;          // ArbTab.id, ej. 'mep-24'
  label: string;          // ArbTab.short, ej. 'MEP 24h'
  dollarType: DollarType;
  settlement: Settlement;
  netPct: number;         // % neto del mejor round-trip de esa pestaña
  buyBase: string;        // ticker a comprar
  sellBase: string;       // ticker a vender
  tradeableUsd: number;   // volumen operable real (USD)
  ciEstimated: boolean;   // true si el CI se estimó (sin IOL real)
}

/**
 * Escanea las 4 pestañas de ARB_TABS y devuelve una entrada por pestaña que
 * tenga al menos un par operable con suficiente liquidez.
 *
 * Lógica por pestaña:
 *  - Se toman las filas del plazo correspondiente (t0Rows para CI, t1Rows para H24).
 *  - Si no hay IOL real para ese plazo, el CI se estima desde 24hs ampliando el
 *    spread en `ciAdjustPct` (la misma convención que usa buildPairs internamente).
 *  - Se busca el mejor par comprador y vendedor con liquidez mínima de minUsdVol.
 *  - Si alguno falta, esa pestaña no aporta (se omite silenciosamente).
 *
 * Función pura: no modifica su entrada ni produce efectos secundarios.
 */
export function scanOpportunities(
  t0Rows: CedearRow[],
  t1Rows: CedearRow[],
  iolSource: { t0: boolean; t1: boolean },
  settings: MonitorSettings,
): ArbOpportunity[] {
  const result: ArbOpportunity[] = [];

  for (const tab of ARB_TABS) {
    const rows = tab.settlement === 'CI' ? t0Rows : t1Rows;
    const ciReal = tab.settlement === 'CI' ? iolSource.t0 : iolSource.t1;
    const ciEstimated = tab.settlement === 'CI' && !ciReal;
    const ciAdjustPct = ciEstimated ? settings.ciAdjustPct : 0;

    const pairs = buildPairs(rows, {
      suffix: SUFFIX[tab.dollarType],
      settlement: tab.settlement,
      ciAdjustPct,
    });

    const buy = bestBuy(pairs, settings.minUsdVol);
    const sell = bestSell(pairs, settings.minUsdVol);
    if (!buy || !sell) continue;

    const trade = computeTrade(buy, sell, {
      amountArs: 1_000_000,
      commissionPct: settings.commissionPct,
    });
    if (!trade) continue;

    result.push({
      tabId: tab.id,
      label: tab.short,
      dollarType: tab.dollarType,
      settlement: tab.settlement,
      netPct: trade.netPct,
      buyBase: buy.base,
      sellBase: sell.base,
      tradeableUsd: trade.tradeableUsd,
      ciEstimated,
    });
  }

  return result;
}

/**
 * Máquina de estados pura para detección de oportunidades por flanco con histéresis.
 *
 * Estados:
 *  - `armed = true`:  en reposo, listo para disparar al cruzar `fire` hacia arriba.
 *  - `armed = false`: disparado; permanece silencioso mientras netPct >= rearm.
 *
 * Histéresis: `rearm` (ej. 1.9) < `fire` (ej. 2.0) evita el parpadeo cuando
 * netPct oscila cerca del umbral. La alerta sólo se re-arma cuando baja
 * claramente por debajo de `rearm`.
 *
 * Devuelve el nuevo estado y si debe enviarse una notificación en este tick.
 */
export function nextAlertState(
  prevArmed: boolean,
  netPct: number,
  opts: { fire: number; rearm: number },
): { armed: boolean; fire: boolean } {
  if (prevArmed && netPct >= opts.fire) return { armed: false, fire: true };
  if (!prevArmed && netPct < opts.rearm) return { armed: true, fire: false };
  return { armed: prevArmed, fire: false };
}

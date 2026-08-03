import { describe, expect, it } from 'vitest';
import type { ArbPair, CedearRow } from '@/lib/market.config';
import { cohenCedearsUrl, iolCedearsUrl } from '@/lib/market.config';
import {
  bestBuy,
  bestSell,
  buildPairs,
  computeTrade,
  buyLegUsd,
  sellLegUsd,
  scanOpportunities,
  nextAlertState,
  solveNominals,
} from '@/lib/arb-engine';
import type { MonitorSettings } from '@/lib/arb-engine';

/** Minimal CedearRow factory with sane defaults. */
function row(symbol: string, p: Partial<CedearRow> = {}): CedearRow {
  return {
    symbol,
    q_bid: 100,
    px_bid: 1000,
    px_ask: 1010,
    q_ask: 100,
    v: 0,
    q_op: 0,
    c: 0,
    pct_change: 0,
    ...p,
  };
}

/**
 * A synthetic AAPL pair where the ARS leg trades ~1450 ARS and the USD (MEP)
 * leg ~1 USD, so the derived dollar lands in a realistic ~1450 range.
 */
function aaplRows(): CedearRow[] {
  return [
    row('AAPL', { px_bid: 14520, px_ask: 14580, q_bid: 50, q_ask: 40 }),
    row('AAPLD', { px_bid: 10, px_ask: 10.02, q_bid: 30, q_ask: 25 }),
  ];
}

describe('buildPairs', () => {
  it('builds the correct pair and keeps dolarCompra < dolarVenta', () => {
    const pairs = buildPairs(aaplRows(), {
      suffix: 'D',
      settlement: 'H24',
      ciAdjustPct: 0.3,
    });
    expect(pairs).toHaveLength(1);
    const p = pairs[0];
    expect(p.base).toBe('AAPL');
    // dolarCompra = arsBid/usdAsk, dolarVenta = arsAsk/usdBid
    expect(p.dolarCompra).toBeCloseTo(14520 / 10.02, 6);
    expect(p.dolarVenta).toBeCloseTo(14580 / 10, 6);
    expect(p.dolarCompra).toBeLessThan(p.dolarVenta);
  });

  it('discards symbols without a USD leg', () => {
    const rows: CedearRow[] = [
      ...aaplRows(),
      // KO has no KOD leg → must be skipped.
      row('KO', { px_bid: 14000, px_ask: 14100 }),
    ];
    const pairs = buildPairs(rows, {
      suffix: 'D',
      settlement: 'H24',
      ciAdjustPct: 0.3,
    });
    expect(pairs.map((p) => p.base)).toEqual(['AAPL']);
  });

  it('does not treat a symbol ending in D/C as a base', () => {
    // Only the USD legs exist; nothing should pair.
    const rows: CedearRow[] = [
      row('AAPLD', { px_bid: 10, px_ask: 10.02 }),
      row('AAPLC', { px_bid: 10.4, px_ask: 10.42 }),
    ];
    const pairs = buildPairs(rows, {
      suffix: 'D',
      settlement: 'H24',
      ciAdjustPct: 0.3,
    });
    expect(pairs).toHaveLength(0);
  });

  it('discards pairs with zero/invalid prices', () => {
    const rows: CedearRow[] = [
      row('AAPL', { px_bid: 0, px_ask: 14580 }),
      row('AAPLD', { px_bid: 10, px_ask: 10.02 }),
    ];
    const pairs = buildPairs(rows, {
      suffix: 'D',
      settlement: 'H24',
      ciAdjustPct: 0.3,
    });
    expect(pairs).toHaveLength(0);
  });

  it('discards rates outside the [500, 5000] band', () => {
    // arsAsk/usdBid ≈ 1 → way below MIN_DOLLAR.
    const rows: CedearRow[] = [
      row('AAPL', { px_bid: 9.9, px_ask: 10 }),
      row('AAPLD', { px_bid: 10, px_ask: 10.02 }),
    ];
    const pairs = buildPairs(rows, {
      suffix: 'D',
      settlement: 'H24',
      ciAdjustPct: 0.3,
    });
    expect(pairs).toHaveLength(0);
  });

  it('CI widens the spread: venta up and compra down vs H24', () => {
    const h24 = buildPairs(aaplRows(), {
      suffix: 'D',
      settlement: 'H24',
      ciAdjustPct: 0.3,
    })[0];
    const ci = buildPairs(aaplRows(), {
      suffix: 'D',
      settlement: 'CI',
      ciAdjustPct: 0.3,
    })[0];

    expect(ci.dolarVenta).toBeGreaterThan(h24.dolarVenta);
    expect(ci.dolarCompra).toBeLessThan(h24.dolarCompra);
    expect(ci.dolarVenta).toBeCloseTo(h24.dolarVenta * 1.003, 6);
    expect(ci.dolarCompra).toBeCloseTo(h24.dolarCompra * 0.997, 6);
    // Spread must remain consistent.
    expect(ci.dolarCompra).toBeLessThan(ci.dolarVenta);
  });

  it('works with the C suffix (CCL)', () => {
    const rows: CedearRow[] = [
      row('AAPL', { px_bid: 14520, px_ask: 14580 }),
      row('AAPLC', { px_bid: 9.6, px_ask: 9.62 }),
    ];
    const pairs = buildPairs(rows, {
      suffix: 'C',
      settlement: 'H24',
      ciAdjustPct: 0.3,
    });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].dolarCompra).toBeLessThan(pairs[0].dolarVenta);
  });
});

describe('bestBuy / bestSell', () => {
  const pairs = buildPairs(
    [
      // AAPL: cheaper dollar.
      row('AAPL', { px_bid: 14520, px_ask: 14580 }),
      row('AAPLD', { px_bid: 10, px_ask: 10.02 }),
      // KO: more expensive dollar.
      row('KO', { px_bid: 15020, px_ask: 15080 }),
      row('KOD', { px_bid: 10, px_ask: 10.02 }),
    ],
    { suffix: 'D', settlement: 'H24', ciAdjustPct: 0.3 },
  );

  it('bestBuy returns the pair with the lowest dolarVenta', () => {
    const buy = bestBuy(pairs);
    expect(buy?.base).toBe('AAPL');
    const minVenta = Math.min(...pairs.map((p) => p.dolarVenta));
    expect(buy?.dolarVenta).toBe(minVenta);
  });

  it('bestSell returns the pair with the highest dolarCompra', () => {
    const sell = bestSell(pairs);
    expect(sell?.base).toBe('KO');
    const maxCompra = Math.max(...pairs.map((p) => p.dolarCompra));
    expect(sell?.dolarCompra).toBe(maxCompra);
  });

  it('returns null for empty input', () => {
    expect(bestBuy([])).toBeNull();
    expect(bestSell([])).toBeNull();
  });
});

describe('minimum USD volume filter', () => {
  // AAPL: cheapest dollar but tiny depth. KO: pricier dollar but deep book.
  const pairs = buildPairs(
    [
      row('AAPL', { px_bid: 14520, px_ask: 14580, q_bid: 5, q_ask: 4 }),
      row('AAPLD', { px_bid: 10, px_ask: 10.02, q_bid: 3, q_ask: 3 }),
      row('KO', { px_bid: 15020, px_ask: 15080, q_bid: 1000, q_ask: 1000 }),
      row('KOD', { px_bid: 10, px_ask: 10.02, q_bid: 1000, q_ask: 1000 }),
    ],
    { suffix: 'D', settlement: 'H24', ciAdjustPct: 0.3 },
  );
  const aapl = pairs.find((p) => p.base === 'AAPL')!;
  const ko = pairs.find((p) => p.base === 'KO')!;

  it('computes leg USD volume from the binding depth', () => {
    // AAPL buy leg: min(qArsAsk 4, qUsdBid 3) * usdBid 10 = 30
    expect(buyLegUsd(aapl)).toBeCloseTo(Math.min(4, 3) * 10, 6);
    expect(sellLegUsd(ko)).toBeCloseTo(Math.min(1000, 1000) * 10.02, 6);
  });

  it('without a minimum, bestBuy picks the cheapest even if illiquid', () => {
    expect(bestBuy(pairs)?.base).toBe('AAPL');
  });

  it('with a minimum, bestBuy skips low-volume pairs for the best that qualifies', () => {
    // AAPL buy vol = 30 USD < 500 → excluded; KO qualifies.
    expect(bestBuy(pairs, 500)?.base).toBe('KO');
  });

  it('with a minimum, bestSell skips low-volume pairs', () => {
    expect(bestSell(pairs, 500)?.base).toBe('KO');
  });

  it('returns null when no pair meets the minimum', () => {
    expect(bestBuy(pairs, 1_000_000)).toBeNull();
    expect(bestSell(pairs, 1_000_000)).toBeNull();
  });
});

describe('computeTrade', () => {
  const pairs = buildPairs(
    [
      row('AAPL', {
        px_bid: 14520,
        px_ask: 14580,
        q_bid: 50,
        q_ask: 40,
      }),
      row('AAPLD', { px_bid: 10, px_ask: 10.02, q_bid: 30, q_ask: 25 }),
      row('KO', { px_bid: 15020, px_ask: 15080, q_bid: 60, q_ask: 55 }),
      row('KOD', { px_bid: 10, px_ask: 10.02, q_bid: 20, q_ask: 35 }),
    ],
    { suffix: 'D', settlement: 'H24', ciAdjustPct: 0.3 },
  );
  const buy = bestBuy(pairs)!;
  const sell = bestSell(pairs)!;

  it('computes a coherent round-trip', () => {
    const t = computeTrade(buy, sell, {
      amountArs: 1_000_000,
      commissionPct: 0,
    })!;
    expect(t.n1).toBeCloseTo(1_000_000 / buy.arsAsk, 6);
    expect(t.usdMid).toBeCloseTo(t.n1 * buy.usdBid, 6);
    expect(t.n2).toBeCloseTo(t.usdMid / sell.usdAsk, 6);
    expect(t.arsOut).toBeCloseTo(t.n2 * sell.arsBid, 6);
    expect(t.grossProfit).toBeCloseTo(t.arsOut - 1_000_000, 6);
    expect(t.commissionPct).toBe(0);
  });

  it('higher commissionPct yields lower netProfit', () => {
    const low = computeTrade(buy, sell, {
      amountArs: 1_000_000,
      commissionPct: 0.5,
    })!;
    const high = computeTrade(buy, sell, {
      amountArs: 1_000_000,
      commissionPct: 1.5,
    })!;
    expect(high.netProfit).toBeLessThan(low.netProfit);
    // grossProfit is unaffected by commission.
    expect(high.grossProfit).toBeCloseTo(low.grossProfit, 6);
  });

  it('tradeableUnits = min of the four relevant depths', () => {
    const t = computeTrade(buy, sell, {
      amountArs: 1_000_000,
      commissionPct: 0,
    })!;
    // buy = AAPL: qArsAsk=40, qUsdBid=30 → buyVol=30
    // sell = KO:  qUsdAsk=35, qArsBid=60 → sellVol=35
    expect(t.buyVolUnits).toBe(Math.min(buy.qArsAsk, buy.qUsdBid));
    expect(t.sellVolUnits).toBe(Math.min(sell.qUsdAsk, sell.qArsBid));
    expect(t.tradeableUnits).toBe(
      Math.min(buy.qArsAsk, buy.qUsdBid, sell.qUsdAsk, sell.qArsBid),
    );
    expect(t.tradeableUnits).toBe(30);
    expect(t.tradeableArs).toBeCloseTo(30 * buy.arsAsk, 6);
    expect(t.tradeableUsd).toBeCloseTo(30 * buy.usdBid, 6);
  });

  it('returns null for non-positive amount', () => {
    expect(
      computeTrade(buy, sell, { amountArs: 0, commissionPct: 0 }),
    ).toBeNull();
    expect(
      computeTrade(buy, sell, { amountArs: -100, commissionPct: 0 }),
    ).toBeNull();
  });
});

// ── Helpers para scanOpportunities ──────────────────────────────────────────

/**
 * Construye dos tickers (AAPL/KO) con dólares implícitos muy distintos para
 * que el round-trip dé netPct claramente positivo incluso con comisión cero.
 * AAPL: dolarVenta ≈ 14580/10 = 1458, dolarCompra ≈ 14520/10.02 ≈ 1449.1
 * KO:   dolarVenta ≈ 16080/10 = 1608, dolarCompra ≈ 16020/10.02 ≈ 1599.4
 *
 * Round-trip: comprar AAPL (barato), vender KO (caro) → grossPct ≈ 10%.
 */
function mepT1Rows(): CedearRow[] {
  return [
    row('AAPL', { px_bid: 14520, px_ask: 14580, q_bid: 500, q_ask: 500 }),
    row('AAPLD', { px_bid: 10,    px_ask: 10.02, q_bid: 500, q_ask: 500 }),
    row('KO',   { px_bid: 16020,  px_ask: 16080, q_bid: 500, q_ask: 500 }),
    row('KOD',  { px_bid: 10,     px_ask: 10.02, q_bid: 500, q_ask: 500 }),
  ];
}

/** Filas vacías — ninguna pestaña las debería incluir. */
const emptyRows: CedearRow[] = [];

const defaultSettings: MonitorSettings = {
  commissionPct: 0,
  minUsdVol: 0,
  ciAdjustPct: 0.3,
};

describe('scanOpportunities', () => {
  it('devuelve la pestaña mep-24 con netPct > 2 y campos correctos', () => {
    const t1 = mepT1Rows();
    const opps = scanOpportunities(emptyRows, t1, { t0: false, t1: true }, defaultSettings);

    const mep24 = opps.find((o) => o.tabId === 'mep-24');
    expect(mep24).toBeDefined();
    expect(mep24!.netPct).toBeGreaterThan(2);
    expect(mep24!.buyBase).toBe('AAPL');
    expect(mep24!.sellBase).toBe('KO');
    expect(mep24!.ciEstimated).toBe(false);
    expect(mep24!.dollarType).toBe('MEP');
    expect(mep24!.settlement).toBe('H24');
    expect(mep24!.label).toBe('MEP 24h');
  });

  it('con minUsdVol enorme no devuelve ninguna pestaña (respeta liquidez mínima)', () => {
    const t1 = mepT1Rows();
    const highVol: MonitorSettings = { ...defaultSettings, minUsdVol: 1_000_000 };
    const opps = scanOpportunities(emptyRows, t1, { t0: false, t1: true }, highVol);
    expect(opps).toHaveLength(0);
  });

  it('ciEstimated=true cuando settlement=CI y iolSource.t0=false', () => {
    // Para CI necesitamos las filas en t0Rows; usamos los mismos datos.
    const t0 = mepT1Rows();
    const opps = scanOpportunities(t0, emptyRows, { t0: false, t1: false }, defaultSettings);

    const mepCi = opps.find((o) => o.tabId === 'mep-ci');
    expect(mepCi).toBeDefined();
    expect(mepCi!.ciEstimated).toBe(true);
  });

  it('ciEstimated=false cuando settlement=CI y iolSource.t0=true', () => {
    const t0 = mepT1Rows();
    const opps = scanOpportunities(t0, emptyRows, { t0: true, t1: false }, defaultSettings);

    const mepCi = opps.find((o) => o.tabId === 'mep-ci');
    expect(mepCi).toBeDefined();
    expect(mepCi!.ciEstimated).toBe(false);
  });
});

// ── Helpers para solveNominals ──────────────────────────────────────────────

/**
 * Construye un ArbPair directamente (sin pasar por buildPairs ni su filtro de
 * bandas de dólar), para testear solveNominals de forma aislada. El solver sólo
 * usa arsAsk/usdBid (pata de compra), usdAsk/arsBid (pata de venta), base y las
 * profundidades q*. dolarCompra/Venta/spread se completan con valores plausibles.
 */
function pair(base: string, p: Partial<ArbPair> = {}): ArbPair {
  return {
    base,
    arsBid: 1000,
    arsAsk: 1010,
    usdBid: 0.69,
    usdAsk: 0.7,
    qArsBid: 1000,
    qArsAsk: 1000,
    qUsdBid: 1000,
    qUsdAsk: 1000,
    dolarCompra: 1428,
    dolarVenta: 1463,
    spreadPct: 2,
    ...p,
  };
}

describe('solveNominals', () => {
  // Caso canónico del Excel Arbitrage.xlsx (fuente de verdad).
  // Compro KEEL @ 45200 (vendo KEELD @ 33.46), compro TMUSD @ 5.62 (vendo TMUS @ 8200).
  const keel = pair('KEEL', { arsAsk: 45200, usdBid: 33.46 });
  const tmus = pair('TMUS', { usdAsk: 5.62, arsBid: 8200 });

  it('reproduce el ejercicio del Excel: 3 y 17 nominales con sus sobrantes', () => {
    const plan = solveNominals(keel, tmus, {
      budgetArs: 150_000,
      commissionPct: 0,
      usdSuffix: 'D',
    })!;
    expect(plan).not.toBeNull();
    // Paso 1 — compro KEEL en ARS
    expect(plan.nBuy).toBe(3); // floor(150000/45200) = 3
    expect(plan.arsSpent).toBeCloseTo(135_600, 6);
    expect(plan.arsLeftover).toBeCloseTo(14_400, 6);
    // Paso 2 — vendo KEELD en USD
    expect(plan.usdObtained).toBeCloseTo(100.38, 6); // 3 * 33.46
    // Paso 3 — compro TMUSD en USD (limitado por los USD obtenidos, NO por el budget)
    expect(plan.nSell).toBe(17); // floor(100.38/5.62) = 17, NO 18
    expect(plan.usdSpent).toBeCloseTo(95.54, 6); // 17 * 5.62
    expect(plan.usdLeftover).toBeCloseTo(4.84, 2);
    // Paso 4 — vendo TMUS en ARS (sólo los 17 enteros)
    expect(plan.arsOut).toBeCloseTo(139_400, 6); // 17 * 8200
    // El sobrante USD (4.84) se valúa al tipo de la pata vendedora (8200/5.62)
    // y suma a la salida → equivale a desplegar los 100.38 USD completos.
    expect(plan.usdSellRate).toBeCloseTo(8200 / 5.62, 6);
    expect(plan.usdLeftoverArs).toBeCloseTo(4.84 * (8200 / 5.62), 2);
    expect(plan.arsOutFull).toBeCloseTo(100.38 * (8200 / 5.62), 2); // ≈ 146 461.92
    // Ganancia midiendo contra lo invertido (135 600), contando el sobrante USD.
    expect(plan.grossProfit).toBeCloseTo(100.38 * (8200 / 5.62) - 135_600, 2); // ≈ 10 861.92
  });

  it('expone los 4 tickers de las acciones del broker', () => {
    const plan = solveNominals(keel, tmus, {
      budgetArs: 150_000,
      commissionPct: 0,
      usdSuffix: 'D',
    })!;
    expect(plan.buyArsTicker).toBe('KEEL'); // fila 1: compro ARS
    expect(plan.sellUsdTicker).toBe('KEELD'); // fila 2: vendo USD (par de la pata de compra)
    expect(plan.buyUsdTicker).toBe('TMUSD'); // fila 3: compro USD (par de la pata de venta)
    expect(plan.sellBase).toBe('TMUS'); // fila 4: vendo ARS
  });

  it('respeta el sufijo C (CCL) en los tickers USD', () => {
    const plan = solveNominals(keel, tmus, {
      budgetArs: 150_000,
      commissionPct: 0,
      usdSuffix: 'C',
    })!;
    expect(plan.sellUsdTicker).toBe('KEELC');
    expect(plan.buyUsdTicker).toBe('TMUSC');
  });

  it('netPct se mide sobre arsSpent (lo invertido), no sobre el budget', () => {
    const plan = solveNominals(keel, tmus, {
      budgetArs: 150_000,
      commissionPct: 0,
      usdSuffix: 'D',
    })!;
    expect(plan.netPct).toBeCloseTo((plan.netProfit / plan.arsSpent) * 100, 6);
    // con leftover de 14.400, el denominador (135.600) difiere del budget (150.000)
    expect(plan.netPct).not.toBeCloseTo((plan.netProfit / 150_000) * 100, 6);
  });

  it('mayor commissionPct reduce el netProfit; el gross no cambia', () => {
    const lo = solveNominals(keel, tmus, { budgetArs: 150_000, commissionPct: 0.5, usdSuffix: 'D' })!;
    const hi = solveNominals(keel, tmus, { budgetArs: 150_000, commissionPct: 2, usdSuffix: 'D' })!;
    expect(hi.netProfit).toBeLessThan(lo.netProfit);
    expect(hi.grossProfit).toBeCloseTo(lo.grossProfit, 6);
  });

  it('clampa nBuy por la profundidad del libro de la pata de compra', () => {
    // El budget alcanzaría para muchos, pero min(qArsAsk, qUsdBid) = 2.
    const shallowBuy = pair('KEEL', { arsAsk: 45200, usdBid: 33.46, qArsAsk: 2, qUsdBid: 5 });
    const plan = solveNominals(shallowBuy, tmus, {
      budgetArs: 10_000_000,
      commissionPct: 0,
      usdSuffix: 'D',
    })!;
    expect(plan.nBuy).toBe(2);
  });

  it('clampa nSell por la profundidad del libro de la pata de venta', () => {
    const shallowSell = pair('TMUS', { usdAsk: 5.62, arsBid: 8200, qUsdAsk: 1, qArsBid: 10 });
    const plan = solveNominals(keel, shallowSell, {
      budgetArs: 150_000,
      commissionPct: 0,
      usdSuffix: 'D',
    })!;
    expect(plan.nSell).toBe(1); // limitado por la profundidad, aunque alcanzaría para 17
  });

  it('devuelve null si el presupuesto no alcanza ni para 1 nominal de compra', () => {
    expect(
      solveNominals(keel, tmus, { budgetArs: 40_000, commissionPct: 0, usdSuffix: 'D' }),
    ).toBeNull();
  });

  it('devuelve null para presupuesto cero o negativo', () => {
    expect(solveNominals(keel, tmus, { budgetArs: 0, commissionPct: 0, usdSuffix: 'D' })).toBeNull();
    expect(solveNominals(keel, tmus, { budgetArs: -100, commissionPct: 0, usdSuffix: 'D' })).toBeNull();
  });

  it('devuelve null ante precios inválidos en cualquiera de las 4 puntas', () => {
    const opts = { budgetArs: 150_000, commissionPct: 0, usdSuffix: 'D' as const };
    expect(solveNominals(pair('KEEL', { arsAsk: 0, usdBid: 33.46 }), tmus, opts)).toBeNull();
    expect(solveNominals(pair('KEEL', { arsAsk: 45200, usdBid: NaN }), tmus, opts)).toBeNull();
    expect(solveNominals(keel, pair('TMUS', { usdAsk: 0, arsBid: 8200 }), opts)).toBeNull();
    expect(solveNominals(keel, pair('TMUS', { usdAsk: 5.62, arsBid: -1 }), opts)).toBeNull();
  });

  it('compré pero no alcanza para cerrar: nSell=0 → plan válido con arsOut=0 y pérdida', () => {
    // usdBid minúsculo → usdObtained < sell.usdAsk → no se puede comprar ni 1 en USD.
    const tinyUsd = pair('KEEL', { arsAsk: 1000, usdBid: 0.001 });
    const plan = solveNominals(tinyUsd, tmus, {
      budgetArs: 5_000,
      commissionPct: 0,
      usdSuffix: 'D',
    })!;
    expect(plan).not.toBeNull();
    expect(plan.nBuy).toBeGreaterThanOrEqual(1);
    expect(plan.nSell).toBe(0);
    expect(plan.arsOut).toBe(0);
    // Todo el USD queda como sobrante; su valor (usdObtained * tipo de venta) es
    // ínfimo frente a lo invertido → la operación es una pérdida clara.
    expect(plan.usdLeftover).toBeCloseTo(plan.usdObtained, 9);
    expect(plan.grossProfit).toBeLessThan(0);
  });

  it('expone los 4 precios unitarios de las puntas (plan autosuficiente)', () => {
    const plan = solveNominals(keel, tmus, {
      budgetArs: 150_000,
      commissionPct: 0,
      usdSuffix: 'D',
    })!;
    expect(plan.buyArsAsk).toBe(45200); // fila 1: precio compra ARS
    expect(plan.buyUsdBid).toBe(33.46); // fila 2: precio venta USD
    expect(plan.sellUsdAsk).toBe(5.62); // fila 3: precio compra USD
    expect(plan.sellArsBid).toBe(8200); // fila 4: precio venta ARS
  });

  it('el floor es estable ante ruido de punto flotante (0.3/0.1 = 3, no 2)', () => {
    // 1 * 0.3 = 0.3 ; 0.3 / 0.1 = 2.9999999999999996 en IEEE-754 → floor naïve daría 2.
    const buyFloat = pair('XX', { arsAsk: 1000, usdBid: 0.3 });
    const sellFloat = pair('YY', { usdAsk: 0.1, arsBid: 1000 });
    const plan = solveNominals(buyFloat, sellFloat, {
      budgetArs: 1000,
      commissionPct: 0,
      usdSuffix: 'D',
    })!;
    expect(plan.nBuy).toBe(1);
    expect(plan.usdObtained).toBeCloseTo(0.3, 9);
    expect(plan.nSell).toBe(3); // floor(0.3/0.1) corregido = 3
  });

  it('par consigo mismo (buy === sell): plan válido, gross ≤ 0 (comprar y vender el mismo libro)', () => {
    const same = pair('AAPL', { arsAsk: 1010, arsBid: 1000, usdAsk: 0.7, usdBid: 0.69 });
    const plan = solveNominals(same, same, {
      budgetArs: 1_000_000,
      commissionPct: 0,
      usdSuffix: 'D',
    })!;
    expect(plan).not.toBeNull();
    // comprar al ask y vender al bid el mismo instrumento → nunca ganás.
    expect(plan.grossProfit).toBeLessThanOrEqual(0);
  });

  it('no muta los ArbPair de entrada', () => {
    const buySnap = { ...keel };
    const sellSnap = { ...tmus };
    solveNominals(keel, tmus, { budgetArs: 150_000, commissionPct: 1, usdSuffix: 'D' });
    expect(keel).toEqual(buySnap);
    expect(tmus).toEqual(sellSnap);
  });
});

describe('nextAlertState', () => {
  const opts = { fire: 2, rearm: 1.9 };

  it('dispara al cruzar el umbral: prevArmed=true, netPct=2.5 → fire=true', () => {
    expect(nextAlertState(true, 2.5, opts)).toEqual({ armed: false, fire: true });
  });

  it('silencio mientras sigue activa: prevArmed=false, netPct=2.5 → fire=false', () => {
    expect(nextAlertState(false, 2.5, opts)).toEqual({ armed: false, fire: false });
  });

  it('re-arma bajo el umbral: prevArmed=false, netPct=1.5 → armed=true', () => {
    expect(nextAlertState(false, 1.5, opts)).toEqual({ armed: true, fire: false });
  });

  it('histéresis: no re-arma en la banda [rearm, fire): netPct=1.95 → armed=false', () => {
    expect(nextAlertState(false, 1.95, opts)).toEqual({ armed: false, fire: false });
  });

  it('permanece armado sin disparar cuando netPct < fire: prevArmed=true, netPct=1.0', () => {
    expect(nextAlertState(true, 1.0, opts)).toEqual({ armed: true, fire: false });
  });
});

describe('cohenCedearsUrl (fuente principal Cohen, IOL fallback)', () => {
  it('por defecto usa el proxy same-origin /api/cohen con el plazo mapeado', () => {
    localStorage.removeItem('cohenFeedUrl');
    expect(cohenCedearsUrl('CI')).toBe('/api/cohen/cedears?plazo=t0');
    expect(cohenCedearsUrl('H24')).toBe('/api/cohen/cedears?plazo=t1');
  });

  it('localStorage.cohenFeedUrl overridea la base (dev, tolera barra final)', () => {
    localStorage.setItem('cohenFeedUrl', 'http://127.0.0.1:8125/');
    expect(cohenCedearsUrl('CI')).toBe('http://127.0.0.1:8125/cedears?plazo=t0');
    localStorage.removeItem('cohenFeedUrl');
  });

  it("'off' deshabilita Cohen (la app va directo a IOL)", () => {
    localStorage.setItem('cohenFeedUrl', 'off');
    expect(cohenCedearsUrl('CI')).toBeNull();
    localStorage.removeItem('cohenFeedUrl');
  });

  it('iolCedearsUrl (el fallback) sigue apuntando al proxy IOL', () => {
    expect(iolCedearsUrl('CI')).toBe('/api/iol/cedears?plazo=t0');
    expect(iolCedearsUrl('H24')).toBe('/api/iol/cedears?plazo=t1');
  });
});

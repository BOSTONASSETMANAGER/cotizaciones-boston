"use client";

/**
 * Arbitrage.tsx — ex src/app/arbitrage.component.ts (template + styles inline).
 *
 * La pantalla principal del producto. El motor de cálculo NO vive acá: es
 * lib/arb-engine.ts (buildPairs / bestBuy / bestSell / computeTrade /
 * solveNominals), compartido con el monitor del shell. Este componente sólo
 * mapea props + signals internos → los llamados al motor → la UI.
 *
 * Portado desde Angular con paridad exacta (MIGRATION-CONTRACT §1):
 *  - Los `input()` signals del original son ahora props planas: se leen sin
 *    paréntesis (`settlement`, no `settlement()`). Los signals INTERNOS del
 *    componente mantienen los paréntesis (`amountArs()`, `minUsdVol()`, …).
 *  - Los `computed()` del original son consts del render: se calculan una vez
 *    por render en vez de re-evaluarse en cada lectura del template. Los
 *    nombres se mantienen (`pairs`, `buyOptions`, `selectedBuy`, `trade`,
 *    `nominalsPlan`), sólo pierden los paréntesis en los usos.
 *  - El `output()` `pausedChange` es la prop `onPausedChange`.
 *  - Los `class` del template pasan intactos a `className`: el CSS es global y
 *    verbatim (./Arbitrage.css), no hay CSS Modules (§5-bis).
 *  - Los selectores que usa runTour([...]) son API pública de facto del tour de
 *    boston-ar (§10) y NO se tocan: .arb-subtabs, .freeze-btn, .tour-params,
 *    .card.buy select, table.nm-table, .nm-prof.
 */

import { useImperativeHandle, useState, type Ref } from 'react';
import './Arbitrage.css';

import { signal, useSignal } from '@/lib/signal';
import { runTour } from '@/lib/tour.util';

import {
  CedearRow,
  ArbPair,
  TradeResult,
  NominalsPlan,
  DollarType,
  Settlement,
  SUFFIX,
  DEFAULTS,
  settlementLabel,
} from '@/lib/market.config';

import { buildPairs, bestBuy, bestSell, computeTrade, buyLegUsd, sellLegUsd, solveNominals } from '@/lib/arb-engine';

const ARB_TOUR_SEEN_KEY = 'arbitrage-tour-seen';

// Handle imperativo del componente (ex @ViewChild('arb') + arb.startTour()):
// el shell lo usa desde el botón "Ayuda" de la toolbar.
export type ArbitrageHandle = { startTour: (force?: boolean) => void };

export interface ArbitrageProps {
  cedearRows: CedearRow[];
  dollarType: DollarType;
  settlement: Settlement;
  // true = los datos ya son del plazo real (IOL t0). false = fallback data912 → se estima el CI.
  ciIsReal: boolean;
  // Estado de pausa global (refresh congelado). Two-way con el shell.
  paused: boolean;
  onPausedChange: (v: boolean) => void;
  // true = la pausa la disparó el horario de mercado cerrado (auto), no el
  // usuario — el freeze-bar necesita distinguir el mensaje entre las dos causas.
  marketClosed: boolean;
}

// Profundidad operable por punta en UNIDADES (misma convención que computeTrade).
const volBuyUnits = (p: ArbPair) => Math.min(p.qArsAsk, p.qUsdBid);
const volSellUnits = (p: ArbPair) => Math.min(p.qUsdAsk, p.qArsBid);

function fmt(v: number | null | undefined, dec = 2): string {
  if (v == null || !isFinite(v)) return '–';
  return v.toLocaleString('es-AR', {
    maximumFractionDigits: dec,
    minimumFractionDigits: dec,
  });
}

export default function Arbitrage({
  // En React 19 `ref` es una prop normal de los componentes función: no hace
  // falta forwardRef.
  ref,
  cedearRows,
  dollarType,
  settlement,
  ciIsReal,
  paused,
  onPausedChange,
  marketClosed,
}: ArbitrageProps & { ref?: Ref<ArbitrageHandle> }) {
  // --- Internal signals ---
  // Por-instancia (no a nivel de módulo): cada pestaña de arbitraje que se monte
  // arranca con sus propios defaults, igual que una instancia nueva del
  // componente de Angular. El lazy initializer de useState garantiza que el
  // signal se cree una sola vez.
  const [amountArs] = useState(() => signal<number>(DEFAULTS.amountArs));
  // Presupuesto real "de bolsillo" para el solver de nominales enteros.
  // Independiente de amountArs (que es el monto teórico para el % de rendimiento).
  const [budgetArs] = useState(() => signal<number>(DEFAULTS.budgetArs));
  const [commissionPct] = useState(() => signal<number>(DEFAULTS.commissionPct));
  const [ciAdjustPct] = useState(() => signal<number>(DEFAULTS.ciAdjustPct));
  // Volumen efectivo mínimo (USD) por punta para considerar un par operable.
  const [minUsdVol] = useState(() => signal<number>(DEFAULTS.minUsdVol));
  // Manual override of auto-selection (null = follow automatic best)
  const [manualBuy] = useState(() => signal<string | null>(null));
  const [manualSell] = useState(() => signal<string | null>(null));

  // Suscripción: sin esto, un .set() no repinta. Equivale al change detection
  // que Angular disparaba solo al escribir un signal leído por el template.
  useSignal(amountArs);
  useSignal(budgetArs);
  useSignal(commissionPct);
  useSignal(ciAdjustPct);
  useSignal(minUsdVol);
  useSignal(manualBuy);
  useSignal(manualSell);

  // El tour ya no se auto-dispara al entrar: sólo se lanza desde el botón
  // "Ayuda" de la toolbar (ver showHelp() en app/page.tsx), siempre con force=true.
  function startTour(force = false) {
    // runTour es async (carga driver.js diferido, §6): fire-and-forget, igual
    // que en Angular — no devuelve nada útil y nadie espera su resultado.
    void runTour([
      {
        element: '.arb-subtabs',
        popover: {
          title: 'Elegí tu tipo de operación',
          description: 'Operá con Dólar MEP o Contado con Liquidación, cada uno con su plazo de liquidación: Contado Inmediato o 24hs.',
        },
      },
      {
        element: '.freeze-btn',
        popover: {
          title: 'Fijá las cotizaciones',
          description: 'Este botón congela los precios en tiempo real para que puedas revisar la operación con tranquilidad antes de ejecutarla.',
        },
      },
      {
        element: '.tour-params',
        popover: {
          title: 'Configurá tu inversión',
          description: 'Definí "Monto inicial ARS" (el capital sobre el que se calcula el % de rendimiento) y "Presupuesto real ARS" (lo que realmente vas a operar en el broker). Te recomendamos dejar la selección de CEDEAR en "Automático (mejor)" en los selects de compra/venta en vez de elegir manualmente.',
        },
      },
      {
        element: '.card.buy select',
        popover: {
          title: 'Así funciona el arbitraje',
          description: 'La calculadora identifica el CEDEAR con el dólar comprador más barato y el más caro para vender, maximizando la diferencia de tipo de cambio.',
        },
      },
      {
        element: 'table.nm-table',
        popover: {
          title: 'Las 4 operaciones, paso a paso',
          description: 'Comprás el CEDEAR y lo vendés en dólares. Después comprás otro CEDEAR en dólares y lo vendés en pesos. Cada pata queda detallada acá.',
        },
      },
      {
        element: '.nm-prof',
        popover: {
          title: 'Tu resultado final',
          description: 'Mirá el % de ganancia neto, ya con comisiones descontadas. Se recomienda operar con arbitrajes de 2% o más para que valga la pena.',
        },
      },
    ], ARB_TOUR_SEEN_KEY, { force });
  }

  // startTour no lee props ni estado (los selectores y los textos son
  // constantes), así que la closure de la primera corrida sirve para siempre.
  useImperativeHandle(ref, () => ({ startTour }), []);

  // Símbolo del par en dólares (ej. SHEL → SHELD) según el tipo de dólar.
  const usdTicker = (base: string) => base + SUFFIX[dollarType];

  // --- Pairs from shared engine ---
  const pairs: ArbPair[] = buildPairs(cedearRows, {
    suffix: SUFFIX[dollarType],
    settlement: settlement,
    ciAdjustPct: settlement === 'CI' && !ciIsReal ? ciAdjustPct() : 0,
  });

  // Solo los pares con volumen efectivo suficiente en cada punta.
  const buyOptions = pairs
    .filter(p => buyLegUsd(p) >= minUsdVol())
    .sort((a, b) => a.dolarVenta - b.dolarVenta);

  const sellOptions = pairs
    .filter(p => sellLegUsd(p) >= minUsdVol())
    .sort((a, b) => b.dolarCompra - a.dolarCompra);

  // --- Auto-selection: mejor cotización CON volumen ≥ mínimo ----------------
  const selectedBuy: ArbPair | null = (() => {
    const m = manualBuy();
    if (m) {
      const found = pairs.find(p => p.base === m);
      if (found) return found;
    }
    return bestBuy(pairs, minUsdVol());
  })();

  const selectedSell: ArbPair | null = (() => {
    const m = manualSell();
    if (m) {
      const found = pairs.find(p => p.base === m);
      if (found) return found;
    }
    return bestSell(pairs, minUsdVol());
  })();

  // --- Trade result from shared engine (gross + net + real volume) ---
  // No se pinta en esta pantalla (la UI muestra el plan de nominales enteros,
  // que es lo accionable en el broker); se mantiene por paridad con el original
  // y porque es la misma cuenta que consume el monitor de alertas del shell.
  const trade: TradeResult | null = (() => {
    const buy = selectedBuy;
    const sell = selectedSell;
    if (!buy || !sell) return null;
    return computeTrade(buy, sell, {
      amountArs: amountArs(),
      commissionPct: commissionPct(),
    });
  })();
  void trade;

  // --- Solver de nominales enteros: cuántos apretar en el broker ---
  const nominalsPlan: NominalsPlan | null = (() => {
    const buy = selectedBuy;
    const sell = selectedSell;
    if (!buy || !sell) return null;
    return solveNominals(buy, sell, {
      budgetArs: budgetArs(),
      commissionPct: commissionPct(),
      usdSuffix: SUFFIX[dollarType],
    });
  })();

  // Elegir manualmente un CEDEAR congela la página (pausa el refresh) para poder
  // ir al broker y operar sin que la selección/precios cambien.
  function onManualBuy(value: string | null) {
    const t = value || null;
    manualBuy.set(t);
    if (t) onPausedChange(true);
  }

  function onManualSell(value: string | null) {
    const t = value || null;
    manualSell.set(t);
    if (t) onPausedChange(true);
  }

  function freeze() {
    onPausedChange(true);
  }

  // Volver a vivo: descongelar y soltar la selección manual (vuelve al auto-mejor).
  function unfreeze() {
    manualBuy.set(null);
    manualSell.set(null);
    onPausedChange(false);
  }

  // Alias del render para los `@if (expr; as x)` del template original.
  const b = selectedBuy;
  const s = selectedSell;
  const plan = nominalsPlan;

  return (
    <div className="arb">
      <div className="arb-head">
        <span className="tour-selector">
          <span className="badge dollar">{dollarType}</span>
          <span className="badge plazo">{settlementLabel(settlement)}</span>
        </span>

        <div className="tour-params">
          <label className="monto">
            Monto inicial ARS
            <input
              type="number"
              min="1000"
              step="1000"
              value={amountArs()}
              onChange={(e) => amountArs.set(+e.target.value || 0)}
            />
          </label>

          <label className="monto budget">
            Presupuesto real ARS
            <input
              type="number"
              min="1000"
              step="1000"
              value={budgetArs()}
              onChange={(e) => budgetArs.set(+e.target.value >= 0 ? +e.target.value : 0)}
            />
          </label>

          <label className="monto comm">
            Comisión / gastos %
            <input
              type="number"
              min="0"
              step="0.1"
              value={commissionPct()}
              onChange={(e) => commissionPct.set(+e.target.value >= 0 ? +e.target.value : 0)}
            />
          </label>

          <label className="monto vol">
            Vol. mín USD
            <input
              type="number"
              min="0"
              step="100"
              value={minUsdVol()}
              onChange={(e) => minUsdVol.set(+e.target.value >= 0 ? +e.target.value : 0)}
            />
          </label>

          {settlement === 'CI' && !ciIsReal && (
            <label className="monto ci">
              Ajuste CI %
              <input
                type="number"
                step="0.05"
                value={ciAdjustPct()}
                onChange={(e) => ciAdjustPct.set(+e.target.value || 0)}
              />
            </label>
          )}
        </div>

        <span className="pair-count">
          {buyOptions.length} compra · {sellOptions.length} venta
          con vol ≥ {fmt(minUsdVol(), 0)} USD{' '}
          <span className="pc-total">/ {pairs.length} totales</span>
        </span>

        <button
          className={`freeze-btn ${paused ? 'is-hidden' : ''}`}
          disabled={paused}
          onClick={() => freeze()}
          title="Congelar para operar"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          Congelar para operar
        </button>
      </div>

      {paused && (
        <div className="freeze-bar">
          <svg className="fb-lock" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <div className="fb-text">
            {marketClosed ? (
              <>
                <strong>Mercado cerrado</strong>
                <span>
                  El refresh se reanudará automáticamente en horario de rueda.{' '}
                  {b && <>Comprás <b>{b.base}</b>. </>}
                  {s && <>Vendés <b>{s.base}</b>. </>}
                </span>
              </>
            ) : (
              <>
                <strong>Congelado para operar</strong>
                <span>
                  El refresh está pausado: la selección y los precios no cambian.{' '}
                  {b && <>Comprás <b>{b.base}</b>. </>}
                  {s && <>Vendés <b>{s.base}</b>. </>}
                </span>
              </>
            )}
          </div>
          <button className="fb-resume" onClick={() => unfreeze()}>Reanudar en vivo</button>
        </div>
      )}

      {settlement === 'CI' && (
        ciIsReal ? (
          <div className="ci-note real">
            Contado Inmediato — libro real T+0 por símbolo, sólo pares con liquidez.
          </div>
        ) : (
          <div className="ci-note">
            Contado Inmediato estimado desde el libro de 24hs (ajuste {fmt(ciAdjustPct(), 2)} %).
          </div>
        )
      )}

      {pairs.length === 0 ? (
        <div className="empty">Esperando datos de CEDEARs…</div>
      ) : (
        <>
          {(!b || !s) && (
            <div className="vol-warn">
              Ningún par con volumen efectivo ≥ {fmt(minUsdVol(), 0)} USD en{' '}
              {!b && !s ? 'ambas puntas' : !b ? 'la punta de compra' : 'la punta de venta'}
              {/* El espacio antes del punto viene del template original: Angular
                  conserva el trailing space del bloque @if al colapsar el
                  whitespace. Se replica para no cambiar el render. */}
              {' '}. Bajá el «Vol. mín USD» para ver más opciones.
            </div>
          )}

          <div className="grid">
            {/* Compro USD */}
            <div className="card buy">
              <h3>1. Comprás CEDEAR (dólar más barato)</h3>
              <p className="hint">Auto-seleccionado: la menor cotización de venta</p>
              <select
                value={manualBuy() ?? ''}
                onChange={(e) => onManualBuy(e.target.value)}
              >
                <option value="">Automático (mejor)</option>
                {buyOptions.map((p) => (
                  <option key={p.base} value={p.base}>
                    {p.base} — $ {fmt(p.dolarVenta, 2)} / USD
                  </option>
                ))}
              </select>

              {b && (
                <div className="card-body">
                  <div className="card-ticker">{b.base}</div>
                  <div className="row">
                    <span>Precio de compra <em className="tk">{b.base}</em></span>
                    <span className="pv">
                      <strong>{fmt(b.arsAsk, 2)}</strong>
                      <em className="qty">vol compra · {fmt(b.qArsAsk, 0)} u.</em>
                    </span>
                  </div>
                  <div className="row">
                    <span>Precio de venta <em className="tk">{usdTicker(b.base)}</em></span>
                    <span className="pv">
                      <strong>{fmt(b.usdBid, 4)}</strong>
                      <em className="qty">vol venta · {fmt(b.qUsdBid, 0)} u.</em>
                    </span>
                  </div>
                  <div className="row big">
                    <span>Precio dólar venta (compro USD)</span>
                    <span className="pv">
                      <strong className="hi">$ {fmt(b.dolarVenta, 2)}</strong>
                      <em className="qty">operable · {fmt(volBuyUnits(b), 0)} u.</em>
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Vendo USD */}
            <div className="card sell">
              <h3>2. Vendés CEDEAR (paga más ARS)</h3>
              <p className="hint">Auto-seleccionado: la mayor cotización de compra</p>
              <select
                value={manualSell() ?? ''}
                onChange={(e) => onManualSell(e.target.value)}
              >
                <option value="">Automático (mejor)</option>
                {sellOptions.map((p) => (
                  <option key={p.base} value={p.base}>
                    {p.base} — $ {fmt(p.dolarCompra, 2)} / USD
                  </option>
                ))}
              </select>

              {s && (
                <div className="card-body">
                  <div className="card-ticker">{s.base}</div>
                  <div className="row">
                    <span>Precio de compra <em className="tk">{usdTicker(s.base)}</em></span>
                    <span className="pv">
                      <strong>{fmt(s.usdAsk, 4)}</strong>
                      <em className="qty">vol compra · {fmt(s.qUsdAsk, 0)} u.</em>
                    </span>
                  </div>
                  <div className="row">
                    <span>Precio de venta <em className="tk">{s.base}</em></span>
                    <span className="pv">
                      <strong>{fmt(s.arsBid, 2)}</strong>
                      <em className="qty">vol venta · {fmt(s.qArsBid, 0)} u.</em>
                    </span>
                  </div>
                  <div className="row big">
                    <span>Precio dólar compra (vendo USD)</span>
                    <span className="pv">
                      <strong className="hi">$ {fmt(s.dolarCompra, 2)}</strong>
                      <em className="qty">operable · {fmt(volSellUnits(s), 0)} u.</em>
                    </span>
                  </div>
                </div>
              )}
            </div>

          </div>

          {/* Cuenta total: el ejercicio de arbitraje con nominales enteros (Arbitrage.xlsx).
              Ganancia = pesos vendidos − pesos comprados; sin valuar el sobrante en USD. */}
          {b && s && (
            <div className="nominals total">
              <div className="nm-head">
                <h3>3. Resultado del trade · cuenta total</h3>
              </div>

              {plan ? (
                <>
                  <table className="nm-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Acción</th>
                        <th>Ticker</th>
                        <th className="num">Precio</th>
                        <th className="num">Nominales</th>
                        <th className="num">Monto</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="op-buy">
                        <td className="ix">1</td>
                        <td><span className="op">Compro</span> <span className="cur">ARS</span></td>
                        <td><span className="tk">{plan.buyArsTicker}</span></td>
                        <td className="num">{fmt(plan.buyArsAsk, 2)}</td>
                        <td className="num nom">{fmt(plan.nBuy, 0)}</td>
                        <td className="num">$ {fmt(plan.arsSpent, 2)}</td>
                      </tr>
                      <tr className="op-sell">
                        <td className="ix">2</td>
                        <td><span className="op">Vendo</span> <span className="cur">USD</span></td>
                        <td><span className="tk">{plan.sellUsdTicker}</span></td>
                        <td className="num">{fmt(plan.buyUsdBid, 4)}</td>
                        <td className="num nom">{fmt(plan.nBuy, 0)}</td>
                        <td className="num">USD {fmt(plan.usdObtained, 2)}</td>
                      </tr>
                      <tr className="op-buy">
                        <td className="ix">3</td>
                        <td><span className="op">Compro</span> <span className="cur">USD</span></td>
                        <td><span className="tk">{plan.buyUsdTicker}</span></td>
                        <td className="num">{fmt(plan.sellUsdAsk, 4)}</td>
                        <td className="num nom">{fmt(plan.nSell, 0)}</td>
                        <td className="num">USD {fmt(plan.usdSpent, 2)}</td>
                      </tr>
                      <tr className="op-sell">
                        <td className="ix">4</td>
                        <td><span className="op">Vendo</span> <span className="cur">ARS</span></td>
                        <td><span className="tk">{plan.sellBase}</span></td>
                        <td className="num">{fmt(plan.sellArsBid, 2)}</td>
                        <td className="num nom">{fmt(plan.nSell, 0)}</td>
                        <td className="num">$ {fmt(plan.arsOut, 2)}</td>
                      </tr>
                    </tbody>
                  </table>

                  <div className="nm-foot">
                    <div className="nm-left">
                      <span className="nm-lbl">Sobrante</span>
                      <span className="nm-val">$ {fmt(plan.arsLeftover, 2)} ARS</span>
                      <span className="nm-note">no entra al trade</span>
                      <span className="nm-sep">·</span>
                      <span className="nm-val">USD {fmt(plan.usdLeftover, 2)}</span>
                      <span className="nm-note">valuado a $ {fmt(plan.usdSellRate, 2)}/USD = $ {fmt(plan.usdLeftoverArs, 2)} (suma a la ganancia)</span>
                    </div>
                    <div
                      className={`nm-prof ${plan.grossProfit > 0 ? 'pos' : ''} ${plan.grossProfit <= 0 ? 'neg' : ''}`}
                    >
                      <span className="nm-lbl">Ganancia</span>
                      <span className="nm-pmain">
                        <span className="nm-pval">$ {fmt(plan.grossProfit, 2)}</span>
                        <span className="nm-ppct">{fmt(plan.grossProfit / plan.arsSpent * 100, 2)} %</span>
                      </span>
                      <span className="nm-net">recibís <span className="n">$ {fmt(plan.arsOutFull, 2)}</span> <span className="muted">(incl. sobrante USD)</span> · invertís <span className="n">$ {fmt(plan.arsSpent, 2)}</span></span>
                      {commissionPct() > 0 && (
                        <span className="nm-net">tras <span className="n">{fmt(commissionPct(), 2)} %</span> comisión <span className="n">$ {fmt(plan.netProfit, 2)}</span> · <span className="n">{fmt(plan.netPct, 2)} %</span></span>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div className="nm-empty">
                  El presupuesto de $ {fmt(budgetArs(), 0)} no alcanza para un nominal de{' '}
                  <b>{b.base}</b> a $ {fmt(b.arsAsk, 2)}{' '}
                  (o el libro no tiene profundidad). Subí el presupuesto.
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

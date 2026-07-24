import { Component, OnInit, OnDestroy, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';

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
} from './market.config';

import { buildPairs, bestBuy, bestSell, computeTrade, buyLegUsd, sellLegUsd, solveNominals } from './arb-engine';

// Orígenes del contenedor padre (boston-ar) autorizados a disparar el tour por
// postMessage. Cualquier mensaje de otro origen se ignora (seguridad). Ajustar
// si cambia el dominio del dashboard.
const ARB_TOUR_ALLOWED_ORIGINS = [
  'https://boston-ar.vercel.app',
  'https://www.bostonam.com',
  'https://bostonam.com',
  'http://localhost:3000',
];

@Component({
  selector: 'app-arbitrage',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="arb">
      <div class="arb-head">
        <!-- Botón del tour OCULTO (pedido de Elio): el tour con driver.js sigue
             vivo (ver startTour()), sólo se esconde su disparador. Para
             re-publicarlo, restaurar este botón:
             <button class="tour-test-btn" (click)="startTour()" title="Probar tour de estrategias">Probar tour</button> -->
        <span class="tour-selector">
          <span class="badge dollar">{{ dollarType() }}</span>
          <span class="badge plazo">{{ settlementLabel(settlement()) }}</span>
        </span>

        <div class="tour-params">
          <label class="monto">
            Monto inicial ARS
            <input
              type="number"
              min="1000"
              step="1000"
              [ngModel]="amountArs()"
              (ngModelChange)="amountArs.set(+$event || 0)"
            />
          </label>

          <label class="monto budget">
            Presupuesto real ARS
            <input
              type="number"
              min="1000"
              step="1000"
              [ngModel]="budgetArs()"
              (ngModelChange)="budgetArs.set(+$event >= 0 ? +$event : 0)"
            />
          </label>

          <label class="monto comm">
            Comisión / gastos %
            <input
              type="number"
              min="0"
              step="0.1"
              [ngModel]="commissionPct()"
              (ngModelChange)="commissionPct.set(+$event >= 0 ? +$event : 0)"
            />
          </label>

          <label class="monto vol">
            Vol. mín USD
            <input
              type="number"
              min="0"
              step="100"
              [ngModel]="minUsdVol()"
              (ngModelChange)="minUsdVol.set(+$event >= 0 ? +$event : 0)"
            />
          </label>

          @if (settlement() === 'CI' && !ciIsReal()) {
            <label class="monto ci">
              Ajuste CI %
              <input
                type="number"
                step="0.05"
                [ngModel]="ciAdjustPct()"
                (ngModelChange)="ciAdjustPct.set(+$event || 0)"
              />
            </label>
          }
        </div>

        <span class="pair-count">
          {{ buyOptions().length }} compra · {{ sellOptions().length }} venta
          con vol ≥ {{ fmt(minUsdVol(), 0) }} USD
          <span class="pc-total">/ {{ pairs().length }} totales</span>
        </span>

        <button
          class="freeze-btn"
          [class.is-hidden]="paused()"
          [disabled]="paused()"
          (click)="freeze()"
          title="Congelar para operar"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          Congelar para operar
        </button>
      </div>

      @if (paused()) {
        <div class="freeze-bar">
          <svg class="fb-lock" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <div class="fb-text">
            @if (marketClosed()) {
              <strong>Mercado cerrado</strong>
              <span>
                El refresh se reanudará automáticamente en horario de rueda.
                @if (selectedBuy(); as b) { Comprás <b>{{ b.base }}</b>. }
                @if (selectedSell(); as s) { Vendés <b>{{ s.base }}</b>. }
              </span>
            } @else {
              <strong>Congelado para operar</strong>
              <span>
                El refresh está pausado: la selección y los precios no cambian.
                @if (selectedBuy(); as b) { Comprás <b>{{ b.base }}</b>. }
                @if (selectedSell(); as s) { Vendés <b>{{ s.base }}</b>. }
              </span>
            }
          </div>
          <button class="fb-resume" (click)="unfreeze()">Reanudar en vivo</button>
        </div>
      }

      @if (settlement() === 'CI') {
        @if (ciIsReal()) {
          <div class="ci-note real">
            Contado Inmediato — libro real T+0 por símbolo, sólo pares con liquidez.
          </div>
        } @else {
          <div class="ci-note">
            Contado Inmediato estimado desde el libro de 24hs (ajuste {{ fmt(ciAdjustPct(), 2) }} %).
          </div>
        }
      }

      @if (pairs().length === 0) {
        <div class="empty">Esperando datos de CEDEARs…</div>
      } @else {
        @if (!selectedBuy() || !selectedSell()) {
          <div class="vol-warn">
            Ningún par con volumen efectivo ≥ {{ fmt(minUsdVol(), 0) }} USD en
            @if (!selectedBuy() && !selectedSell()) { ambas puntas }
            @else if (!selectedBuy()) { la punta de compra }
            @else { la punta de venta }.
            Bajá el «Vol. mín USD» para ver más opciones.
          </div>
        }

        <div class="grid">
          <!-- Compro USD -->
          <div class="card buy">
            <h3>1. Comprás CEDEAR (dólar más barato)</h3>
            <p class="hint">Auto-seleccionado: la menor cotización de venta</p>
            <select
              [ngModel]="manualBuy()"
              (ngModelChange)="onManualBuy($event)"
            >
              <option [ngValue]="null">Automático (mejor)</option>
              @for (p of buyOptions(); track p.base) {
                <option [ngValue]="p.base">
                  {{ p.base }} — $ {{ fmt(p.dolarVenta, 2) }} / USD
                </option>
              }
            </select>

            @if (selectedBuy(); as b) {
              <div class="card-body">
                <div class="card-ticker">{{ b.base }}</div>
                <div class="row">
                  <span>Precio de compra <em class="tk">{{ b.base }}</em></span>
                  <span class="pv">
                    <strong>{{ fmt(b.arsAsk, 2) }}</strong>
                    <em class="qty">vol compra · {{ fmt(b.qArsAsk, 0) }} u.</em>
                  </span>
                </div>
                <div class="row">
                  <span>Precio de venta <em class="tk">{{ usdTicker(b.base) }}</em></span>
                  <span class="pv">
                    <strong>{{ fmt(b.usdBid, 4) }}</strong>
                    <em class="qty">vol venta · {{ fmt(b.qUsdBid, 0) }} u.</em>
                  </span>
                </div>
                <div class="row big">
                  <span>Precio dólar venta (compro USD)</span>
                  <span class="pv">
                    <strong class="hi">$ {{ fmt(b.dolarVenta, 2) }}</strong>
                    <em class="qty">operable · {{ fmt(volBuyUnits(b), 0) }} u.</em>
                  </span>
                </div>
              </div>
            }
          </div>

          <!-- Vendo USD -->
          <div class="card sell">
            <h3>2. Vendés CEDEAR (paga más ARS)</h3>
            <p class="hint">Auto-seleccionado: la mayor cotización de compra</p>
            <select
              [ngModel]="manualSell()"
              (ngModelChange)="onManualSell($event)"
            >
              <option [ngValue]="null">Automático (mejor)</option>
              @for (p of sellOptions(); track p.base) {
                <option [ngValue]="p.base">
                  {{ p.base }} — $ {{ fmt(p.dolarCompra, 2) }} / USD
                </option>
              }
            </select>

            @if (selectedSell(); as s) {
              <div class="card-body">
                <div class="card-ticker">{{ s.base }}</div>
                <div class="row">
                  <span>Precio de compra <em class="tk">{{ usdTicker(s.base) }}</em></span>
                  <span class="pv">
                    <strong>{{ fmt(s.usdAsk, 4) }}</strong>
                    <em class="qty">vol compra · {{ fmt(s.qUsdAsk, 0) }} u.</em>
                  </span>
                </div>
                <div class="row">
                  <span>Precio de venta <em class="tk">{{ s.base }}</em></span>
                  <span class="pv">
                    <strong>{{ fmt(s.arsBid, 2) }}</strong>
                    <em class="qty">vol venta · {{ fmt(s.qArsBid, 0) }} u.</em>
                  </span>
                </div>
                <div class="row big">
                  <span>Precio dólar compra (vendo USD)</span>
                  <span class="pv">
                    <strong class="hi">$ {{ fmt(s.dolarCompra, 2) }}</strong>
                    <em class="qty">operable · {{ fmt(volSellUnits(s), 0) }} u.</em>
                  </span>
                </div>
              </div>
            }
          </div>

        </div>

        <!-- Cuenta total: el ejercicio de arbitraje con nominales enteros (Arbitrage.xlsx).
             Ganancia = pesos vendidos − pesos comprados; sin valuar el sobrante en USD. -->
        @if (selectedBuy() && selectedSell()) {
          <div class="nominals total">
            <div class="nm-head">
              <h3>3. Resultado del trade · cuenta total</h3>
              <span class="nm-sub">Ejercicio con nominales enteros para un presupuesto de <strong>$ {{ fmt(budgetArs(), 0) }}</strong> ARS. La 2.ª pata se financia con los USD reales de la 1.ª. La <em>Ganancia</em> se mide contra lo invertido (no el presupuesto) y despliega <em>todos</em> los dólares obtenidos: el sobrante en USD se valúa al tipo de la pata vendedora y suma.</span>
            </div>

            @if (nominalsPlan(); as plan) {
              <table class="nm-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Acción</th>
                    <th>Ticker</th>
                    <th class="num">Precio</th>
                    <th class="num">Nominales</th>
                    <th class="num">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  <tr class="op-buy">
                    <td class="ix">1</td>
                    <td><span class="op">Compro</span> <span class="cur">ARS</span></td>
                    <td><span class="tk">{{ plan.buyArsTicker }}</span></td>
                    <td class="num">{{ fmt(plan.buyArsAsk, 2) }}</td>
                    <td class="num nom">{{ fmt(plan.nBuy, 0) }}</td>
                    <td class="num">$ {{ fmt(plan.arsSpent, 2) }}</td>
                  </tr>
                  <tr class="op-sell">
                    <td class="ix">2</td>
                    <td><span class="op">Vendo</span> <span class="cur">USD</span></td>
                    <td><span class="tk">{{ plan.sellUsdTicker }}</span></td>
                    <td class="num">{{ fmt(plan.buyUsdBid, 4) }}</td>
                    <td class="num nom">{{ fmt(plan.nBuy, 0) }}</td>
                    <td class="num">USD {{ fmt(plan.usdObtained, 2) }}</td>
                  </tr>
                  <tr class="op-buy">
                    <td class="ix">3</td>
                    <td><span class="op">Compro</span> <span class="cur">USD</span></td>
                    <td><span class="tk">{{ plan.buyUsdTicker }}</span></td>
                    <td class="num">{{ fmt(plan.sellUsdAsk, 4) }}</td>
                    <td class="num nom">{{ fmt(plan.nSell, 0) }}</td>
                    <td class="num">USD {{ fmt(plan.usdSpent, 2) }}</td>
                  </tr>
                  <tr class="op-sell">
                    <td class="ix">4</td>
                    <td><span class="op">Vendo</span> <span class="cur">ARS</span></td>
                    <td><span class="tk">{{ plan.sellBase }}</span></td>
                    <td class="num">{{ fmt(plan.sellArsBid, 2) }}</td>
                    <td class="num nom">{{ fmt(plan.nSell, 0) }}</td>
                    <td class="num">$ {{ fmt(plan.arsOut, 2) }}</td>
                  </tr>
                </tbody>
              </table>

              <div class="nm-foot">
                <div class="nm-left">
                  <span class="nm-lbl">Sobrante</span>
                  <span class="nm-val">$ {{ fmt(plan.arsLeftover, 2) }} ARS</span>
                  <span class="nm-note">no entra al trade</span>
                  <span class="nm-sep">·</span>
                  <span class="nm-val">USD {{ fmt(plan.usdLeftover, 2) }}</span>
                  <span class="nm-note">valuado a $ {{ fmt(plan.usdSellRate, 2) }}/USD = $ {{ fmt(plan.usdLeftoverArs, 2) }} (suma a la ganancia)</span>
                </div>
                <div
                  class="nm-prof"
                  [class.pos]="plan.grossProfit > 0"
                  [class.neg]="plan.grossProfit <= 0"
                >
                  <span class="nm-lbl">Ganancia</span>
                  <span class="nm-pmain">
                    <span class="nm-pval">$ {{ fmt(plan.grossProfit, 2) }}</span>
                    <span class="nm-ppct">{{ fmt(plan.grossProfit / plan.arsSpent * 100, 2) }} %</span>
                  </span>
                  <span class="nm-net">recibís <span class="n">$ {{ fmt(plan.arsOutFull, 2) }}</span> <span class="muted">(incl. sobrante USD)</span> · invertís <span class="n">$ {{ fmt(plan.arsSpent, 2) }}</span></span>
                  @if (commissionPct() > 0) {
                    <span class="nm-net">tras <span class="n">{{ fmt(commissionPct(), 2) }} %</span> comisión <span class="n">$ {{ fmt(plan.netProfit, 2) }}</span> · <span class="n">{{ fmt(plan.netPct, 2) }} %</span></span>
                  }
                </div>
              </div>
            } @else {
              <div class="nm-empty">
                El presupuesto de $ {{ fmt(budgetArs(), 0) }} no alcanza para un nominal de
                <b>{{ selectedBuy()!.base }}</b> a $ {{ fmt(selectedBuy()!.arsAsk, 2) }}
                (o el libro no tiene profundidad). Subí el presupuesto.
              </div>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [`
    /* Layout comprimido verticalmente: el objetivo es que head + puntas +
       cuenta total (con la Ganancia) entren en un viewport de ~900px sin
       scroll. Ante la duda, sacar aire vertical antes que información. */
    .arb { padding: 0; }
    .arb-head {
      display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap;
      padding-bottom: 10px; margin-bottom: 10px; border-bottom: 1px solid var(--line);
    }
    /* Wrapper solo para poder resaltar el grupo completo de parámetros en el
       tour (driver.js necesita un bounding box propio); mismo layout que
       tenían los <label class="monto"> sueltos dentro de .arb-head. */
    .tour-params { display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap; }
    .badge {
      display: inline-flex; align-items: center; height: 24px; padding: 0 9px;
      border-radius: var(--r-sm); font-family: var(--font-mono);
      font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
      align-self: center;
    }
    .badge.dollar { background: var(--ink); color: #fff; }
    .badge.plazo { background: var(--surface-2); color: var(--ink-2); border: 1px solid var(--line); }
    .monto {
      display: flex; flex-direction: column; gap: 5px;
      font-size: 10.5px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;
      color: var(--ink-3);
    }
    .monto input {
      width: 150px; background: var(--surface); color: var(--ink);
      font-family: var(--font-mono); font-size: 13px; font-weight: 600;
      border: 1px solid var(--line); border-radius: var(--r-sm); padding: 5px 9px;
      outline: none; transition: border-color .12s, box-shadow .12s;
    }
    .monto input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-sf); }
    .monto.comm input { width: 100px; }
    .monto.ci input { width: 100px; }
    .monto.ci { color: var(--warn); }
    .monto.ci input { border-color: var(--warn-line); }
    .monto.vol input { width: 100px; }
    .pair-count {
      margin-left: auto; align-self: center; text-align: right; line-height: 1.5;
      font-family: var(--font-mono); font-size: 11px; color: var(--ink-2);
    }
    .pc-total { color: var(--ink-3); }

    .vol-warn {
      margin: 0 0 10px; padding: 6px 13px; border-radius: var(--r);
      background: var(--warn-bg); border: 1px solid var(--warn-line); color: var(--warn);
      font-size: 12px;
    }

    /* Congelar para operar */
    .freeze-btn {
      align-self: center;
      display: inline-flex; align-items: center; gap: 6px;
      height: 32px; padding: 0 12px;
      border: 1px solid rgba(255,255,255,0.12); background: var(--navy-grad); color: #fff;
      border-radius: var(--r-sm); cursor: pointer;
      box-shadow: var(--navy-shadow);
      font-family: var(--font-ui); font-size: 12.5px; font-weight: 600;
      transition: opacity .12s, transform .04s;
    }
    .freeze-btn:hover { opacity: .92; transform: translateY(-1px); }
    .freeze-btn:active { transform: translateY(1px); }
    /* Se mantiene SIEMPRE en el DOM (nunca *ngIf) para que el tour (driver.js)
       pueda ubicarlo como 2.º paso aunque la página ya esté congelada; cuando
       está pausada, se oculta visualmente sin desaparecer del layout. */
    .freeze-btn.is-hidden { visibility: hidden; pointer-events: none; }

    .freeze-bar {
      display: flex; align-items: center; gap: 14px;
      margin: 0 0 18px; padding: 12px 16px;
      border: 1px solid var(--warn-line); border-left: 3px solid var(--warn);
      background: var(--warn-bg); border-radius: var(--r-lg);
    }
    .fb-lock { color: var(--warn); flex-shrink: 0; }
    .fb-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .fb-text strong { font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--warn); }
    .fb-text span { font-size: 12px; color: var(--ink-2); }
    .fb-text b { font-family: var(--font-mono); font-weight: 600; color: var(--ink); }
    .fb-resume {
      margin-left: auto; flex-shrink: 0;
      height: 34px; padding: 0 16px;
      border: 1px solid var(--pos); background: var(--pos); color: #fff;
      border-radius: var(--r-sm); cursor: pointer;
      font-family: var(--font-ui); font-size: 12.5px; font-weight: 600;
      transition: opacity .12s, transform .04s;
    }
    .fb-resume:hover { opacity: .9; }
    .fb-resume:active { transform: translateY(1px); }

    .ci-note {
      margin: 0 0 10px; padding: 6px 13px; border-radius: var(--r);
      background: var(--warn-bg); border: 1px solid var(--warn-line); color: var(--warn);
      font-size: 12px;
    }
    .ci-note.real {
      background: var(--pos-bg); border-color: var(--pos-line); color: var(--pos);
    }

    /* Auto-selección: una tira con dos mitades, sin gradientes (de-slop) */
    .auto-banner {
      display: grid; grid-template-columns: 1fr 1fr; margin-bottom: 18px;
      border: 1px solid var(--line); border-radius: var(--r-lg);
      background: var(--surface); box-shadow: var(--shadow-sm); overflow: hidden;
    }
    .auto-pill {
      display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px;
      padding: 14px 16px; position: relative;
    }
    .auto-pill.buy { border-left: 3px solid var(--accent); }
    .auto-pill.sell { border-left: 3px solid var(--warn); }
    .auto-pill.buy + .auto-pill.sell { border-left-color: var(--line); box-shadow: inset 3px 0 0 var(--warn); }
    .auto-pill .auto-action {
      font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--ink-3);
    }
    .auto-pill .auto-ticker {
      font-family: var(--font-mono); font-size: 22px; font-weight: 600;
      letter-spacing: -0.01em; color: var(--ink);
    }
    .auto-pill .auto-quote {
      margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; gap: 1px;
    }
    .auto-pill .auto-rate {
      font-family: var(--font-mono); font-size: 16px; font-weight: 600;
      color: var(--ink); line-height: 1.1;
    }
    .auto-pill .auto-unit { font-size: 10px; font-weight: 500; color: var(--ink-3); margin-left: 2px; }
    .auto-pill .auto-vol {
      font-family: var(--font-mono); font-size: 12.5px; font-weight: 600; color: var(--ink-2);
    }
    /* Volumen operable real, consolidado al pie de la caja de puntas.
       Es el dato que limita la operación → se trata como la zona "oportunidad":
       fondo verde, barra de acento a la izquierda y número protagonista. */
    .auto-operable {
      grid-column: 1 / -1;
      display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
      padding: 11px 16px; border-top: 1px solid var(--pos-line);
      background: var(--pos-bg); box-shadow: inset 3px 0 0 var(--pos);
    }
    .auto-operable .ao-lbl {
      font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--pos); margin-right: auto;
    }
    .auto-operable .ao-units { font-family: var(--font-mono); font-size: 17px; font-weight: 700; color: var(--pos-strong); }
    .auto-operable .ao-mny { font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--ink); }
    .auto-operable .ao-sep { color: var(--pos-line); }

    /* ── Nominales a apretar en el broker ─────────────────────────────────
       El output accionable: tabla de las 4 órdenes con cantidades enteras.
       Espeja el layout del ejercicio (Acción · Ticker · Precio · Nominales · Monto). */
    .nominals {
      margin-bottom: 0; border: 1px solid var(--line); border-radius: var(--r-lg);
      background: var(--surface); box-shadow: var(--shadow-sm); overflow: hidden;
    }
    .nm-head {
      display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
      padding: 9px 16px 8px; border-bottom: 1px solid var(--line);
    }
    .nm-head h3 {
      margin: 0; font-family: var(--font-display); font-size: 14px; font-weight: 700; color: var(--ink);
      display: flex; align-items: center; gap: 8px;
    }
    .nm-head h3::before { content: ''; width: 7px; height: 7px; border-radius: 2px; background: var(--accent); }
    .nm-sub { font-size: 11px; color: var(--ink-3); line-height: 1.4; flex: 1; min-width: 320px; }
    .nm-sub strong { font-family: var(--font-mono); color: var(--ink-2); font-weight: 600; }

    table.nm-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .nm-table th {
      text-align: left; padding: 5px 16px; background: var(--surface-2);
      font-weight: 600; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em;
      color: var(--ink-3); border-bottom: 1px solid var(--line); white-space: nowrap;
    }
    .nm-table th.num, .nm-table td.num { text-align: right; }
    .nm-table td {
      padding: 6px 16px; border-bottom: 1px solid var(--line); color: var(--ink); white-space: nowrap;
    }
    .nm-table tbody tr:last-child td { border-bottom: 0; }
    .nm-table td.num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .nm-table td.ix { color: var(--ink-3); font-family: var(--font-mono); font-size: 12px; width: 1%; }
    .nm-table .op { font-weight: 600; }
    .nm-table .cur {
      font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: 0.04em;
      color: var(--ink-3); border: 1px solid var(--line-2); border-radius: var(--r-sm); padding: 1px 5px; margin-left: 4px;
    }
    .nm-table .tk {
      font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--ink);
      background: var(--surface); border: 1px solid var(--line); padding: 2px 7px; border-radius: var(--r-sm);
    }
    /* Nominales: el dato protagonista, lo que se opera en cada orden. */
    .nm-table td.nom { font-size: 15px; font-weight: 700; color: var(--ink); }

    /* Codificación direccional estilo blotter: cada pata se lee por color en TODA
       la fila (compra = azul acento, venta = ámbar), no sólo en una palabra.
       Washes muy tenues (off-white) para no romper la baja fatiga. */
    .nm-table tr.op-buy td  { background: var(--accent-sf); }
    .nm-table tr.op-sell td { background: var(--warn-bg); }
    .nm-table tr.op-buy td.ix  { box-shadow: inset 3px 0 0 var(--accent); }
    .nm-table tr.op-sell td.ix { box-shadow: inset 3px 0 0 var(--warn); }
    .nm-table tr.op-buy .op,
    .nm-table tr.op-buy td.nom  { color: var(--accent-2); }
    .nm-table tr.op-sell .op,
    .nm-table tr.op-sell td.nom { color: var(--warn-strong); }
    .nm-table tr.op-buy .tk  { background: var(--surface); border-color: var(--accent);    color: var(--accent-2); }
    .nm-table tr.op-sell .tk { background: var(--surface); border-color: var(--warn-line); color: var(--warn-strong); }

    .nm-foot {
      display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
      padding: 8px 16px; background: var(--surface); border-top: 1px solid var(--line);
    }
    .nm-left { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--ink-2); }
    .nm-left .nm-lbl {
      font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-3);
    }
    .nm-left .nm-val { font-family: var(--font-mono); font-weight: 600; color: var(--ink); }
    .nm-left .nm-sep { color: var(--line); }
    .nm-left .nm-note { font-size: 11px; color: var(--ink-3); font-style: italic; }
    /* Lectura de P&L: contenedor limpio sobre --surface con un hairline que sólo
       se tiñe según el signo (sin relleno de color, sin franja lateral). El color
       saturado vive únicamente en la cifra, como el resto del sistema. */
    .nm-prof {
      display: flex; flex-direction: column; align-items: flex-end; gap: 3px;
      padding: 9px 16px; border-radius: var(--r);
      background: var(--surface); border: 1px solid var(--line);
    }
    .nm-prof.pos { border-color: var(--pos-line); }
    .nm-prof.neg { border-color: var(--neg-line); }
    .nm-prof .nm-lbl {
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.09em; color: var(--ink-3);
    }
    .nm-prof .nm-pmain { display: flex; align-items: baseline; gap: 8px; line-height: 1; }
    .nm-prof .nm-pval { font-family: var(--font-mono); font-size: 25px; font-weight: 700; letter-spacing: -0.02em; }
    .nm-prof .nm-ppct { font-family: var(--font-mono); font-size: 13px; font-weight: 700; }
    /* Secundario: palabras en la tipografía de UI, sólo las cifras en mono. */
    .nm-prof .nm-net {
      font-family: var(--font-ui); font-size: 11.5px; font-weight: 500;
      color: var(--ink-3); line-height: 1.5; text-align: right;
    }
    .nm-prof .nm-net .n { font-family: var(--font-mono); font-weight: 600; color: var(--ink-2); }
    .nm-prof .nm-net .muted { color: var(--ink-3); opacity: .65; }
    .nm-prof.pos .nm-pval, .nm-prof.pos .nm-ppct { color: var(--pos-strong); }
    .nm-prof.neg .nm-pval, .nm-prof.neg .nm-ppct { color: var(--neg-strong); }

    .nm-empty {
      padding: 22px 16px; color: var(--ink-2); font-size: 12.5px; line-height: 1.55;
    }
    .nm-empty b { font-family: var(--font-mono); color: var(--ink); }

    .grid {
      display: grid; gap: 14px;
      grid-template-columns: repeat(auto-fit, minmax(264px, 1fr));
      margin-bottom: 12px;
    }
    .card {
      background: var(--surface); border: 1px solid var(--line);
      border-radius: var(--r-lg); padding: 12px 14px; box-shadow: var(--shadow-sm);
    }
    .card h3 {
      margin: 0 0 4px; font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--ink);
      display: flex; align-items: center; gap: 8px;
    }
    /* Marcador de tipo en vez de franja lateral completa */
    .card h3::before {
      content: ''; width: 7px; height: 7px; border-radius: 2px; background: var(--ink-3);
    }
    .card.buy h3::before { background: var(--accent); }
    .card.sell h3::before { background: var(--warn); }
    .card.result.profit h3::before { background: var(--pos); }
    .card .hint { margin: 0 0 8px; font-size: 11px; color: var(--ink-3); }
    .card select {
      width: 100%; padding: 6px 10px; font-size: 13px; font-family: var(--font-ui);
      border: 1px solid var(--line); border-radius: var(--r-sm);
      background: var(--surface); color: var(--ink); outline: none;
    }
    .card select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-sf); }
    .card-body { margin-top: 8px; }
    /* Ticker protagonista: el CEDEAR/acción que se va a operar en esta punta. */
    .card-ticker {
      font-family: var(--font-mono); font-size: 24px; font-weight: 600;
      letter-spacing: -0.01em; line-height: 1; color: var(--ink);
      padding-bottom: 8px; margin-bottom: 4px; border-bottom: 1px solid var(--line);
    }
    .card.buy .card-ticker { color: var(--accent-2); }
    .card.sell .card-ticker { color: var(--warn-strong); }
    .row {
      display: flex; justify-content: space-between; align-items: baseline; padding: 4px 0;
      font-size: 12px; color: var(--ink-2);
    }
    .row strong { color: var(--ink); font-weight: 600; font-family: var(--font-mono); }
    /* Ticker real de la punta (pesos / par en dólares) junto a su precio. */
    .row .tk {
      font-style: normal; font-family: var(--font-mono); font-size: 11px; font-weight: 600;
      color: var(--ink); background: var(--surface-2); border: 1px solid var(--line);
      padding: 1px 6px; border-radius: var(--r-sm); margin-left: 4px;
    }
    /* Precio arriba, volumen operable de esa punta debajo. */
    .row .pv { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
    .row .pv .qty {
      font-style: normal; font-family: var(--font-mono); font-size: 10.5px; font-weight: 600;
      color: var(--ink-3);
    }
    .row.big { padding: 6px 0 0; border-top: 1px solid var(--line); margin-top: 6px; font-size: 13px; }
    .row.big .hi { font-family: var(--font-mono); font-size: 17px; font-weight: 600; color: var(--ink); }

    .card.result.profit { background: var(--pos-bg); border-color: var(--pos-line); box-shadow: var(--shadow-sm), inset 3px 0 0 var(--pos); }
    /* Neto negativo = "sin oportunidad" (informativo), no una pérdida realizada → ámbar, no rojo. */
    .card.result.loss { background: var(--warn-bg); border-color: var(--warn-line); }
    .card.result.loss h3::before { background: var(--warn); }

    .no-arb {
      display: flex; flex-direction: column; gap: 6px;
      margin-top: 8px; padding: 16px 14px; border-radius: var(--r);
      background: var(--surface); border: 1px solid var(--warn-line);
    }
    .no-arb strong { font-family: var(--font-display); font-size: 14px; font-weight: 700; color: var(--warn); }
    .no-arb span { font-size: 12px; color: var(--ink-2); line-height: 1.55; }

    .steps { display: flex; flex-direction: column; gap: 5px; }
    .step { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; color: var(--ink-2); }
    .step .val { font-family: var(--font-mono); font-weight: 600; color: var(--ink); }
    .step.muted { color: var(--ink-3); }
    .step.muted .val { color: var(--ink-3); }
    .step.net { font-size: 13px; font-weight: 600; }
    .step.net .lbl { color: var(--pos); }
    .step.net .val { color: var(--pos); }
    .step.net.big-net { font-size: 15px; }
    .step.net.big-net .lbl, .step.net.big-net .val { color: var(--pos-strong); }
    .step.net.big-net .val { font-size: 19px; font-weight: 700; }
    .card.result.loss .step.net .lbl,
    .card.result.loss .step.net .val { color: var(--neg); }
    .steps hr { border: 0; border-top: 1px solid var(--line); margin: 8px 0 6px; }
    .disclaimer { margin: 12px 0 0; font-size: 11px; color: var(--ink-3); line-height: 1.55; }

    .empty {
      padding: 40px 20px; color: var(--ink-3); font-size: 13px; text-align: center;
      border: 1px dashed var(--line); border-radius: var(--r-lg); background: var(--surface);
    }

    /* Botón temporal para disparar el tour (PoC) */
    .tour-test-btn {
      align-self: center; height: 32px; padding: 0 12px;
      border: 1px solid var(--line); background: var(--surface); color: var(--ink);
      border-radius: var(--r-sm); cursor: pointer;
      font-family: var(--font-ui); font-size: 12.5px; font-weight: 600;
      transition: background .12s, border-color .12s, transform .04s;
    }
    .tour-test-btn:hover { background: var(--surface-2); border-color: var(--line-2); }
    .tour-test-btn:active { transform: translateY(1px); }

    .tour-selector { display: inline-flex; gap: 8px; align-items: center; }

    /* ── driver.js: alinear el popover del tour al UI kit ─────────────────── */
    ::ng-deep .driver-popover {
      background: var(--surface) !important;
      color: var(--ink) !important;
      border: 1px solid var(--line) !important;
      border-radius: var(--r-lg) !important;
      box-shadow: var(--shadow) !important;
      font-family: var(--font-ui) !important;
      min-width: 340px !important;
      max-width: 360px !important;
      padding: 20px !important;
    }
    ::ng-deep .driver-popover-footer {
      display: flex !important;
      flex-wrap: nowrap !important;
      align-items: center !important;
      justify-content: space-between !important;
      gap: 14px !important;
      margin-top: 18px !important;
    }
    ::ng-deep .driver-popover-navigation-btns {
      display: flex !important;
      flex-wrap: nowrap !important;
      align-items: center !important;
      gap: 8px !important;
    }
    ::ng-deep .driver-popover-title {
      color: var(--ink) !important;
      font-family: var(--font-display) !important;
      font-weight: 700 !important;
      font-size: 14px !important;
    }
    ::ng-deep .driver-popover-description {
      color: var(--ink-2) !important;
      font-size: 12.5px !important;
      line-height: 1.5 !important;
    }
    ::ng-deep .driver-popover-progress-text {
      color: var(--ink-3) !important;
      font-family: var(--font-mono) !important;
      font-size: 11px !important;
      white-space: nowrap !important;
      flex-shrink: 0 !important;
    }
    ::ng-deep .driver-popover-navigation-btns button {
      background: var(--surface) !important;
      color: var(--ink) !important;
      border: 1px solid var(--line) !important;
      border-radius: var(--r-sm) !important;
      font-family: var(--font-ui) !important;
      font-size: 12.5px !important;
      font-weight: 600 !important;
      text-shadow: none !important;
    }
    ::ng-deep .driver-popover-next-btn,
    ::ng-deep .driver-popover-done-btn {
      background: var(--accent) !important;
      color: #fff !important;
      border-color: var(--accent) !important;
    }
    ::ng-deep .driver-popover-close-btn {
      /* driver.js oculta este botón (display:none inline) cuando
         allowClose es false; lo reforzamos visible porque acá el cierre
         se maneja a mano vía onCloseClick (ver startTour()). */
      display: block !important;
      color: var(--ink-3) !important;
    }
    ::ng-deep .driver-popover-skip-btn {
      background: #000 !important;
      color: #fff !important;
      border: 1px solid #000 !important;
      border-radius: var(--r-sm) !important;
      font-family: var(--font-ui) !important;
      font-size: 12.5px !important;
      font-weight: 600 !important;
      padding: 5px 12px !important;
      cursor: pointer !important;
      margin: 0 !important;
      flex-shrink: 0 !important;
    }
    ::ng-deep .driver-popover-playpause-btn {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 26px !important;
      height: 26px !important;
      padding: 0 !important;
      background: var(--surface) !important;
      color: var(--ink-2) !important;
      border: 1px solid var(--line) !important;
      border-radius: var(--r-sm) !important;
      font-size: 11px !important;
      line-height: 1 !important;
      cursor: pointer !important;
      margin: 0 !important;
      flex-shrink: 0 !important;
    }
    ::ng-deep .driver-popover-playpause-btn:hover {
      background: var(--surface-2) !important;
      color: var(--ink) !important;
    }
    ::ng-deep .driver-popover-arrow-side-top.driver-popover-arrow,
    ::ng-deep .driver-popover-arrow-side-bottom.driver-popover-arrow,
    ::ng-deep .driver-popover-arrow-side-left.driver-popover-arrow,
    ::ng-deep .driver-popover-arrow-side-right.driver-popover-arrow {
      border-color: var(--surface) !important;
    }

    @media (max-width: 480px) {
      .arb-head { flex-direction: row; flex-wrap: wrap; gap: 8px; align-items: center; }
      .badge { height: 22px; padding: 0 7px; font-size: 10px; }
      .monto { width: 100%; }
      .monto input,
      .monto.comm input,
      .monto.vol input,
      .monto.ci input { width: 100%; }
      .pair-count { margin-left: 0; text-align: left; }
      .freeze-btn { align-self: stretch; justify-content: center; }
      .nm-head { flex-direction: column; gap: 6px; }
      .nm-sub { min-width: 0; font-size: 10px; }
      .nm-foot { flex-direction: column; align-items: stretch; }
      .nm-prof { align-items: stretch; text-align: center; }
      .nm-prof .nm-pmain { justify-content: center; }
      .nm-prof .nm-net { text-align: center; }
      .grid { grid-template-columns: 1fr; }
    }

  `],
})
export class ArbitrageComponent implements OnInit, OnDestroy {
  // El disparo del tour lo decide el CONTENEDOR PADRE (boston-ar) vía
  // postMessage: esta app corre en un iframe de otro origen y el localStorage
  // propio es poco confiable (Safari bloquea el storage third-party). El padre
  // sabe si es la 1.ª entrada a Arbitraje tras activar el 2FA y nos manda
  // { type: 'start-arbitraje-tour' }. Validamos SIEMPRE el origen del mensaje.
  private onParentMessage = (e: MessageEvent) => {
    if (!ARB_TOUR_ALLOWED_ORIGINS.includes(e.origin)) return;
    if (e.data && e.data.type === 'start-arbitraje-tour') this.startTour();
  };

  ngOnInit() {
    window.addEventListener('message', this.onParentMessage);
  }

  ngOnDestroy() {
    window.removeEventListener('message', this.onParentMessage);
  }

  startTour() {
    window.scrollTo(0, 0);
    // allowClose:false bloquea el cierre por click en el overlay (y Escape),
    // pero en driver.js@1.8 esa misma flag también apaga el botón X y el
    // cierre por closeClick interno. Por eso proveemos onCloseClick propio
    // (bypassea el gate de allowClose) y forzamos la visibilidad del botón
    // X por CSS (ver ::ng-deep .driver-popover-close-btn más abajo).
    let tourDriver: ReturnType<typeof driver>;

    // --- Autoplay: avanza solo cada AUTOPLAY_MS, pausable a mano ---------
    // El timer vive en esta closure (no en el componente) porque es 1:1 con
    // esta instancia de tourDriver: cada startTour() arranca su propio
    // temporizador y debe limpiar el suyo, nunca el de una corrida anterior.
    const AUTOPLAY_MS = 4500;
    let autoplayTimerId: ReturnType<typeof setTimeout> | null = null;
    let autoplayEnabled = true;

    const clearAutoplayTimer = () => {
      if (autoplayTimerId !== null) {
        clearTimeout(autoplayTimerId);
        autoplayTimerId = null;
      }
    };

    // Se llama tras cada step mostrado (onHighlighted): si el autoplay sigue
    // activo, programa el próximo avance; si no, no hace nada (modo manual).
    const scheduleAutoplayStep = () => {
      clearAutoplayTimer();
      if (!autoplayEnabled) return;
      autoplayTimerId = setTimeout(() => {
        if (tourDriver.isLastStep()) return; // se queda abierto, no autocierra
        tourDriver.moveNext();
      }, AUTOPLAY_MS);
    };

    // Un click manual en Anterior/Siguiente pasa a modo manual: pausa el
    // autoplay antes de navegar, así el próximo onHighlighted no reprograma el timer.
    const pauseFromManualNav = () => {
      autoplayEnabled = false;
      clearAutoplayTimer();
    };

    tourDriver = driver({
      showProgress: true,
      allowClose: false,
      nextBtnText: 'Siguiente',
      prevBtnText: 'Anterior',
      doneBtnText: 'Hecho',
      progressText: '{{current}} de {{total}}',
      onCloseClick: () => { clearAutoplayTimer(); tourDriver.destroy(); },
      onDestroyed: () => clearAutoplayTimer(),
      onHighlighted: () => scheduleAutoplayStep(),
      // driver.js no expone moveNext/movePrevious "puros": setear onNextClick/
      // onPrevClick a nivel global reemplaza la navegación por defecto de esos
      // botones, así que acá replicamos esa navegación a mano (isLastStep ⇒
      // cierra como el botón "Hecho"; si no, moveNext) después de pasar a modo manual.
      onNextClick: () => {
        pauseFromManualNav();
        if (tourDriver.isLastStep()) tourDriver.destroy();
        else tourDriver.moveNext();
      },
      onPrevClick: () => {
        pauseFromManualNav();
        tourDriver.movePrevious();
      },
      // Agrega botones "Omitir" y pausa/play junto a "Anterior"/"Siguiente" en
      // cada step. driver.js@1.8 no tiene una opción declarativa de botones
      // custom en el popover: el hook onPopoverRender da acceso al DOM ya
      // montado del popover para insertarlos a mano (se recrea en cada step).
      onPopoverRender: (popover) => {
        const skipBtn = document.createElement('button');
        skipBtn.innerText = 'Omitir';
        skipBtn.className = 'driver-popover-skip-btn';
        popover.footerButtons.insertBefore(skipBtn, popover.footerButtons.firstChild);
        skipBtn.addEventListener('click', () => tourDriver.destroy());

        const playPauseBtn = document.createElement('button');
        playPauseBtn.type = 'button';
        playPauseBtn.className = 'driver-popover-playpause-btn';
        const syncPlayPauseBtn = () => {
          playPauseBtn.innerHTML = autoplayEnabled ? '&#10073;&#10073;' : '&#9654;';
          playPauseBtn.title = autoplayEnabled ? 'Pausar avance automático' : 'Reanudar avance automático';
        };
        syncPlayPauseBtn();
        playPauseBtn.addEventListener('click', () => {
          autoplayEnabled = !autoplayEnabled;
          if (autoplayEnabled) scheduleAutoplayStep();
          else clearAutoplayTimer();
          syncPlayPauseBtn();
        });
        popover.footerButtons.insertBefore(playPauseBtn, popover.footerButtons.firstChild);
      },
      steps: [
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
      ],
    });
    tourDriver.drive();
  }

  // --- Inputs (signals input API) ---
  cedearRows = input<CedearRow[]>([]);
  dollarType = input<DollarType>('MEP');
  settlement = input<Settlement>('H24');
  // true = los datos ya son del plazo real (IOL t0). false = fallback data912 → se estima el CI.
  ciIsReal = input<boolean>(false);
  // Estado de pausa global (refresh congelado). Two-way con el shell.
  paused = input<boolean>(false);
  pausedChange = output<boolean>();
  // true = la pausa la disparó el horario de mercado cerrado (auto), no el
  // usuario — el freeze-bar necesita distinguir el mensaje entre las dos causas.
  marketClosed = input<boolean>(false);

  // --- Internal signals ---
  amountArs = signal<number>(DEFAULTS.amountArs);
  // Presupuesto real "de bolsillo" para el solver de nominales enteros.
  // Independiente de amountArs (que es el monto teórico para el % de rendimiento).
  budgetArs = signal<number>(DEFAULTS.budgetArs);
  commissionPct = signal<number>(DEFAULTS.commissionPct);
  ciAdjustPct = signal<number>(DEFAULTS.ciAdjustPct);
  // Volumen efectivo mínimo (USD) por punta para considerar un par operable.
  minUsdVol = signal<number>(DEFAULTS.minUsdVol);
  // Manual override of auto-selection (null = follow automatic best)
  manualBuy = signal<string | null>(null);
  manualSell = signal<string | null>(null);

  // Re-expose helpers for the template
  settlementLabel = settlementLabel;
  // Profundidad operable por punta en UNIDADES (misma convención que computeTrade).
  volBuyUnits = (p: ArbPair) => Math.min(p.qArsAsk, p.qUsdBid);
  volSellUnits = (p: ArbPair) => Math.min(p.qUsdAsk, p.qArsBid);
  // Símbolo del par en dólares (ej. SHEL → SHELD) según el tipo de dólar.
  usdTicker = (base: string) => base + SUFFIX[this.dollarType()];

  // --- Pairs from shared engine ---
  pairs = computed<ArbPair[]>(() =>
    buildPairs(this.cedearRows(), {
      suffix: SUFFIX[this.dollarType()],
      settlement: this.settlement(),
      ciAdjustPct: this.settlement() === 'CI' && !this.ciIsReal() ? this.ciAdjustPct() : 0,
    })
  );

  // Solo los pares con volumen efectivo suficiente en cada punta.
  buyOptions = computed(() =>
    this.pairs()
      .filter(p => buyLegUsd(p) >= this.minUsdVol())
      .sort((a, b) => a.dolarVenta - b.dolarVenta)
  );

  sellOptions = computed(() =>
    this.pairs()
      .filter(p => sellLegUsd(p) >= this.minUsdVol())
      .sort((a, b) => b.dolarCompra - a.dolarCompra)
  );

  // --- Auto-selection: mejor cotización CON volumen ≥ mínimo ----------------
  selectedBuy = computed<ArbPair | null>(() => {
    const m = this.manualBuy();
    if (m) {
      const found = this.pairs().find(p => p.base === m);
      if (found) return found;
    }
    return bestBuy(this.pairs(), this.minUsdVol());
  });

  selectedSell = computed<ArbPair | null>(() => {
    const m = this.manualSell();
    if (m) {
      const found = this.pairs().find(p => p.base === m);
      if (found) return found;
    }
    return bestSell(this.pairs(), this.minUsdVol());
  });

  // --- Trade result from shared engine (gross + net + real volume) ---
  trade = computed<TradeResult | null>(() => {
    const buy = this.selectedBuy();
    const sell = this.selectedSell();
    if (!buy || !sell) return null;
    return computeTrade(buy, sell, {
      amountArs: this.amountArs(),
      commissionPct: this.commissionPct(),
    });
  });

  // --- Solver de nominales enteros: cuántos apretar en el broker ---
  nominalsPlan = computed<NominalsPlan | null>(() => {
    const buy = this.selectedBuy();
    const sell = this.selectedSell();
    if (!buy || !sell) return null;
    return solveNominals(buy, sell, {
      budgetArs: this.budgetArs(),
      commissionPct: this.commissionPct(),
      usdSuffix: SUFFIX[this.dollarType()],
    });
  });

  // Elegir manualmente un CEDEAR congela la página (pausa el refresh) para poder
  // ir al broker y operar sin que la selección/precios cambien.
  onManualBuy(value: string | null) {
    const t = value || null;
    this.manualBuy.set(t);
    if (t) this.pausedChange.emit(true);
  }

  onManualSell(value: string | null) {
    const t = value || null;
    this.manualSell.set(t);
    if (t) this.pausedChange.emit(true);
  }

  freeze() {
    this.pausedChange.emit(true);
  }

  // Volver a vivo: descongelar y soltar la selección manual (vuelve al auto-mejor).
  unfreeze() {
    this.manualBuy.set(null);
    this.manualSell.set(null);
    this.pausedChange.emit(false);
  }

  fmt(v: number | null | undefined, dec = 2): string {
    if (v == null || !isFinite(v)) return '–';
    return v.toLocaleString('es-AR', {
      maximumFractionDigits: dec,
      minimumFractionDigits: dec,
    });
  }
}

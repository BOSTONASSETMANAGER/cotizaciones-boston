/**
 * export-parity.spec.ts — Red de seguridad de la superficie pública de `lib/`.
 *
 * Fija (pin) el inventario de exports portado desde el proyecto Angular. Si
 * durante las fases siguientes alguien borra un export, lo renombra o le cambia
 * el tipo, ESTE archivo se pone rojo en vez de que el faltante se descubra en
 * producción. Los nombres NO son decorativos: §1 del contrato de migración
 * obliga a mantenerlos idénticos al original (`cedearsT0`, `iolSource`,
 * `bestOpps`, …), así que renombrar un export es una violación del contrato,
 * no un detalle de estilo.
 *
 * Cómo está construido:
 *  - `Object.keys(import * as mod)` da los exports de VALOR (los tipos se borran
 *    al compilar). Contra eso se compara la lista esperada.
 *  - Los exports de TIPO se fijan aparte, a nivel de compilación: la tupla
 *    `_TiposFijados` los referencia a todos, así que borrar un tipo rompe
 *    `tsc --noEmit`. Los tipos más cargados de negocio además se instancian con
 *    un literal, lo que fija su FORMA (borrar un campo también rompe tsc).
 *  - Las constantes de negocio se comparan por valor, no sólo por existencia:
 *    §1 del contrato dice que los números se copian tal cual (`ALERT_FIRE`,
 *    `DEFAULTS`, …), y un typo en un default no rompería ningún otro test.
 *
 * Estrictez: igualdad EXACTA de conjuntos para los 10 módulos. Todos los
 * agentes cerraron su fase, así que un export NUEVO también debe fallar: si
 * alguien amplía la superficie pública de `lib/`, tiene que pasar por el
 * contrato y actualizar este inventario a mano, no colarse en silencio.
 *
 * (Durante la migración los 2 módulos de B4-operar se chequeaban como SUPERSET
 * para no ponerles el suite en rojo mientras seguían agregando exports. B4 cerró
 * el 2026-08-03 y se pasaron a exacto, igual que el resto.)
 *
 * Los inventarios siguen separados por agente responsable a propósito: es la
 * trazabilidad de quién portó qué, y el test de totales fija el reparto 49/14.
 */
import { describe, expect, it } from 'vitest';

import * as arbEngine from '@/lib/arb-engine';
import * as marketConfig from '@/lib/market.config';
import * as marketHours from '@/lib/market-hours.config';
import * as cedearsMeta from '@/lib/cedears-meta';
import * as panelSnapshot from '@/lib/panel-snapshot';
import * as tourUtil from '@/lib/tour.util';
import * as parentTourUtil from '@/lib/parent-tour.util';
import * as signalStore from '@/lib/signal';
import * as operarTypes from '@/lib/operar.types';
import * as operarStorage from '@/lib/operar-storage';

// ── Exports de TIPO: se fijan a nivel de compilación ────────────────────────
import type { ArbOpportunity, MonitorSettings } from '@/lib/arb-engine';
import type {
  ArbPair,
  ArbTab,
  CedearRow,
  DollarType,
  NominalsPlan,
  QuoteSpec,
  Settlement,
  TradeResult,
} from '@/lib/market.config';
import type { MarketHoursConfig, MarketHoursOverride } from '@/lib/market-hours.config';
import type { CedearMeta } from '@/lib/cedears-meta';
import type { ParentTourFocus, ParentTourView } from '@/lib/parent-tour.util';
import type { Signal } from '@/lib/signal';
import type {
  ChartRango,
  ChartRangoDef,
  CurrencyPill,
  CurrencyPillId,
  DolarStripRow,
  FondoRow,
  HistoricoPoint,
  InstrumentId,
  InstrumentPill,
  MoverRow,
  OperarInstrumento,
  OperarSubview,
  PanelRow,
  PanelSortColumn,
  PanelSortState,
  PanelSubTabDef,
  TenenciaRow,
  TicketPlazo,
  TicketPlazoDef,
  TicketState,
  TicketStep,
  TicketTipoOperacion,
  TicketTipoPrecio,
  TicketTipoPrecioDef,
} from '@/lib/operar.types';
import type { AddMovementInput, SimulatedMovement } from '@/lib/operar-storage';

/**
 * Referencia a los 42 tipos exportados. No corre en runtime: existe para que
 * `tsc --noEmit` falle si alguno se borra o se renombra. Si agregás un tipo
 * exportado nuevo, agregalo acá también.
 */
type _TiposFijados = [
  // arb-engine (2)
  MonitorSettings,
  ArbOpportunity,
  // market.config (8)
  DollarType,
  Settlement,
  CedearRow,
  ArbPair,
  TradeResult,
  NominalsPlan,
  ArbTab,
  QuoteSpec,
  // market-hours.config (2)
  MarketHoursConfig,
  MarketHoursOverride,
  // cedears-meta (1)
  CedearMeta,
  // parent-tour.util (2)
  ParentTourView,
  ParentTourFocus,
  // signal (1)
  Signal<number>,
  // operar.types (24)
  PanelRow,
  OperarSubview,
  InstrumentId,
  InstrumentPill,
  DolarStripRow,
  MoverRow,
  FondoRow,
  CurrencyPillId,
  CurrencyPill,
  PanelSubTabDef,
  PanelSortColumn,
  PanelSortState,
  ChartRango,
  ChartRangoDef,
  HistoricoPoint,
  TicketStep,
  TicketTipoPrecio,
  TicketTipoPrecioDef,
  TicketPlazo,
  TicketPlazoDef,
  TicketState,
  OperarInstrumento,
  TicketTipoOperacion,
  TenenciaRow,
  // operar-storage (2)
  SimulatedMovement,
  AddMovementInput,
];

// Se usa para que `_TiposFijados` no quede como declaración huérfana.
const _tiposFijadosLargo: _TiposFijados['length'] = 42;

// ── Inventario esperado de exports de VALOR ─────────────────────────────────
// Derivado mecánicamente de los `export` de src/app/*.ts (no tipeado a mano).

const A2_ESPERADO: Record<string, { mod: Record<string, unknown>; exports: string[] }> = {
  'lib/arb-engine.ts': {
    mod: arbEngine,
    exports: [
      'bestBuy',
      'bestSell',
      'buildPairs',
      'buyLegUsd',
      'computeTrade',
      'nextAlertState',
      'scanOpportunities',
      'sellLegUsd',
      'solveNominals',
    ],
  },
  'lib/market.config.ts': {
    mod: marketConfig,
    exports: [
      'ARB_TABS',
      'BOND_TYPE_ORDER',
      'DATA912_CEDEARS_URL',
      'DEFAULTS',
      'ETF_SPECS',
      'INDEX_SPECS',
      'IOL_PLAZO',
      'NOTE_TYPE_ORDER',
      'PANEL_LIDER',
      'REGION_ORDER',
      'SUFFIX',
      'bondHistoryUrl',
      'bondType',
      'cohenCedearsUrl',
      'cohenFeedBase',
      'cohenHistoricoUrl',
      'dropUsdVariants',
      'estimateCi',
      'iolCedearsUrl',
      'noteType',
      'settlementLabel',
      'yahooSparkUrl',
    ],
  },
  'lib/market-hours.config.ts': {
    mod: marketHours,
    exports: [
      'MARKET_HOURS',
      'MARKET_HOURS_STORAGE_KEY',
      'getEffectiveMarketHours',
      'isMarketOpen',
      'isValidTimeRange',
      'loadMarketHoursOverride',
      'saveMarketHoursOverride',
    ],
  },
  'lib/cedears-meta.ts': {
    mod: cedearsMeta,
    exports: ['CEDEAR_META', 'cedearMeta'],
  },
  'lib/panel-snapshot.ts': {
    mod: panelSnapshot,
    exports: ['loadSnapshot', 'saveSnapshot'],
  },
  'lib/tour.util.ts': {
    mod: tourUtil,
    exports: ['runTour'],
  },
  'lib/parent-tour.util.ts': {
    mod: parentTourUtil,
    exports: ['isEmbedded', 'listenParentTour'],
  },
  'lib/signal.ts': {
    mod: signalStore,
    exports: ['computed', 'signal', 'useComputed', 'useSignal'],
  },
};

// Portados por B4-operar. Fase cerrada el 2026-08-03 → mismo nivel de estrictez
// que los de A2 (conjunto exacto). Separados sólo para conservar la trazabilidad
// de autoría y el reparto de totales.
const B4_ESPERADO: Record<string, { mod: Record<string, unknown>; exports: string[] }> = {
  'lib/operar.types.ts': {
    mod: operarTypes,
    exports: [
      'CHART_RANGOS',
      'CURRENCY_PILLS',
      'FONDO_TIPO_LABEL',
      'INSTRUMENTO_CHIP_LABEL',
      'INSTRUMENT_PILLS',
      'TICKET_PLAZOS',
      'TICKET_TIPO_PRECIO',
    ],
  },
  'lib/operar-storage.ts': {
    mod: operarStorage,
    exports: [
      'SIMULATED_MOVEMENTS_STORAGE_KEY',
      'addMovement',
      'loadHomeColLeft',
      'loadHomeColRight',
      'loadMovements',
      'saveHomeColLeft',
      'saveHomeColRight',
    ],
  },
};

describe('inventario de exports — módulos portados por A2-logic (conjunto EXACTO)', () => {
  for (const [ruta, { mod, exports }] of Object.entries(A2_ESPERADO)) {
    it(`${ruta} exporta exactamente los ${exports.length} símbolos de valor esperados`, () => {
      expect(Object.keys(mod).sort()).toEqual([...exports].sort());
    });
  }
});

describe('inventario de exports — módulos portados por B4-operar (conjunto EXACTO)', () => {
  for (const [ruta, { mod, exports }] of Object.entries(B4_ESPERADO)) {
    it(`${ruta} exporta exactamente los ${exports.length} símbolos de valor esperados`, () => {
      expect(Object.keys(mod).sort()).toEqual([...exports].sort());
    });
  }
});

describe('tipo de cada export de valor', () => {
  it('las funciones siguen siendo funciones', () => {
    const funciones: unknown[] = [
      // arb-engine
      arbEngine.buildPairs,
      arbEngine.buyLegUsd,
      arbEngine.sellLegUsd,
      arbEngine.bestBuy,
      arbEngine.bestSell,
      arbEngine.computeTrade,
      arbEngine.solveNominals,
      arbEngine.scanOpportunities,
      arbEngine.nextAlertState,
      // market.config
      marketConfig.iolCedearsUrl,
      marketConfig.cohenFeedBase,
      marketConfig.cohenCedearsUrl,
      marketConfig.cohenHistoricoUrl,
      marketConfig.estimateCi,
      marketConfig.settlementLabel,
      marketConfig.bondType,
      marketConfig.noteType,
      marketConfig.bondHistoryUrl,
      marketConfig.dropUsdVariants,
      marketConfig.yahooSparkUrl,
      // market-hours.config
      marketHours.isValidTimeRange,
      marketHours.loadMarketHoursOverride,
      marketHours.saveMarketHoursOverride,
      marketHours.getEffectiveMarketHours,
      marketHours.isMarketOpen,
      // cedears-meta
      cedearsMeta.cedearMeta,
      // panel-snapshot
      panelSnapshot.saveSnapshot,
      panelSnapshot.loadSnapshot,
      // tour.util
      tourUtil.runTour,
      // parent-tour.util
      parentTourUtil.isEmbedded,
      parentTourUtil.listenParentTour,
      // signal
      signalStore.signal,
      signalStore.computed,
      signalStore.useSignal,
      signalStore.useComputed,
      // operar-storage (B4)
      operarStorage.loadMovements,
      operarStorage.addMovement,
      operarStorage.loadHomeColLeft,
      operarStorage.loadHomeColRight,
      operarStorage.saveHomeColLeft,
      operarStorage.saveHomeColRight,
    ];
    expect(funciones).toHaveLength(41);
    for (const f of funciones) expect(typeof f).toBe('function');
  });

  it('los arreglos siguen siendo arreglos', () => {
    for (const a of [
      marketConfig.ARB_TABS,
      marketConfig.BOND_TYPE_ORDER,
      marketConfig.NOTE_TYPE_ORDER,
      marketConfig.REGION_ORDER,
      marketConfig.INDEX_SPECS,
      marketConfig.ETF_SPECS,
      marketConfig.PANEL_LIDER,
      operarTypes.INSTRUMENT_PILLS,
      operarTypes.CURRENCY_PILLS,
      operarTypes.CHART_RANGOS,
      operarTypes.TICKET_PLAZOS,
      operarTypes.TICKET_TIPO_PRECIO,
    ]) {
      expect(Array.isArray(a)).toBe(true);
    }
  });

  it('las claves de storage siguen siendo los mismos strings', () => {
    // Cambiar cualquiera de estas invalida los datos ya persistidos del usuario.
    expect(marketHours.MARKET_HOURS_STORAGE_KEY).toBe('boston-market-hours');
    expect(operarStorage.SIMULATED_MOVEMENTS_STORAGE_KEY).toBe('boston-simulated-movements');
    expect(marketConfig.DATA912_CEDEARS_URL).toBe('/api/data912/live/arg_cedears');
  });
});

describe('valores de las constantes de negocio (§1: se copian tal cual)', () => {
  it('DEFAULTS mantiene cada número del original', () => {
    expect(marketConfig.DEFAULTS).toEqual({
      refreshSec: 1,
      commissionPct: 2,
      ciAdjustPct: 0.3,
      amountArs: 1_000_000,
      budgetArs: 150_000,
      minUsdVol: 1000,
    });
  });

  it('SUFFIX e IOL_PLAZO mantienen el mapeo de dólar y plazo', () => {
    expect(marketConfig.SUFFIX).toEqual({ MEP: 'D', CCL: 'C' });
    expect(marketConfig.IOL_PLAZO).toEqual({ CI: 't0', H24: 't1' });
  });

  it('ARB_TABS conserva las 4 pestañas, sus ids y su orden', () => {
    expect(marketConfig.ARB_TABS.map((t) => t.id)).toEqual(['mep-ci', 'mep-24', 'ccl-ci', 'ccl-24']);
    expect(marketConfig.ARB_TABS.map((t) => t.short)).toEqual([
      'MEP CI',
      'MEP 24h',
      'CCL CI',
      'CCL 24h',
    ]);
  });

  it('MARKET_HOURS conserva el horario y los días de rueda', () => {
    expect(marketHours.MARKET_HOURS).toEqual({
      enabled: true,
      open: '10:30',
      close: '17:00',
      timezone: 'America/Argentina/Buenos_Aires',
      workdays: [1, 2, 3, 4, 5],
    });
  });

  it('los órdenes de presentación de bonos y letras no cambian', () => {
    expect(marketConfig.REGION_ORDER).toEqual(['EEUU', 'Europa', 'Asia']);
    expect(marketConfig.BOND_TYPE_ORDER).toEqual([
      'Bonares',
      'Globales',
      'CER',
      'Tasa Fija',
      'Duales / TAMAR',
      'Dólar Linked',
      'Bopreales',
      'Cupones PBI',
      'Provinciales',
      'Otros',
    ]);
    expect(marketConfig.NOTE_TYPE_ORDER).toEqual([
      'Lecaps (Tasa Fija)',
      'Leceres (CER)',
      'Dólar Linked',
      'Otros',
    ]);
  });

  it('los datasets no perdieron filas en la migración', () => {
    expect(marketConfig.PANEL_LIDER).toHaveLength(21);
    expect(marketConfig.PANEL_LIDER).toContain('GGAL');
    expect(marketConfig.PANEL_LIDER).toContain('YPFD');
    expect(marketConfig.INDEX_SPECS).toHaveLength(17);
    expect(marketConfig.ETF_SPECS).toHaveLength(12);
    expect(Object.keys(cedearsMeta.CEDEAR_META)).toHaveLength(365);
  });

  it('los catálogos de Operar (B4) conservan su cardinalidad', () => {
    expect(operarTypes.INSTRUMENT_PILLS).toHaveLength(5);
    expect(operarTypes.CURRENCY_PILLS).toHaveLength(3);
    expect(operarTypes.CHART_RANGOS).toHaveLength(5);
    expect(operarTypes.TICKET_PLAZOS).toHaveLength(4);
    expect(operarTypes.TICKET_TIPO_PRECIO).toHaveLength(2);
  });
});

describe('forma de los tipos cargados de negocio (falla en tsc, no en runtime)', () => {
  it('los literales siguen satisfaciendo cada interface', () => {
    // Si a alguno de estos tipos le borran un campo, este bloque no compila.
    const row: CedearRow = {
      symbol: 'AAPL',
      q_bid: 1,
      px_bid: 1000,
      px_ask: 1010,
      q_ask: 1,
      v: 0,
      q_op: 0,
      c: 0,
      pct_change: 0,
    };
    const pair: ArbPair = {
      base: 'AAPL',
      arsBid: 1000,
      arsAsk: 1010,
      usdBid: 0.7,
      usdAsk: 0.71,
      qArsBid: 1,
      qArsAsk: 1,
      qUsdBid: 1,
      qUsdAsk: 1,
      dolarCompra: 1408,
      dolarVenta: 1442,
      spreadPct: 2.4,
    };
    const settings: MonitorSettings = { commissionPct: 2, minUsdVol: 1000, ciAdjustPct: 0.3 };
    const meta: CedearMeta = { sector: 'Tecnología', capBn: 4000 };
    const horas: MarketHoursConfig = {
      enabled: true,
      open: '10:30',
      close: '17:00',
      timezone: 'America/Argentina/Buenos_Aires',
      workdays: [1, 2, 3, 4, 5],
    };
    const override: MarketHoursOverride = { open: '11:00', close: '16:00' };
    const foco: ParentTourFocus = { view: 'arbitraje', selector: '.arb-subtabs' };
    const vista: ParentTourView = 'cotizaciones';
    const sig: Signal<number> = signalStore.signal(0);

    expect(row.symbol).toBe('AAPL');
    expect(pair.base).toBe('AAPL');
    expect(settings.minUsdVol).toBe(1000);
    expect(meta.capBn).toBe(4000);
    expect(horas.workdays).toHaveLength(5);
    expect(override.open).toBe('11:00');
    expect(foco.view).toBe('arbitraje');
    expect(vista).toBe('cotizaciones');
    expect(sig()).toBe(0);
    expect(_tiposFijadosLargo).toBe(42);
  });
});

describe('totales de la auditoría', () => {
  it('los 10 módulos suman los 105 exports inventariados (63 de valor + 42 de tipo)', () => {
    const valorA2 = Object.values(A2_ESPERADO).reduce((n, m) => n + m.exports.length, 0);
    const valorB4 = Object.values(B4_ESPERADO).reduce((n, m) => n + m.exports.length, 0);
    expect(valorA2).toBe(49);
    expect(valorB4).toBe(14);
    expect(valorA2 + valorB4).toBe(63);
    expect(_tiposFijadosLargo).toBe(42);
    // 100 vienen de src/app/*.ts; los 5 restantes son de lib/signal.ts, que es
    // nuevo (el reemplazo de los signals de Angular, no tiene original que portar).
    expect(valorA2 + valorB4 + _tiposFijadosLargo).toBe(105);
  });
});

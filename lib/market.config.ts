/**
 * market.config.ts — Hogar canónico de tipos compartidos y configuración.
 * Los demás módulos (motor de arbitraje, UI, data layer) importan desde acá.
 * NO incluir lógica de cálculo de pares (eso vive en el motor).
 */

// ── Tipos de dólar y plazo ──────────────────────────────────────────────────
export type DollarType = 'MEP' | 'CCL';
export type Settlement = 'CI' | 'H24'; // CI=T+0 (IOL por símbolo, o estimado), H24=T+1/24hs (panel)

// ── Fila cruda del libro de un CEDEAR ───────────────────────────────────────
export interface CedearRow {
  symbol: string;
  q_bid: number;
  px_bid: number;
  px_ask: number;
  q_ask: number;
  v: number;
  q_op: number;
  c: number;
  pct_change: number;
}

/**
 * Par de un activo cotizado en ARS y en USD.
 * Convención de dólar (la usa el motor):
 *   dolarCompra = arsBid / usdAsk  (vendés USD, valor más bajo)
 *   dolarVenta  = arsAsk / usdBid  (comprás USD, valor más alto)
 * Siempre dolarCompra < dolarVenta.
 */
export interface ArbPair {
  base: string;
  arsBid: number;
  arsAsk: number;
  usdBid: number;
  usdAsk: number;
  qArsBid: number;
  qArsAsk: number;
  qUsdBid: number;
  qUsdAsk: number;
  dolarCompra: number;
  dolarVenta: number;
  spreadPct: number;
}

// ── Resultado de una operación de arbitraje round-trip ──────────────────────
export interface TradeResult {
  buy: ArbPair;
  sell: ArbPair;
  n1: number;
  usdMid: number;
  n2: number;
  arsOut: number;
  grossProfit: number;
  grossPct: number;
  commissionPct: number;
  netProfit: number;
  netPct: number;
  buyVolUnits: number;
  sellVolUnits: number;
  tradeableUnits: number;
  tradeableArs: number;
  tradeableUsd: number;
}

/**
 * Plan de nominales ENTEROS a operar en el broker, derivado de un presupuesto
 * en ARS. A diferencia de `TradeResult` (cantidades fraccionarias), acá cada
 * compra se redondea con `floor` al dinero disponible y la segunda pata se
 * financia con los dólares REALMENTE obtenidos en la primera. Espeja las 4
 * acciones del broker del ejercicio de arbitraje (Arbitrage.xlsx).
 */
export interface NominalsPlan {
  // Identidad de las patas / tickers de las 4 acciones del broker
  buyBase: string;       // buy.base
  buyArsTicker: string;  // = buy.base   — fila 1: lo que COMPRO en pesos
  sellUsdTicker: string; // buy.base + sufijo — fila 2: lo que VENDO en dólares
  buyUsdTicker: string;  // sell.base + sufijo — fila 3: lo que COMPRO en dólares
  sellBase: string;      // = sell.base  — fila 4: lo que VENDO en pesos

  // Precios unitarios de cada acción (el plan es autosuficiente para la UI)
  buyArsAsk: number;     // fila 1: precio al que compro en ARS  (buy.arsAsk)
  buyUsdBid: number;     // fila 2: precio al que vendo en USD   (buy.usdBid)
  sellUsdAsk: number;    // fila 3: precio al que compro en USD  (sell.usdAsk)
  sellArsBid: number;    // fila 4: precio al que vendo en ARS   (sell.arsBid)

  // Paso 1 — compro CEDEAR en ARS
  nBuy: number;          // nominales enteros comprados
  arsSpent: number;      // nBuy * buy.arsAsk
  arsLeftover: number;   // budgetArs - arsSpent ("no alcanza para otro nominal")

  // Paso 2 — vendo su par en USD
  usdObtained: number;   // nBuy * buy.usdBid

  // Paso 3 — compro CEDEAR en USD (limitado por usdObtained, no por el budget)
  nSell: number;         // nominales enteros comprados con usdObtained
  usdSpent: number;      // nSell * sell.usdAsk
  usdLeftover: number;   // usdObtained - usdSpent

  // Paso 4 — vendo su par en ARS
  arsOut: number;        // nSell * sell.arsBid (sólo los nominales ENTEROS vendidos)

  // Sobrante USD desplegado: el floor de nSell deja dólares ociosos; se valúan al
  // tipo de cambio de la pata vendedora para no subestimar la ganancia (equivale a
  // desplegar TODOS los dólares obtenidos en la 1.ª pata).
  usdSellRate: number;   // sell.arsBid / sell.usdAsk — ARS por USD en la pata vendedora
  usdLeftoverArs: number;// usdLeftover * usdSellRate — valor en ARS del sobrante USD
  arsOutFull: number;    // arsOut + usdLeftoverArs (= usdObtained * usdSellRate)

  // Resultado medido contra lo realmente invertido (arsSpent, no el budget),
  // contando el sobrante en dólares (arsOutFull, no arsOut).
  commissionPct: number;
  grossProfit: number;   // arsOutFull - arsSpent (cuenta el sobrante USD)
  netProfit: number;     // grossProfit - arsSpent * commissionPct/100
  netPct: number;        // netProfit / arsSpent * 100
}

// Sufijo de ticker según tipo de dólar (MEP→D, CCL→C).
export const SUFFIX: Record<DollarType, 'D' | 'C'> = { MEP: 'D', CCL: 'C' };

// ── Defaults editables (la UI puede sobreescribirlos) ───────────────────────
export const DEFAULTS = {
  refreshSec: 1,      // refresco por defecto (feeds rápidos; t0 se auto-regula)
  commissionPct: 2,   // gastos/comisión estándar round-trip
  ciAdjustPct: 0.30,  // ajuste para estimar CI desde 24hs
  amountArs: 1_000_000,
  budgetArs: 150_000, // presupuesto real "de bolsillo" para el solver de nominales enteros
  minUsdVol: 1000,    // volumen efectivo mínimo (USD) por punta para considerar un par
} as const;

// ── Fuentes de datos de CEDEARs ─────────────────────────────────────────────
// IOL (vía serverless function /api/iol/cedears): t1 = panel completo (libro
// 24hs); t0 = cotización POR SÍMBOLO (el panel de IOL ignora el plazo) sólo
// para el subset líquido. data912 es el fallback (un solo libro ≈ 24hs).
export const IOL_PLAZO: Record<Settlement, 't0' | 't1'> = { CI: 't0', H24: 't1' };
export const iolCedearsUrl = (s: Settlement): string =>
  `/api/iol/cedears?plazo=${IOL_PLAZO[s]}`;
export const DATA912_CEDEARS_URL = '/api/data912/live/arg_cedears';

// ── Feed Cohen (Primary/XOMS vía backend/cohen-feed) ────────────────────────
// Fuente PRINCIPAL de CEDEARs. Por defecto pega al proxy same-origin
// /api/cohen/cedears (Vercel → VPS de Boston, token del lado servidor).
// Overrides por máquina vía localStorage.cohenFeedUrl:
//   - una URL (p. ej. "http://127.0.0.1:8125") → feed local (dev);
//   - "off" → deshabilita Cohen (la app usa IOL directo).
// Si Cohen devuelve vacío o falla, el caller cae a IOL (nunca a data912).
export function cohenFeedBase(): string | null {
  let v: string | null = null;
  try {
    v = typeof localStorage !== 'undefined' ? localStorage.getItem('cohenFeedUrl') : null;
  } catch {
    /* localStorage inaccesible (SSR/privacidad): usar el default */
  }
  if (v === 'off') return null;
  return v || '/api/cohen';
}
export const cohenCedearsUrl = (s: Settlement): string | null => {
  const base = cohenFeedBase();
  return base ? `${base.replace(/\/+$/, '')}/cedears?plazo=${IOL_PLAZO[s]}` : null;
};

// Histórico diario (OHLC) de un símbolo vía Cohen (get_trade_history de
// Primary/XOMS, ver docs/api-cohen.md). Mismo contrato de respuesta que
// /api/iol/historico (HistoricoPoint[]) — el caller (Ficha) cae a IOL si
// Cohen falla o devuelve vacío. `dias` reemplaza al par desde/hasta que usa
// IOL; el mapeo ChartRango -> días vive en el caller.
export const cohenHistoricoUrl = (symbol: string, s: Settlement, dias: number): string | null => {
  const base = cohenFeedBase();
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/historico?symbol=${encodeURIComponent(symbol)}&plazo=${IOL_PLAZO[s]}&dias=${dias}`;
};

// ── Matriz de pestañas de arbitraje (moneda × plazo) ────────────────────────
export interface ArbTab {
  id: string;
  label: string;
  short: string;
  dollarType: DollarType;
  settlement: Settlement;
}

export const ARB_TABS: ArbTab[] = [
  { id: 'mep-ci', label: 'Dólar MEP · Contado Inmediato (T+0)', short: 'MEP CI',  dollarType: 'MEP', settlement: 'CI'  },
  { id: 'mep-24', label: 'Dólar MEP · 24 horas (T+1)',          short: 'MEP 24h', dollarType: 'MEP', settlement: 'H24' },
  { id: 'ccl-ci', label: 'CCL · Contado Inmediato (T+0)',       short: 'CCL CI',  dollarType: 'CCL', settlement: 'CI'  },
  { id: 'ccl-24', label: 'CCL · 24 horas (T+1)',                short: 'CCL 24h', dollarType: 'CCL', settlement: 'H24' },
];

/**
 * Estima el Contado Inmediato (T+0) a partir de un valor del libro de 24hs.
 * Función pura — documenta el modelo de estimación.
 *   side 'venta':  value * (1 + ciAdjustPct/100)
 *   side 'compra': value * (1 - ciAdjustPct/100)
 */
export function estimateCi(value: number, ciAdjustPct: number, side: 'compra' | 'venta'): number {
  const factor = side === 'venta' ? 1 + ciAdjustPct / 100 : 1 - ciAdjustPct / 100;
  return value * factor;
}

// Etiqueta legible del plazo de liquidación.
export function settlementLabel(s: Settlement): string {
  return s === 'CI' ? 'Contado Inmediato (T+0)' : '24 horas (T+1)';
}

// ── Clasificación de bonos y letras por tipo ────────────────────────────────
// data912 no trae campo de categoría en /live/arg_bonds ni /live/arg_notes:
// se clasifica por patrón de ticker (convención BYMA). Reglas ordenadas — la
// primera que matchea gana; lo no reconocido cae en 'Otros' (nunca se oculta
// una fila por no poder clasificarla).
const BOND_TYPE_RULES: { label: string; re: RegExp }[] = [
  { label: 'Bonares',        re: /^(AL|AE|AN|AO)\d/ },
  { label: 'Globales',       re: /^(GD|GE)\d/ },
  { label: 'CER',            re: /^(TX|TZX|DICP|DIP|PARP|PAP|PAY|CUAP|PR1)/ },
  { label: 'Tasa Fija',      re: /^(T\d|TO\d|TY\d)/ },
  { label: 'Duales / TAMAR', re: /^(TT|TM)[A-Z0-9]/ },
  { label: 'Dólar Linked',   re: /^TZV/ },
  { label: 'Bopreales',      re: /^BP/ },
  { label: 'Cupones PBI',    re: /^TVP/ },
  { label: 'Provinciales',   re: /^(BA|BB|BC|BDC|CO|EM|ER|ND|PBA|PM|PU|SF|SA|S24)/ },
];

const NOTE_TYPE_RULES: { label: string; re: RegExp }[] = [
  { label: 'Lecaps (Tasa Fija)', re: /^S/ },
  { label: 'Leceres (CER)',      re: /^X/ },
  { label: 'Dólar Linked',       re: /^D/ },
];

const OTHER_TYPE = 'Otros';

function classify(rules: { label: string; re: RegExp }[], symbol: string): string {
  for (const r of rules) if (r.re.test(symbol)) return r.label;
  return OTHER_TYPE;
}

export const bondType = (symbol: string): string => classify(BOND_TYPE_RULES, symbol);
export const noteType = (symbol: string): string => classify(NOTE_TYPE_RULES, symbol);

// Orden de presentación de los grupos en la UI.
export const BOND_TYPE_ORDER: string[] = [...BOND_TYPE_RULES.map((r) => r.label), OTHER_TYPE];
export const NOTE_TYPE_ORDER: string[] = [...NOTE_TYPE_RULES.map((r) => r.label), OTHER_TYPE];

// Histórico diario de bonos (para variación semanal/anual). Sólo cubre los
// tickers principales (bonares/globales/CER viejos); donde no hay, la UI
// muestra "—".
export const bondHistoryUrl = (symbol: string): string =>
  `/api/data912/historical/bonds/${symbol}`;

// Quita las variantes en USD (sufijo C/D) cuando el ticker base en pesos
// también está en el feed (AL30C/AL30D → queda AL30). Los tickers que
// terminan en C/D sin base presente (p. ej. BA37D) son emisiones propias y
// quedan. Evita que un mismo activo ocupe 3 lugares en un resumen.
export function dropUsdVariants(rows: any[]): any[] {
  const symbols = new Set(rows.map((r) => String(r?.symbol ?? '')));
  return rows.filter((r) => {
    const s = String(r?.symbol ?? '');
    return !(/[CD]$/.test(s) && symbols.has(s.slice(0, -1)));
  });
}

// ── Índices internacionales y ETFs (fuente: Yahoo Finance vía /api/yahoo) ───
// IOL NO expone índices internacionales ni ETFs (auditado 2026-07-08: los
// paneles 'indices' y 'eTFs' devuelven 0 títulos para todos los países, y la
// cotización por símbolo trae datos viejos — p. ej. NDX=1.384). Por eso estos
// dos casilleros usan Yahoo Finance (endpoint spark, multi-símbolo, sin auth),
// proxyado igual que data912/dolarapi. Máx ~20 símbolos por request.
export interface QuoteSpec {
  code: string;    // símbolo Yahoo
  label: string;   // nombre legible que se muestra en la tabla
  region?: string; // agrupador del casillero Índices
}

export const REGION_ORDER = ['EEUU', 'Europa', 'Asia'];

// Rusia (RTSI/MOEX) no está: Yahoo no publica datos de Moscú desde 2022.
export const INDEX_SPECS: QuoteSpec[] = [
  { code: '^DJI',      label: 'Dow Jones',       region: 'EEUU' },
  { code: '^GSPC',     label: 'S&P 500',         region: 'EEUU' },
  { code: '^NDX',      label: 'Nasdaq 100',      region: 'EEUU' },
  { code: '^FTSE',     label: 'FTSE 100',        region: 'Europa' },
  { code: '^FCHI',     label: 'CAC 40',          region: 'Europa' },
  { code: '^AEX',      label: 'AEX',             region: 'Europa' },
  { code: '^GDAXI',    label: 'DAX',             region: 'Europa' },
  { code: '^IBEX',     label: 'IBEX 35',         region: 'Europa' },
  { code: '^STOXX50E', label: 'Euro Stoxx 50',   region: 'Europa' },
  { code: '^SSMI',     label: 'SMI',             region: 'Europa' },
  { code: 'PSI20.LS',  label: 'PSI (Lisboa)',    region: 'Europa' },
  { code: '^N225',     label: 'Nikkei 225',      region: 'Asia' },
  { code: '^HSI',      label: 'Hang Seng',       region: 'Asia' },
  { code: '000001.SS', label: 'Shanghai Comp.',  region: 'Asia' },
  { code: '^KS11',     label: 'KOSPI',           region: 'Asia' },
  { code: '^TWII',     label: 'Taiwán (TWII)',   region: 'Asia' },
  { code: '^BSESN',    label: 'Sensex (India)',  region: 'Asia' },
];

export const ETF_SPECS: QuoteSpec[] = [
  { code: 'SPY',  label: 'SPY — S&P 500' },
  { code: 'QQQ',  label: 'QQQ — Nasdaq 100' },
  { code: 'DIA',  label: 'DIA — Dow Jones' },
  { code: 'IWM',  label: 'IWM — Russell 2000' },
  { code: 'VTI',  label: 'VTI — Total Market' },
  { code: 'EEM',  label: 'EEM — Emergentes' },
  { code: 'EFA',  label: 'EFA — Desarrollados' },
  { code: 'GLD',  label: 'GLD — Oro' },
  { code: 'TLT',  label: 'TLT — Tesoro 20+ años' },
  { code: 'XLF',  label: 'XLF — Financiero' },
  { code: 'XLE',  label: 'XLE — Energía' },
  { code: 'ARKK', label: 'ARKK — Innovación' },
];

// Los símbolos van encodeados de a uno (encodear las comas rompe el parser
// de Yahoo).
export const yahooSparkUrl = (codes: string[], range: string, interval: string): string =>
  `/api/yahoo/v8/finance/spark?symbols=${codes.map(encodeURIComponent).join(',')}&range=${range}&interval=${interval}`;

// ── Composición del panel de acciones ARG "Líder" ───────────────────────────
// data912 (`/api/data912/live/arg_stocks`) devuelve TODAS las acciones ARG en
// un solo listado plano, sin campo de categoría/panel — no hay forma de
// derivar "Panel Líder" desde el feed. Esta lista replica la categorización
// real y pública de bostonam.com/cotizaciones/panel-lider (relevado
// 2026-07-06): son los ~21 blue-chips que el mercado/la exchange define como
// panel líder, no un recorte arbitrario. Panel General se arma en el cliente
// como TODO lo que no está en esta lista (ver cotizaciones.component.ts) —
// así cualquier ticker nuevo o no listado aquí no desaparece de la app.
export const PANEL_LIDER: string[] = [
  'ALUA', 'BBAR', 'BMA', 'BYMA', 'CEPU', 'COME', 'CRES', 'EDN', 'GGAL',
  'IRSA', 'LOMA', 'MIRG', 'PAMP', 'SUPV', 'TECO2', 'TGNO4', 'TGSU2',
  'TRAN', 'TXAR', 'VALO', 'YPFD',
];

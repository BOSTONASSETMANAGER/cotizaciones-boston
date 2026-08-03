/**
 * operar.types.ts — Tipos propios de la pantalla Operar (Home de esta etapa;
 * Panel/Ficha/Ticket quedan como placeholder para etapas siguientes).
 */
import type { CedearRow } from './market.config';

// Fila del panel de IOL vía api/iol/panel.js — misma forma que CedearRow, más
// `desc` opcional (el proxy la suma sólo para bonos/ONs, ver docs/api-iol.md §3.1).
export interface PanelRow extends CedearRow {
  desc?: string;
}

// Subvistas de Operar. 'cartera' es la simulación de compra + tenencias +
// movimientos (ver operar-storage.ts) — vive dentro de esta misma pestaña,
// nunca como tab nueva del shell (pedido explícito de Elio).
export type OperarSubview = 'home' | 'panel' | 'ficha' | 'ticket' | 'cartera';

// Ids de instrumento de las pills del Home. Mismos ids que /api/iol/panel?id=…
// salvo 'cedears': ese panel no soporta el instrumento CEDEARs (no está en el
// mapeo de api/iol/panel.js), así que se sirve desde /api/iol/cedears.
export type InstrumentId = 'acciones' | 'cedears' | 'bonos' | 'letras' | 'ons';

export interface InstrumentPill {
  id: InstrumentId;
  label: string;
  initials: string; // círculo con 2 letras, tokens neutros — sin ícono a color
}

export const INSTRUMENT_PILLS: InstrumentPill[] = [
  { id: 'acciones', label: 'Acciones', initials: 'AC' },
  { id: 'cedears', label: 'Cedears', initials: 'CE' },
  { id: 'bonos', label: 'Bonos', initials: 'BO' },
  { id: 'letras', label: 'Letras', initials: 'LE' },
  { id: 'ons', label: 'ONs', initials: 'ON' },
];

// Tira de dólares del Home — hardcodeada en esta etapa.
// TODO: wire a /Cotizaciones/MEP cuando haya proxy.
export interface DolarStripRow {
  label: string;
  value: number;
}

// "Destacados": movers reales calculados en cliente sobre acciones+cedears
// ya cacheados (sin fetch extra).
export interface MoverRow {
  symbol: string;
  price: number;
  pctChange: number;
}

// Fila de FCI (fondo común de inversión) real vía api/iol/fondos.js →
// /api/v2/Titulos/FCI (docs/api-iol.md §2.7). Reemplaza al antiguo FondoCard
// hardcodeado. Forma propia (no CedearRow/PanelRow): un FCI no tiene libro
// de puntas, su "precio" es el valor cuota y su variación relevante es la
// anual, no una variación diaria de mercado abierto — ver mapRow en el
// proxy para el mapeo completo de campos reales (la doc no documentaba la
// forma de la respuesta).
export interface FondoRow {
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

// Label legible por tipoFondo (enum real de IOL, ver FondoRow) — usado como
// "categoría" de la card en vez de la categoría hardcodeada anterior.
// Cualquier tipoFondo no mapeado cae al fallback (ver operar.component.ts).
export const FONDO_TIPO_LABEL: Record<string, string> = {
  renta_fija_pesos: 'Renta Fija Pesos',
  renta_fija_dolares: 'Renta Fija Dólares',
  renta_variable_pesos: 'Renta Variable',
  renta_mixta_pesos: 'Renta Mixta',
  plazo_fijo_pesos: 'Money Market Pesos',
  plazo_fijo_dolares: 'Money Market Dólares',
};

// Pills de moneda del Panel. Sólo AR$ trae datos reales en todos los
// instrumentos; US$ sólo tiene fuente real para Acciones (mapea a
// /api/iol/panel?id=usa, ver docs/api-iol.md §3.1); US$C queda deshabilitado
// hasta que haya un panel real de esa moneda.
export type CurrencyPillId = 'ars' | 'usd' | 'usdc';

export interface CurrencyPill {
  id: CurrencyPillId;
  label: string;
}

export const CURRENCY_PILLS: CurrencyPill[] = [
  { id: 'ars', label: 'AR$' },
  { id: 'usd', label: 'US$' },
  { id: 'usdc', label: 'US$C' },
];

// Sub-tab de Panel por instrumento (Acciones: líder/general; Bonos: soberanos
// US$/AR$). Heurística simple por ahora — ver operar.component.ts.
export interface PanelSubTabDef {
  id: string;
  label: string;
}

// Orden de la tabla de Panel.
export type PanelSortColumn = 'symbol' | 'price' | 'pct';

export interface PanelSortState {
  column: PanelSortColumn;
  dir: 'asc' | 'desc';
}

// Rango del gráfico de Ficha — ver api/iol/historico.js.
export type ChartRango = '1S' | '1M' | '6M' | '1A' | 'MAX';

export interface ChartRangoDef {
  id: ChartRango;
  label: string;
}

export const CHART_RANGOS: ChartRangoDef[] = [
  { id: '1S', label: '1S' },
  { id: '1M', label: '1M' },
  { id: '6M', label: '6M' },
  { id: '1A', label: '1A' },
  { id: 'MAX', label: 'MÁX' },
];

// Punto de serie histórica crudo tal cual lo devuelve IOL (api/iol/historico.js
// no remapea). OJO: los nombres reales NO coinciden con los de docs/api-iol.md
// §2.4 — auditado contra la respuesta real 2026-07-14. No hay campo "cierre":
// para series diarias, `ultimoPrecio` de cada día ES el cierre de esa rueda.
export interface HistoricoPoint {
  fechaHora: string;
  apertura: number;
  maximo: number;
  minimo: number;
  ultimoPrecio: number;
  volumenNominal: number;
}

// ── Ticket de compra ─────────────────────────────────────────────────────
// 100% UI — sin request a ningún endpoint de operatoria (IOL todavía no
// habilita esa API para la cuenta, ver docs/api-iol.md §4). Elio pidió que
// este apartado quede hardcodeado hasta que se habilite.

// Paso interno de la subvista Ticket.
export type TicketStep = 'form' | 'confirmar';

export type TicketTipoPrecio = 'mercado' | 'limite';

export interface TicketTipoPrecioDef {
  id: TicketTipoPrecio;
  label: string;
}

export const TICKET_TIPO_PRECIO: TicketTipoPrecioDef[] = [
  { id: 'mercado', label: 'Mercado' },
  { id: 'limite', label: 'Límite' },
];

export type TicketPlazo = 't0' | 't1' | 't2' | 't3';

export interface TicketPlazoDef {
  id: TicketPlazo;
  label: string;
}

export const TICKET_PLAZOS: TicketPlazoDef[] = [
  { id: 't0', label: 'T0' },
  { id: 't1', label: '24hs' },
  { id: 't2', label: '48hs' },
  { id: 't3', label: '72hs' },
];

// Estado completo del formulario de Ticket (Paso 1), llevado al resumen del
// Paso 2 sin perderse al volver ("conserva los valores cargados").
export interface TicketState {
  tipoPrecio: TicketTipoPrecio;
  precioLimite: number | null;
  plazo: TicketPlazo;
  cantidad: number;
  monto: number | null;
}

// ── Cartera simulada ─────────────────────────────────────────────────────
// Al confirmar en el Ticket (que sigue sin mandar nada a IOL, ver arriba) se
// registra ADEMÁS un SimulatedMovement en localStorage (operar-storage.ts)
// para poder mostrar cómo se vería el producto terminado. Cartera/Movimientos
// son subvistas de Operar, no tabs nuevas — ver OperarSubview.

// Mismo dominio que InstrumentId (pills del Home): categoriza el instrumento
// de un movimiento simulado.
export type OperarInstrumento = InstrumentId;

// Label corto del instrumento para el chip de identidad de Tenencias/
// Movimientos — extiende INSTRUMENT_PILLS (Home) con singulares para uso
// inline junto al symbol. Tokens neutros (ver .op-instr-chip): un chip de
// identidad no usa color con significado.
export const INSTRUMENTO_CHIP_LABEL: Record<OperarInstrumento, string> = {
  acciones: 'Acción',
  cedears: 'Cedear',
  bonos: 'Bono',
  letras: 'Letra',
  ons: 'ON',
};

// Compra o venta — dirección de un movimiento simulado y del Ticket que lo
// genera (ver TicketState / operar.component.ts).
export type TicketTipoOperacion = 'compra' | 'venta';

// Fila agregada de Tenencias (Cartera): posición NETA de un symbol (compras -
// ventas). `cantidad` es la cantidad neta; `precioPromedio` es el costo
// promedio ponderado de TODAS las compras históricas (no se recalcula al
// vender, método estándar de costo promedio). Si la cantidad neta llega a 0
// el symbol desaparece de Tenencias (sigue en Movimientos). `estimado` cuando
// no hay precio real cacheado de ningún panel y se usa el costo promedio
// como fallback (ver operar.component.ts).
export interface TenenciaRow {
  symbol: string;
  instrumento: OperarInstrumento;
  cantidad: number;
  precioPromedio: number;
  valorActual: number;
  pnl: number;
  estimado: boolean;
}

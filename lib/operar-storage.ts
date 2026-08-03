/**
 * operar-storage.ts — Persistencia de la cartera simulada del Ticket (ver
 * operar.types.ts §Cartera simulada). Mismo patrón que market-hours.config.ts:
 * helpers de localStorage con fallback silencioso si no está disponible.
 *
 * Elio pidió una simulación completa (compra + cartera + movimientos) en
 * paralelo al banner de "operatoria no habilitada" del Ticket, para poder
 * mostrar cómo se vería el producto terminado — no manda nada a IOL.
 */
import type { InstrumentId, OperarInstrumento, TicketPlazo } from './operar.types';

export interface SimulatedMovement {
  id: string;
  timestamp: number;
  symbol: string;
  instrumento: OperarInstrumento;
  tipo: 'compra' | 'venta';
  cantidad: number;
  precio: number; // el efectivo usado (mercado o límite), ver precioEfectivo() en Operar.tsx
  monto: number;
  plazo: TicketPlazo;
  fechaLiquidacionEstimada: string; // YYYY-MM-DD, ver estimarFechaLiquidacion()
  estado: 'simulada_pendiente' | 'simulada_liquidada';
}

export const SIMULATED_MOVEMENTS_STORAGE_KEY = 'boston-simulated-movements';

// Guard de SSR (§6 del contrato de migración): en el server no existe
// `window`/`localStorage`. Los try/catch de cada helper ya lo cubrían por
// accidente (ReferenceError atrapado), pero el guard explícito deja el
// contrato claro: en server se devuelve el default/vacío y NUNCA se toca el
// DOM. La lectura real del estado persistido la hace el componente en un
// useEffect de montaje, no en el inicializador del signal (si no, el HTML del
// server y el primer render del cliente no coinciden → hydration mismatch).
function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

// Días hábiles a sumar por plazo. t0 = liquidación el mismo día.
const PLAZO_BUSINESS_DAYS: Record<TicketPlazo, number> = { t0: 0, t1: 1, t2: 2, t3: 3 };

function toDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Suma días hábiles saltando sáb/dom — heurística simple, sin calendario de
// feriados (misma limitación conocida que market-hours.config.ts).
function addBusinessDays(from: Date, days: number): Date {
  const result = new Date(from);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return result;
}

function estimarFechaLiquidacion(plazo: TicketPlazo, from: Date = new Date()): string {
  return toDateOnly(addBusinessDays(from, PLAZO_BUSINESS_DAYS[plazo]));
}

// Recalculada contra "hoy" en cada lectura en vez de congelarse al momento de
// la compra — así un movimiento t1 pasa solo de pendiente a liquidada al
// recargar la app al día siguiente, sin necesidad de un cron.
function estadoParaFecha(fechaLiquidacionEstimada: string): SimulatedMovement['estado'] {
  return toDateOnly(new Date()) < fechaLiquidacionEstimada ? 'simulada_pendiente' : 'simulada_liquidada';
}

function genId(): string {
  return `sim-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export interface AddMovementInput {
  symbol: string;
  instrumento: OperarInstrumento;
  tipo: 'compra' | 'venta';
  cantidad: number;
  precio: number;
  monto: number;
  plazo: TicketPlazo;
}

/** Movimientos simulados persistidos, con `estado` refrescado contra la fecha actual. */
export function loadMovements(): SimulatedMovement[] {
  if (!hasWindow()) return [];
  try {
    const raw = localStorage.getItem(SIMULATED_MOVEMENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((m: SimulatedMovement) => ({ ...m, estado: estadoParaFecha(m.fechaLiquidacionEstimada) }));
  } catch {
    /* localStorage inaccesible (SSR/privacidad) o JSON corrupto: cartera vacía */
    return [];
  }
}

function saveMovements(movements: SimulatedMovement[]): void {
  if (!hasWindow()) return;
  try {
    localStorage.setItem(SIMULATED_MOVEMENTS_STORAGE_KEY, JSON.stringify(movements));
  } catch {
    /* localStorage inaccesible: no persiste entre sesiones, pero no rompe la app */
  }
}

export function addMovement(input: AddMovementInput): SimulatedMovement {
  const fechaLiquidacionEstimada = estimarFechaLiquidacion(input.plazo);
  const movement: SimulatedMovement = {
    id: genId(),
    timestamp: Date.now(),
    ...input,
    fechaLiquidacionEstimada,
    estado: estadoParaFecha(fechaLiquidacionEstimada),
  };
  const movements = loadMovements();
  movements.push(movement);
  saveMovements(movements);
  return movement;
}

// ── Dropdowns de instrumento por columna (panel de Acciones, Home) ──────────
// Pedido de Elio: cada columna del panel de Acciones eligo su propio tipo de
// instrumento (antes un solo toggle global para las 2 columnas). Mismo patrón
// que market-hours.config.ts: helpers de localStorage con fallback silencioso
// si no está disponible (SSR/privacidad) o si el valor guardado no es un
// InstrumentId válido.
const HOME_COL_LEFT_STORAGE_KEY = 'boston-home-col-left';
const HOME_COL_RIGHT_STORAGE_KEY = 'boston-home-col-right';

const VALID_INSTRUMENT_IDS: InstrumentId[] = ['acciones', 'cedears', 'bonos', 'letras', 'ons'];

function isValidInstrumentId(v: unknown): v is InstrumentId {
  return typeof v === 'string' && VALID_INSTRUMENT_IDS.includes(v as InstrumentId);
}

/** Instrumento guardado para la columna izquierda, o `null` si no hay/es inválido. */
export function loadHomeColLeft(): InstrumentId | null {
  if (!hasWindow()) return null;
  try {
    const raw = localStorage.getItem(HOME_COL_LEFT_STORAGE_KEY);
    return isValidInstrumentId(raw) ? raw : null;
  } catch {
    /* localStorage inaccesible (SSR/privacidad): usar el default */
    return null;
  }
}

/** Instrumento guardado para la columna derecha, o `null` si no hay/es inválido. */
export function loadHomeColRight(): InstrumentId | null {
  if (!hasWindow()) return null;
  try {
    const raw = localStorage.getItem(HOME_COL_RIGHT_STORAGE_KEY);
    return isValidInstrumentId(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function saveHomeColLeft(id: InstrumentId): void {
  if (!hasWindow()) return;
  try {
    localStorage.setItem(HOME_COL_LEFT_STORAGE_KEY, id);
  } catch {
    /* localStorage inaccesible: no persiste entre sesiones, pero no rompe la app */
  }
}

export function saveHomeColRight(id: InstrumentId): void {
  if (!hasWindow()) return;
  try {
    localStorage.setItem(HOME_COL_RIGHT_STORAGE_KEY, id);
  } catch {
    /* localStorage inaccesible: no persiste entre sesiones, pero no rompe la app */
  }
}

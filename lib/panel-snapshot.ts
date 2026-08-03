/**
 * panel-snapshot.ts — "Último Estado Válido Conocido" del libro de CEDEARs.
 *
 * Cadena de fallback de fetchCedears() (app.ts): Cohen → IOL → snapshot → [].
 * Cada vez que Cohen o IOL entregan filas no vacías, se persiste ese arreglo
 * en localStorage junto a un timestamp. Si AMBAS fuentes fallan o devuelven
 * vacío (feed caído, auth pendiente, sin conexión), se sirve el último
 * snapshot guardado en lugar de dejar el panel sin datos — son datos reales
 * capturados antes, no una simulación.
 *
 * Clave por plazo (CI/H24) para no mezclar libros de distinto settlement.
 * Mismo patrón que market-hours.config.ts / operar-storage.ts: helpers de
 * localStorage con fallback silencioso (try/catch) si no está disponible
 * (SSR, modo privado, storage lleno, etc.) — nunca rompe la app.
 */
import type { CedearRow, Settlement } from './market.config';

const STORAGE_KEY_PREFIX = 'PANEL_LAST_KNOWN_SNAPSHOT';

interface PanelSnapshot {
  rows: CedearRow[];
  timestamp: number;
}

function storageKey(s: Settlement): string {
  return `${STORAGE_KEY_PREFIX}_${s}`;
}

/** Guarda `rows` como último estado válido conocido del plazo `s`. No-op si viene vacío. */
export function saveSnapshot(s: Settlement, rows: CedearRow[]): void {
  if (!rows.length) return;
  // SSR (prerender de Next): no hay localStorage — no-op silencioso.
  if (typeof window === 'undefined') return;
  try {
    const snapshot: PanelSnapshot = { rows, timestamp: Date.now() };
    localStorage.setItem(storageKey(s), JSON.stringify(snapshot));
  } catch {
    /* localStorage inaccesible o lleno: no persiste, no rompe la app */
  }
}

/** Último snapshot guardado del plazo `s`, o `null` si no hay/está corrupto/vacío. */
export function loadSnapshot(s: Settlement): CedearRow[] | null {
  // SSR (prerender de Next): no hay localStorage — sin snapshot.
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey(s));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PanelSnapshot;
    if (!parsed || !Array.isArray(parsed.rows) || !parsed.rows.length) return null;
    return parsed.rows;
  } catch {
    /* localStorage inaccesible o JSON corrupto: sin snapshot */
    return null;
  }
}

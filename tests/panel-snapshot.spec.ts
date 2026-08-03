import { beforeEach, describe, expect, it } from 'vitest';
import type { CedearRow } from '@/lib/market.config';
import { loadSnapshot, saveSnapshot } from '@/lib/panel-snapshot';

// Clave real que usa el módulo (no se exporta): PANEL_LAST_KNOWN_SNAPSHOT_<CI|H24>.
const KEY_CI = 'PANEL_LAST_KNOWN_SNAPSHOT_CI';
const KEY_H24 = 'PANEL_LAST_KNOWN_SNAPSHOT_H24';

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

describe('panel-snapshot', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trip: lo guardado se recupera igual', () => {
    const rows = [row('AAPL'), row('AAPLD', { px_bid: 6.6, px_ask: 6.7 })];
    saveSnapshot('CI', rows);
    expect(loadSnapshot('CI')).toEqual(rows);
  });

  it('sin snapshot guardado devuelve null', () => {
    expect(loadSnapshot('CI')).toBeNull();
    expect(loadSnapshot('H24')).toBeNull();
  });

  it('no guarda un arreglo vacío (no-op, no pisa el snapshot previo)', () => {
    const rows = [row('MSFT')];
    saveSnapshot('H24', rows);
    saveSnapshot('H24', []);
    expect(loadSnapshot('H24')).toEqual(rows);
  });

  it('no crea la clave si nunca se guardó nada no vacío', () => {
    saveSnapshot('CI', []);
    expect(localStorage.getItem(KEY_CI)).toBeNull();
  });

  it('separa los plazos: CI y H24 no se mezclan', () => {
    const ci = [row('NVDA', { px_bid: 100 })];
    const h24 = [row('NVDA', { px_bid: 200 })];

    saveSnapshot('CI', ci);
    saveSnapshot('H24', h24);

    expect(loadSnapshot('CI')).toEqual(ci);
    expect(loadSnapshot('H24')).toEqual(h24);
    expect(localStorage.getItem(KEY_CI)).not.toBeNull();
    expect(localStorage.getItem(KEY_H24)).not.toBeNull();
  });

  it('el snapshot nuevo reemplaza al anterior del mismo plazo', () => {
    saveSnapshot('CI', [row('AAPL', { px_bid: 1000 })]);
    saveSnapshot('CI', [row('AAPL', { px_bid: 1111 })]);
    expect(loadSnapshot('CI')?.[0].px_bid).toBe(1111);
  });

  it('persiste un timestamp junto a las filas', () => {
    const antes = Date.now();
    saveSnapshot('CI', [row('AAPL')]);
    const parsed = JSON.parse(localStorage.getItem(KEY_CI)!);
    expect(parsed.timestamp).toBeGreaterThanOrEqual(antes);
    expect(Array.isArray(parsed.rows)).toBe(true);
  });

  it('JSON corrupto devuelve null en lugar de tirar', () => {
    localStorage.setItem(KEY_CI, '{no es json');
    expect(() => loadSnapshot('CI')).not.toThrow();
    expect(loadSnapshot('CI')).toBeNull();
  });

  it('un snapshot con rows vacío o mal formado devuelve null', () => {
    localStorage.setItem(KEY_CI, JSON.stringify({ rows: [], timestamp: Date.now() }));
    expect(loadSnapshot('CI')).toBeNull();

    localStorage.setItem(KEY_CI, JSON.stringify({ rows: 'nope', timestamp: Date.now() }));
    expect(loadSnapshot('CI')).toBeNull();

    localStorage.setItem(KEY_CI, JSON.stringify(null));
    expect(loadSnapshot('CI')).toBeNull();
  });
});

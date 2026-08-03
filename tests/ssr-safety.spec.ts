// @vitest-environment node
//
// Simula el prerender de Next: entorno Node puro, sin window / document /
// localStorage. Verifica §6 del contrato de migración — ningún módulo de lib/
// debe tirar al importarse ni al llamarse desde el server, y cada uno tiene que
// devolver el camino "no hay window" documentado.
import { describe, expect, it } from 'vitest';
import { MARKET_HOURS, getEffectiveMarketHours, isMarketOpen, isValidTimeRange, loadMarketHoursOverride, saveMarketHoursOverride } from '@/lib/market-hours.config';
import { cohenCedearsUrl, cohenFeedBase, iolCedearsUrl } from '@/lib/market.config';
import { loadSnapshot, saveSnapshot } from '@/lib/panel-snapshot';
import { isEmbedded, listenParentTour } from '@/lib/parent-tour.util';
import { buildPairs } from '@/lib/arb-engine';
import { CEDEAR_META } from '@/lib/cedears-meta';
import { signal } from '@/lib/signal';

it('el entorno del test no tiene window ni document', () => {
  expect(typeof window).toBe('undefined');
  expect(typeof document).toBe('undefined');
});

describe('market-hours.config en server', () => {
  it('no hay override y los efectivos son el default del config', () => {
    expect(loadMarketHoursOverride()).toBeNull();
    expect(getEffectiveMarketHours()).toEqual({
      open: MARKET_HOURS.open,
      close: MARKET_HOURS.close,
    });
  });

  it('saveMarketHoursOverride no tira y mantiene su valor de retorno', () => {
    expect(() => saveMarketHoursOverride('11:00', '16:00')).not.toThrow();
    expect(saveMarketHoursOverride('11:00', '16:00')).toBe(true);
    expect(saveMarketHoursOverride('17:00', '10:00')).toBe(false);
  });

  it('isValidTimeRange e isMarketOpen son puros (Intl existe en Node)', () => {
    expect(isValidTimeRange('10:30', '17:00')).toBe(true);
    expect(() => isMarketOpen()).not.toThrow();
    expect(typeof isMarketOpen()).toBe('boolean');
    expect(isMarketOpen({ ...MARKET_HOURS, enabled: false })).toBe(true);
  });
});

describe('market.config en server', () => {
  it('cohenFeedBase cae al proxy same-origin sin tocar localStorage', () => {
    expect(cohenFeedBase()).toBe('/api/cohen');
    expect(cohenCedearsUrl('CI')).toBe('/api/cohen/cedears?plazo=t0');
    expect(cohenCedearsUrl('H24')).toBe('/api/cohen/cedears?plazo=t1');
  });

  it('las URLs de IOL son puras', () => {
    expect(iolCedearsUrl('CI')).toBe('/api/iol/cedears?plazo=t0');
    expect(iolCedearsUrl('H24')).toBe('/api/iol/cedears?plazo=t1');
  });
});

describe('panel-snapshot en server', () => {
  it('saveSnapshot es no-op y loadSnapshot devuelve null', () => {
    expect(() =>
      saveSnapshot('CI', [
        { symbol: 'AAPL', q_bid: 1, px_bid: 1, px_ask: 2, q_ask: 1, v: 0, q_op: 0, c: 0, pct_change: 0 },
      ]),
    ).not.toThrow();
    expect(loadSnapshot('CI')).toBeNull();
  });
});

describe('parent-tour.util en server', () => {
  it('isEmbedded devuelve false (mismo valor que el acceso directo)', () => {
    expect(isEmbedded()).toBe(false);
  });

  it('listenParentTour es no-op y devuelve una baja invocable', () => {
    const baja = listenParentTour(
      () => 'arbitraje',
      () => {},
    );
    expect(typeof baja).toBe('function');
    expect(() => baja()).not.toThrow();
  });
});

describe('tour.util en server', () => {
  it('runTour es no-op sin document y no importa driver.js', async () => {
    // Import diferido: si el módulo tocara `document` al evaluarse, esto tiraría.
    const { runTour } = await import('@/lib/tour.util');
    await expect(runTour([], 'tour-test', { force: true })).resolves.toBeUndefined();
  });
});

describe('lógica pura en server', () => {
  it('el motor de arbitraje y el dataset de metadata funcionan igual', () => {
    const rows = [
      { symbol: 'AAPL', q_bid: 100, px_bid: 1000, px_ask: 1010, q_ask: 100, v: 0, q_op: 0, c: 0, pct_change: 0 },
      { symbol: 'AAPLD', q_bid: 100, px_bid: 0.7, px_ask: 0.71, q_ask: 100, v: 0, q_op: 0, c: 0, pct_change: 0 },
    ];
    const pairs = buildPairs(rows, { suffix: 'D', settlement: 'H24', ciAdjustPct: 0 });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].base).toBe('AAPL');
    expect(CEDEAR_META['AAPL'].sector).toBe('Tecnología');
  });

  it('el store de signals funciona fuera del browser', () => {
    const s = signal(1);
    let notificado = 0;
    s.subscribe(() => notificado++);
    s.set(2);
    s.set(2);
    expect(s()).toBe(2);
    expect(notificado).toBe(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computed, signal, useComputed, useSignal } from '@/lib/signal';

describe('signal()', () => {
  it('devuelve el valor inicial al invocarlo', () => {
    const paused = signal(false);
    const commissionPct = signal(2);
    const cedearsT0 = signal<number[]>([]);

    expect(paused()).toBe(false);
    expect(commissionPct()).toBe(2);
    expect(cedearsT0()).toEqual([]);
  });

  it('set() reemplaza el valor', () => {
    const activeArbTab = signal('mep-ci');
    activeArbTab.set('ccl-24');
    expect(activeArbTab()).toBe('ccl-24');
  });

  it('update() deriva del valor previo', () => {
    const ticks = signal(0);
    ticks.update((n) => n + 1);
    ticks.update((n) => n + 1);
    expect(ticks()).toBe(2);
  });

  it('update() recibe el valor actual, no el inicial', () => {
    const rows = signal<string[]>(['AAPL']);
    rows.update((prev) => [...prev, 'MSFT']);
    const seen: string[][] = [];
    rows.update((prev) => {
      seen.push(prev);
      return prev;
    });
    expect(seen[0]).toEqual(['AAPL', 'MSFT']);
  });

  it('notifica a los suscriptores en cada cambio', () => {
    const iolSource = signal({ t0: false, t1: false });
    const cb = vi.fn();
    iolSource.subscribe(cb);

    iolSource.set({ t0: true, t1: false });
    iolSource.set({ t0: true, t1: true });

    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('NO notifica si el valor es idéntico por Object.is (set)', () => {
    const paused = signal(false);
    const cb = vi.fn();
    paused.subscribe(cb);

    paused.set(false);
    paused.set(false);
    expect(cb).not.toHaveBeenCalled();

    paused.set(true);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('NO notifica si update() devuelve la misma referencia', () => {
    const rows = signal<string[]>(['AAPL']);
    const cb = vi.fn();
    rows.subscribe(cb);

    rows.update((prev) => prev); // misma referencia: no hay cambio real
    expect(cb).not.toHaveBeenCalled();

    rows.update((prev) => [...prev]); // referencia nueva: sí notifica
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('trata NaN como valor idéntico (semántica de Object.is)', () => {
    const netPct = signal(Number.NaN);
    const cb = vi.fn();
    netPct.subscribe(cb);
    netPct.set(Number.NaN);
    expect(cb).not.toHaveBeenCalled();
  });

  it('notifica a todos los suscriptores registrados', () => {
    const s = signal(0);
    const a = vi.fn();
    const b = vi.fn();
    s.subscribe(a);
    s.subscribe(b);
    s.set(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('la función de baja corta las notificaciones', () => {
    const s = signal(0);
    const cb = vi.fn();
    const baja = s.subscribe(cb);

    s.set(1);
    expect(cb).toHaveBeenCalledTimes(1);

    baja();
    s.set(2);
    s.set(3);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(s()).toBe(3); // el valor sigue actualizándose aunque nadie escuche
  });

  it('un suscriptor que se da de baja a sí mismo no rompe el recorrido', () => {
    const s = signal(0);
    const segundo = vi.fn();
    const baja = s.subscribe(() => baja());
    s.subscribe(segundo);
    expect(() => s.set(1)).not.toThrow();
    expect(segundo).toHaveBeenCalledTimes(1);
  });

  it('cada signal es independiente (estado en su propia closure)', () => {
    const a = signal(1);
    const b = signal(1);
    const cbA = vi.fn();
    a.subscribe(cbA);
    b.set(99);
    expect(a()).toBe(1);
    expect(cbA).not.toHaveBeenCalled();
  });
});

describe('computed()', () => {
  it('re-evalúa en cada lectura', () => {
    const dolarVenta = signal(1500);
    const dolarCompra = signal(1450);
    const spread = computed(() => dolarVenta() - dolarCompra());

    expect(spread()).toBe(50);

    dolarVenta.set(1600);
    expect(spread()).toBe(150);

    dolarCompra.set(1400);
    expect(spread()).toBe(200);
  });

  it('no cachea: llama a fn una vez por lectura', () => {
    const s = signal(2);
    const fn = vi.fn(() => s() * 10);
    const doble = computed(fn);

    doble();
    doble();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('se puede componer sobre otro computed', () => {
    const amountArs = signal(1_000_000);
    const commissionPct = signal(2);
    const comision = computed(() => (amountArs() * commissionPct()) / 100);
    const neto = computed(() => amountArs() - comision());

    expect(comision()).toBe(20_000);
    expect(neto()).toBe(980_000);

    commissionPct.set(3);
    expect(neto()).toBe(970_000);
  });
});

// El snapshot de server tiene que dar el MISMO valor que el primer render del
// cliente, si no se rompe la hidratación (§6 del contrato). Renderizamos en el
// server (sin JSX: los tests son .ts) y verificamos que sale el valor del signal.
describe('useSignal() / useComputed() en SSR', () => {
  it('useSignal devuelve el valor del signal durante el prerender', () => {
    const uiMode = signal('basico');
    const Comp = () => createElement('span', null, useSignal(uiMode));

    expect(renderToStaticMarkup(createElement(Comp))).toBe('<span>basico</span>');

    uiMode.set('avanzado');
    expect(renderToStaticMarkup(createElement(Comp))).toBe('<span>avanzado</span>');
  });

  it('useComputed devuelve el derivado de varios signals durante el prerender', () => {
    const arsAsk = signal(1000);
    const usdBid = signal(0.66);
    const Comp = () =>
      createElement('span', null, useComputed(() => arsAsk() * usdBid(), [arsAsk, usdBid]));

    expect(renderToStaticMarkup(createElement(Comp))).toBe('<span>660</span>');

    arsAsk.set(2000);
    expect(renderToStaticMarkup(createElement(Comp))).toBe('<span>1320</span>');
  });
});

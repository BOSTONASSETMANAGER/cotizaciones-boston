import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MARKET_HOURS,
  MARKET_HOURS_STORAGE_KEY,
  getEffectiveMarketHours,
  isMarketOpen,
  isValidTimeRange,
  loadMarketHoursOverride,
  saveMarketHoursOverride,
} from '@/lib/market-hours.config';

/**
 * Miércoles 2026-08-05 16:00 UTC = 13:00 en America/Argentina/Buenos_Aires,
 * dentro del horario default (10:30–17:00). Se congela el reloj para que los
 * tests no dependan de cuándo corren.
 *
 * `isMarketOpen` mezcla dos husos: el día de la semana sale de `getDay()` (hora
 * LOCAL de la máquina) y la hora sale de un Intl.DateTimeFormat con timeZone
 * explícito de Argentina. Para que el test valga en cualquier máquina, los
 * casos de horario fuerzan `workdays` al día local del reloj congelado, y el
 * filtro de días se prueba aparte con una lista que no lo incluye.
 */
const RELOJ_MIERCOLES_13_AR = new Date('2026-08-05T16:00:00Z');
const RELOJ_MIERCOLES_2030_AR = new Date('2026-08-05T23:30:00Z');

function configConDiaLocalHabil() {
  return { ...MARKET_HOURS, workdays: [new Date().getDay()] };
}

describe('isValidTimeRange()', () => {
  it('acepta HH:mm bien formados con apertura antes del cierre', () => {
    expect(isValidTimeRange('10:30', '17:00')).toBe(true);
    expect(isValidTimeRange('00:00', '23:59')).toBe(true);
    expect(isValidTimeRange('09:00', '09:01')).toBe(true);
  });

  it('rechaza apertura igual o posterior al cierre', () => {
    expect(isValidTimeRange('10:30', '10:30')).toBe(false);
    expect(isValidTimeRange('17:00', '10:30')).toBe(false);
  });

  it('rechaza formatos mal formados', () => {
    expect(isValidTimeRange('9:30', '17:00')).toBe(false); // sin cero a la izquierda
    expect(isValidTimeRange('10:30', '24:00')).toBe(false); // hora fuera de rango
    expect(isValidTimeRange('10:60', '17:00')).toBe(false); // minuto fuera de rango
    expect(isValidTimeRange('1030', '1700')).toBe(false); // sin separador
    expect(isValidTimeRange('', '')).toBe(false);
  });
});

describe('override de horario en localStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('sin nada guardado no hay override y los efectivos son el default', () => {
    expect(loadMarketHoursOverride()).toBeNull();
    expect(getEffectiveMarketHours()).toEqual({
      open: MARKET_HOURS.open,
      close: MARKET_HOURS.close,
    });
  });

  it('guarda y recupera un rango válido', () => {
    expect(saveMarketHoursOverride('11:00', '16:30')).toBe(true);
    expect(loadMarketHoursOverride()).toEqual({ open: '11:00', close: '16:30' });
    expect(getEffectiveMarketHours()).toEqual({ open: '11:00', close: '16:30' });
  });

  it('no persiste un rango inválido y devuelve false', () => {
    expect(saveMarketHoursOverride('17:00', '10:30')).toBe(false);
    expect(localStorage.getItem(MARKET_HOURS_STORAGE_KEY)).toBeNull();
    expect(loadMarketHoursOverride()).toBeNull();
  });

  it('ignora un override corrupto y cae al default', () => {
    localStorage.setItem(MARKET_HOURS_STORAGE_KEY, '{no es json');
    expect(loadMarketHoursOverride()).toBeNull();
    expect(getEffectiveMarketHours().open).toBe(MARKET_HOURS.open);
  });

  it('ignora un override con rango inválido ya persistido', () => {
    localStorage.setItem(
      MARKET_HOURS_STORAGE_KEY,
      JSON.stringify({ open: '25:00', close: '99:99' }),
    );
    expect(loadMarketHoursOverride()).toBeNull();
    expect(getEffectiveMarketHours()).toEqual({
      open: MARKET_HOURS.open,
      close: MARKET_HOURS.close,
    });
  });

  it('respeta el config pasado por parámetro cuando no hay override', () => {
    const config = { ...MARKET_HOURS, open: '08:00', close: '12:00' };
    expect(getEffectiveMarketHours(config)).toEqual({ open: '08:00', close: '12:00' });
  });
});

describe('isMarketOpen()', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('con enabled=false está siempre abierto', () => {
    vi.setSystemTime(RELOJ_MIERCOLES_2030_AR);
    expect(isMarketOpen({ ...MARKET_HOURS, enabled: false, workdays: [] })).toBe(true);
  });

  it('abierto dentro del horario default en día hábil', () => {
    vi.setSystemTime(RELOJ_MIERCOLES_13_AR);
    expect(isMarketOpen(configConDiaLocalHabil())).toBe(true);
  });

  it('cerrado después del cierre', () => {
    vi.setSystemTime(RELOJ_MIERCOLES_2030_AR);
    expect(isMarketOpen(configConDiaLocalHabil())).toBe(false);
  });

  it('cerrado si el día no está en workdays', () => {
    vi.setSystemTime(RELOJ_MIERCOLES_13_AR);
    const diaLocal = new Date().getDay();
    const otroDia = (diaLocal + 1) % 7;
    expect(isMarketOpen({ ...MARKET_HOURS, workdays: [otroDia] })).toBe(false);
    expect(isMarketOpen({ ...MARKET_HOURS, workdays: [] })).toBe(false);
  });

  it('el override del usuario pisa el horario del config', () => {
    vi.setSystemTime(RELOJ_MIERCOLES_2030_AR); // 20:30 AR: cerrado con el default
    const config = configConDiaLocalHabil();
    expect(isMarketOpen(config)).toBe(false);

    saveMarketHoursOverride('00:00', '23:59');
    expect(isMarketOpen(config)).toBe(true);
  });

  it('un override más corto puede cerrar un horario que el default deja abierto', () => {
    vi.setSystemTime(RELOJ_MIERCOLES_13_AR); // 13:00 AR: abierto con el default
    const config = configConDiaLocalHabil();
    expect(isMarketOpen(config)).toBe(true);

    saveMarketHoursOverride('10:30', '12:00');
    expect(isMarketOpen(config)).toBe(false);
  });

  it('el borde de apertura es inclusivo y el de cierre exclusivo', () => {
    vi.setSystemTime(RELOJ_MIERCOLES_13_AR);
    const config = configConDiaLocalHabil();

    saveMarketHoursOverride('13:00', '17:00'); // localTime >= open
    expect(isMarketOpen(config)).toBe(true);

    saveMarketHoursOverride('10:30', '13:00'); // localTime < close
    expect(isMarketOpen(config)).toBe(false);
  });
});

// TODO: confirmar horario exacto de rueda BYMA con Elio antes de
// producción (puede variar por feriado o rueda extendida).
//
// Limitación conocida: no hay calendario de feriados en esta etapa.
//
// Horario editable desde la UI (dropdown "Horario" en el toolbar, ver
// app.html/app.ts): el usuario puede pisar open/close sin tocar código,
// persistido en localStorage. MARKET_HOURS sigue siendo el fallback — se
// usa tal cual si no hay override guardado (primera vez o localStorage
// inaccesible).

export interface MarketHoursConfig {
  /** Master switch: if false, market is considered always open. */
  enabled: boolean;
  /** Opening time in HH:mm (Argentina time). */
  open: string;
  /** Closing time in HH:mm (Argentina time). */
  close: string;
  /** IANA timezone identifier for Argentina. */
  timezone: string;
  /**
   * Days of week when the market operates.
   * 1 = Monday, 2 = Tuesday, ..., 5 = Friday.
   */
  workdays: number[];
}

export const MARKET_HOURS: MarketHoursConfig = {
  enabled: true,
  open: '10:30',
  close: '17:00',
  timezone: 'America/Argentina/Buenos_Aires',
  workdays: [1, 2, 3, 4, 5],
};

export const MARKET_HOURS_STORAGE_KEY = 'boston-market-hours';

export interface MarketHoursOverride {
  open: string;
  close: string;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Apertura y cierre bien formados (HH:mm) y apertura estrictamente antes que cierre. */
export function isValidTimeRange(open: string, close: string): boolean {
  return TIME_RE.test(open) && TIME_RE.test(close) && open < close;
}

/** Override guardado por el usuario, o `null` si no hay/está corrupto/localStorage no disponible. */
export function loadMarketHoursOverride(): MarketHoursOverride | null {
  // SSR (prerender de Next): no hay window ni localStorage, así que no hay
  // override — el caller cae al default de MARKET_HOURS. Nunca tira excepción.
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(MARKET_HOURS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && isValidTimeRange(parsed.open, parsed.close)) {
      return { open: parsed.open, close: parsed.close };
    }
  } catch {
    /* localStorage inaccesible (SSR/privacidad) o JSON corrupto: usar default */
  }
  return null;
}

/** Persiste el override sólo si el rango es válido. Devuelve si guardó. */
export function saveMarketHoursOverride(open: string, close: string): boolean {
  if (!isValidTimeRange(open, close)) return false;
  try {
    // SSR: sin window no hay dónde persistir. Se valida igual y se devuelve
    // true (el rango ES válido), idéntico al camino en que localStorage existe
    // pero falla — así el valor de retorno en el cliente no cambia nunca.
    if (typeof window !== 'undefined') {
      localStorage.setItem(MARKET_HOURS_STORAGE_KEY, JSON.stringify({ open, close }));
    }
  } catch {
    /* localStorage inaccesible: no persiste entre sesiones, pero no rompe la app */
  }
  return true;
}

/**
 * open/close efectivos: override del usuario si hay uno válido, si no el default
 * del config. En SSR `loadMarketHoursOverride()` devuelve null, así que acá se
 * sirve siempre el DEFAULT del config — es el valor con el que la UI debe
 * inicializar sus signals para que el primer render del cliente coincida con el
 * HTML del server (ver §6 del contrato de migración).
 */
export function getEffectiveMarketHours(config: MarketHoursConfig = MARKET_HOURS): MarketHoursOverride {
  const override = loadMarketHoursOverride();
  return { open: override?.open ?? config.open, close: override?.close ?? config.close };
}

export function isMarketOpen(config: MarketHoursConfig = MARKET_HOURS): boolean {
  if (!config.enabled) return true;

  const now = new Date();
  const day = now.getDay();
  if (!config.workdays.includes(day)) return false;

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const localTime = formatter.format(now);

  const { open, close } = getEffectiveMarketHours(config);
  return localTime >= open && localTime < close;
}

/**
 * store.ts — Estado global y ciclo de datos de la app (ex clase `App` de
 * src/app/app.ts).
 *
 * Los signals viven a nivel de módulo: son el equivalente de las propiedades
 * de la clase Angular, que era un singleton (`app-root`). Los componentes se
 * suscriben con `useSignal(...)`; las funciones de acá se llaman igual que los
 * métodos del original (`refreshAll()`, `paused.set(true)`, …).
 *
 * Reglas que este módulo respeta (ver MIGRATION-CONTRACT §4/§5/§6):
 *  - Nombres idénticos a app.ts (signals, funciones, constantes, privados).
 *  - RxJS → async/await sin cambiar la semántica: `forkJoin` → `Promise.all`,
 *    `catchError(() => of(x))` → `.catch(() => x)`, `switchMap` → await
 *    secuencial. Los guards de concurrencia (loading, t0InFlight,
 *    yahooInFlight, yahooRefs*) se preservan tal cual: sin ellos el polling de
 *    1 s se apila.
 *  - NADA de localStorage/document/AudioContext en el cuerpo del módulo: los
 *    signals que en Angular se inicializaban leyendo storage arrancan con el
 *    default del config y los hidrata `hydrateFromStorage()` desde un effect
 *    de montaje del shell (si no, hydration mismatch).
 */
import { signal } from '@/lib/signal';
// bondType/noteType no se importan acá: los usa `detailRows`, que en la
// migración vive en el shell (app/page.tsx) como cálculo de render.
import {
  ARB_TABS, DEFAULTS, ArbTab, CedearRow, Settlement, cohenCedearsUrl, iolCedearsUrl,
  INDEX_SPECS, ETF_SPECS, QuoteSpec, yahooSparkUrl,
} from '@/lib/market.config';
import { scanOpportunities, nextAlertState } from '@/lib/arb-engine';
import { saveSnapshot, loadSnapshot } from '@/lib/panel-snapshot';
import type { ArbOpportunity, MonitorSettings } from '@/lib/arb-engine';
import {
  MARKET_HOURS, isMarketOpen, isValidTimeRange, saveMarketHoursOverride, getEffectiveMarketHours,
} from '@/lib/market-hours.config';

export interface PanelDef {
  id: string;
  label: string;
  url?: string;    // fuente de FALLBACK (data912 / dolarapi)
  iolUrl?: string; // fuente PRIMARIA (IOL vía route handler app/api/iol/panel)
  // optional transformer (e.g. dólar returns objects with nested fields)
  transform?: (raw: any) => any[];
}

// Panels de datos. IOL es la fuente primaria (iolUrl); data912 queda como
// fallback (url) si IOL falla o devuelve vacío. CEDEARs mantiene su propio
// flujo IOL por plazo (api/iol/cedears); Dólar no existe en IOL.
// 'indices' y 'etfs' no tienen url: se refrescan aparte desde Yahoo
// (refreshIndices) porque IOL no los expone — ver nota en market.config.ts.
const PANELS: PanelDef[] = [
  { id: 'acciones',     label: 'Acciones ARG',  url: '/api/data912/live/arg_stocks',  iolUrl: '/api/iol/panel?id=acciones' },
  { id: 'cedears',      label: 'CEDEARs',       url: '/api/data912/live/arg_cedears' },
  { id: 'bonos',        label: 'Bonos',         url: '/api/data912/live/arg_bonds',   iolUrl: '/api/iol/panel?id=bonos' },
  { id: 'letras',       label: 'Letras',        url: '/api/data912/live/arg_notes',   iolUrl: '/api/iol/panel?id=letras' },
  { id: 'ons',          label: 'Obligaciones Negociables', url: '/api/data912/live/arg_corp', iolUrl: '/api/iol/panel?id=ons' },
  { id: 'opciones',     label: 'Opciones',      url: '/api/data912/live/arg_options', iolUrl: '/api/iol/panel?id=opciones' },
  { id: 'indices',      label: 'Índices' },
  { id: 'etfs',         label: 'ETFs' },
  { id: 'dolar',        label: 'Dólar',         url: '/api/dolar/v1/dolares' },
];

// Los índices/ETFs no necesitan el ritmo de 1s de los feeds locales.
const YAHOO_REFRESH_MS = 30_000;

/**
 * `HttpClient.get<T>()` equivalente. DOS diferencias de `fetch` que hay que
 * neutralizar para no romper los fallbacks:
 *
 *  1. `fetch` NO rechaza en 4xx/5xx (sólo en fallo de red), mientras que
 *     HttpClient sí. Todo el ciclo de datos del original depende de eso: los
 *     `catchError` que hacen caer IOL → data912 y Cohen → IOL → snapshot sólo
 *     corren si la respuesta de error se convierte en un rechazo. Por eso acá
 *     se tira el error a mano cuando `!res.ok`.
 *  2. Las cotizaciones no se cachean nunca → `cache: 'no-store'`.
 *
 * El mensaje del Error espeja el de HttpErrorResponse porque `panelStatus()`
 * lo muestra recortado a 30 caracteres.
 */
async function httpGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Http failure response for ${url}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

// Último close cuyo timestamp (epoch s) sea <= hoy - daysBack; la serie viene
// diaria y ascendente. Fallback al primer close de la serie (rango 1y): sirve
// para "% Año" cuando el primer punto cae unos días después del target.
export function refCloseAt(ts: number[], close: (number | null)[], daysBack: number): number | null {
  const target = Date.now() / 1000 - daysBack * 86_400;
  let ref: number | null = null;
  let first: number | null = null;
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    if (c == null || !(+c > 0)) continue;
    if (first == null) first = +c;
    if (ts[i] > target) break;
    ref = +c;
  }
  return ref ?? first;
}

// Resultado de un fetch de panel (IOL o fallback) en refreshFast.
export interface FeedResult {
  id: string;
  rows: any[];
  error: string | null;
  iol?: boolean; // true = filas de IOL; false = fallback data912; undefined = n/a
  src?: CedearsSrc; // sólo para '__cedears_t1' (cadena Cohen → IOL)
}

// Etiquetas en español para las columnas crudas de los feeds (vista detalle
// "Ver todo" y su export). Lo no mapeado se muestra tal cual.
const COL_LABELS: Record<string, string> = {
  symbol: 'Símbolo',
  ticker: 'Ticker',
  tipo: 'Tipo',
  desc: 'Descripción',
  q_bid: 'Cant. Compra',
  px_bid: 'Compra',
  px_ask: 'Venta',
  q_ask: 'Cant. Venta',
  v: 'Volumen',
  q_op: 'Operaciones',
  c: 'Cierre',
  pct_change: '% Día',
  last: 'Último',
  code: 'Código',
  region: 'Región',
  pct_week: '% Sem.',
  pct_year: '% Año',
  casa: 'Casa',
  nombre: 'Nombre',
  compra: 'Compra',
  venta: 'Venta',
  moneda: 'Moneda',
  fechaActualizacion: 'Actualizado',
};

// Columnas de texto (todo lo demás se alinea a la derecha como numérico).
const TEXT_COLS = new Set(['symbol', 'ticker', 'tipo', 'desc', 'code', 'region', 'casa', 'nombre', 'moneda', 'fechaActualizacion']);

const ALERT_FIRE = 2.0;   // umbral de disparo: % neto
const ALERT_REARM = 1.9;  // umbral de re-arme (histéresis)

// Tour de driver.js del toggle Simple/Avanzado — ya no se auto-dispara al
// entrar a Cotizaciones: sólo se lanza desde el botón "Ayuda" de la toolbar.
export const COT_TOUR_SEEN_KEY = 'hasSeenCotizacionesModeTutorial';

// Fuente que efectivamente entregó el libro de CEDEARs de un plazo.
export type CedearsSrc = 'cohen' | 'iol' | null;

// Vista de primer nivel del navbar.
export type View = 'arbitraje' | 'cotizaciones' | 'operaciones';

export const panels = PANELS;
export const arbTabs = ARB_TABS;
export const activePanel = signal<string>(ARB_TABS[0].id);

// Nav de primer nivel (Arbitraje / Cotizaciones) y, dentro de Cotizaciones,
// el casillero de detalle abierto ("Ver todo"); null = mosaico.
export const view = signal<View>('arbitraje');
export const detailPanel = signal<string | null>(null);

// panelId -> rows
export const data = signal<Record<string, any[]>>({});
// panelId -> error string
export const errors = signal<Record<string, string | null>>({});
// panelId -> last update timestamp
export const lastUpdated = signal<Record<string, Date | null>>({});
// panelId -> true si las filas vigentes vinieron de IOL (false = data912).
export const feedSource = signal<Record<string, boolean | undefined>>({});

export const paused = signal(false);
export const marketClosedAutoPause = signal(false);
// Horario de mercado editable (dropdown "Horario" del toolbar). En Angular
// arrancaba leyendo el override de localStorage; en Next eso rompería la
// hidratación, así que arranca con el default de market-hours.config.ts y el
// valor real lo pone hydrateFromStorage() al montar — ese archivo sigue siendo
// el fallback real.
export const hoursMenuOpen = signal(false);
export const marketHoursOpenInput = signal<string>(MARKET_HOURS.open);
export const marketHoursCloseInput = signal<string>(MARKET_HOURS.close);
export const marketHoursError = signal(false);
export const intervalSec = signal<number>(DEFAULTS.refreshSec);
// Modo de la pantalla Cotizaciones (Ley de Hick): 'basico' muestra solo lo
// esencial; 'avanzado' el mosaico completo. Persiste en localStorage (se lee
// en hydrateFromStorage, no acá: ver nota de SSR arriba).
export const uiMode = signal<'basico' | 'avanzado'>('basico');
export const loading = signal(false);
export const filter = signal('');

// Filas de CEDEARs por plazo. Prioridad: Cohen (feed Primary/XOMS) → IOL.
// data912 quedó fuera de esta cadena. Si CI no tiene fuente real, se estima
// desde el libro de 24hs (nunca desde data912).
export const cedearsT0 = signal<CedearRow[]>([]); // Contado Inmediato
export const cedearsT1 = signal<CedearRow[]>([]); // 24hs
// true = libro real del plazo (Cohen o IOL); false = sin fuente real (CI estimado).
export const iolSource = signal<{ t0: boolean; t1: boolean }>({ t0: false, t1: false });
// Quién entregó cada plazo (para la etiqueta de estado).
export const cedearsFeed = signal<{ t0: CedearsSrc; t1: CedearsSrc }>({ t0: null, t1: null });

// Monitor de oportunidades de arbitraje.
export const alertsEnabled = signal<boolean>(true);
export const activeAlerts = signal<ArbOpportunity[]>([]);
// Mejor round-trip por pestaña (sin umbral): alimenta "Mejores
// oportunidades" del modo simple de Cotizaciones.
export const bestOpps = signal<ArbOpportunity[]>([]);
const armed: Record<string, boolean> = {};      // por tabId; true = listo para disparar
let audioCtx: AudioContext | undefined;
let alertBuffer: AudioBuffer | undefined;       // /alert.wav decodificado
let alertBufferLoading = false;
const monitorSettings: MonitorSettings = {
  commissionPct: DEFAULTS.commissionPct,
  minUsdVol: DEFAULTS.minUsdVol,
  ciAdjustPct: DEFAULTS.ciAdjustPct,
};

// Handle del timer de refresco (ex `private sub?: Subscription`).
let timerId: ReturnType<typeof setInterval> | null = null;

// Guard del burst CI: evita encolar bursts t0 cuando el anterior sigue en vuelo.
let t0InFlight = false;

// Estado del ciclo Yahoo (índices/ETFs): throttle + refs 1y por símbolo.
let yahooInFlight = false;
let lastYahooMs = 0;
const yahooRefs = new Map<string, { w: number | null; y: number | null }>();
let yahooRefsReady = false;
let yahooRefsInFlight = false;

/**
 * Lee de localStorage lo que en Angular se leía en el inicializador de los
 * signals. Lo llama el shell en un useEffect de montaje: en el server no hay
 * storage y el primer render del cliente tiene que coincidir con el HTML del
 * server, así que el valor real recién se aplica después de montar.
 */
export function hydrateFromStorage(): void {
  if (typeof window === 'undefined') return;
  let mode: string | null = null;
  try { mode = localStorage.getItem('boston-cot-mode'); } catch { /* storage inaccesible */ }
  uiMode.set(mode === 'avanzado' ? 'avanzado' : 'basico');
  const hours = getEffectiveMarketHours();
  marketHoursOpenInput.set(hours.open);
  marketHoursCloseInput.set(hours.close);
}

// Ex `private startTimer()`: `timer(ms, ms).subscribe(...)` → setInterval, y
// `sub?.unsubscribe()` → clearInterval. Lo arranca el effect de montaje del
// shell y lo recrea onIntervalChange().
export function startTimer(): void {
  stopTimer();
  timerId = setInterval(() => {
    const open = isMarketOpen();
    marketClosedAutoPause.set(!open);
    if (!paused() && open) refreshAll();
  }, intervalSec() * 1000);
}

// Ex `sub?.unsubscribe()` de ngOnDestroy: lo llama el cleanup del useEffect.
export function stopTimer(): void {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
}

export function onIntervalChange(): void {
  startTimer();
}

export function togglePause(): void {
  paused.update((v) => !v);
}

export function setUiMode(m: 'basico' | 'avanzado'): void {
  uiMode.set(m);
  try { localStorage.setItem('boston-cot-mode', m); } catch {}
}

export function toggleHoursMenu(): void {
  hoursMenuOpen.update((v) => !v);
}

export function closeHoursMenu(): void {
  hoursMenuOpen.set(false);
}

export function setMarketHoursOpen(v: string): void {
  marketHoursOpenInput.set(v);
  applyMarketHours();
}

export function setMarketHoursClose(v: string): void {
  marketHoursCloseInput.set(v);
  applyMarketHours();
}

// Valida apertura < cierre; si no vale, marca el error y NO persiste (el
// último valor válido guardado sigue rigiendo). Si vale, persiste y
// reevalúa isMarketOpen() ya mismo — no espera al próximo tick del timer.
function applyMarketHours(): void {
  const open = marketHoursOpenInput();
  const close = marketHoursCloseInput();
  const valid = isValidTimeRange(open, close);
  marketHoursError.set(!valid);
  if (!valid) return;
  saveMarketHoursOverride(open, close);
  marketClosedAutoPause.set(!isMarketOpen());
}

export function refreshAll(): void {
  // Ciclos independientes: los feeds rápidos no esperan al burst CI lento
  // ni al ciclo Yahoo (que además corre cada YAHOO_REFRESH_MS, no cada tick).
  // Los tres son fire-and-forget, igual que los tres .subscribe() del original.
  void refreshFast();
  void refreshT0();
  void refreshIndices();
}

// Índices internacionales y ETFs (Yahoo spark, 1 request por casillero).
export async function refreshIndices(): Promise<void> {
  if (!isMarketOpen()) return;
  const now = Date.now();
  if (yahooInFlight || now - lastYahooMs < YAHOO_REFRESH_MS) return;
  yahooInFlight = true;
  lastYahooMs = now;
  // Sin await: el ciclo 1d no espera a las refs 1y (igual que el subscribe
  // suelto del original).
  void loadYahooRefs();

  const feeds: [string, QuoteSpec[]][] = [['indices', INDEX_SPECS], ['etfs', ETF_SPECS]];
  const calls = feeds.map(([id, specs]) =>
    httpGet<any>(yahooSparkUrl(specs.map((s) => s.code), '1d', '5m'))
      .then((res) => ({ id, specs, res: res as any, error: null as string | null }))
      .catch((err) => ({ id, specs, res: null as any, error: (err?.message ?? 'Error de red') as string | null }))
  );
  // El original baja el guard en la primera línea del subscribe: `.finally()`
  // es el mismo punto (corre antes de que se reanude el await) y además lo
  // libera si la promesa rechaza.
  const results = await Promise.all(calls).finally(() => { yahooInFlight = false; });

  const dataAcc = { ...data() };
  const errAcc = { ...errors() };
  const tsAcc = { ...lastUpdated() };
  const ts = new Date();
  for (const r of results) {
    const rows = r.res ? sparkRows(r.specs, r.res) : [];
    if (rows.length) {
      dataAcc[r.id] = rows;
      errAcc[r.id] = null;
      tsAcc[r.id] = ts;
    } else {
      errAcc[r.id] = r.error ?? 'sin datos';
    }
  }
  data.set(dataAcc);
  errors.set(errAcc);
  lastUpdated.set(tsAcc);
}

// spark 1d → filas con la forma común de la app. `symbol` es el nombre
// legible (S&P 500) y `code` el símbolo Yahoo; % Sem./% Año salen de los
// cierres de referencia 1y (yahooRefs).
export function sparkRows(specs: QuoteSpec[], res: any): any[] {
  const rows: any[] = [];
  for (const s of specs) {
    const d = res?.[s.code];
    const closes: number[] = (d?.close ?? []).filter((x: any) => x != null && +x > 0);
    if (!closes.length) continue;
    const last = closes[closes.length - 1];
    const prev = +d?.chartPreviousClose || 0;
    const refs = yahooRefs.get(s.code);
    const row: any = {
      symbol: s.label,
      code: s.code,
      last,
      pct_change: prev > 0 ? (last / prev - 1) * 100 : 0,
      pct_week: refs?.w ? (last / refs.w - 1) * 100 : null,
      pct_year: refs?.y ? (last / refs.y - 1) * 100 : null,
    };
    if (s.region) row.region = s.region;
    rows.push(row);
  }
  return rows;
}

// Cierres de referencia (~7 y ~365 días atrás) desde spark 1y — una sola
// vez por sesión (el histórico diario no cambia intradía). Si falla, se
// reintenta en el próximo ciclo de refreshIndices.
export async function loadYahooRefs(): Promise<void> {
  if (yahooRefsReady || yahooRefsInFlight) return;
  yahooRefsInFlight = true;
  const feeds = [INDEX_SPECS, ETF_SPECS];
  const calls = feeds.map((specs) =>
    httpGet<any>(yahooSparkUrl(specs.map((s) => s.code), '1y', '1d')).catch(() => null)
  );
  const results = await Promise.all(calls).finally(() => { yahooRefsInFlight = false; });

  let any = false;
  for (const res of results) {
    if (!res) continue;
    for (const code of Object.keys(res)) {
      const d = res[code];
      if (!d?.timestamp?.length || !d?.close?.length) continue;
      yahooRefs.set(code, {
        w: refCloseAt(d.timestamp, d.close, 7),
        y: refCloseAt(d.timestamp, d.close, 365),
      });
      any = true;
    }
  }
  if (any) {
    yahooRefsReady = true;
    // Fuerza un ciclo 1d inmediato para que % Sem./% Año aparezcan ya,
    // sin esperar los YAHOO_REFRESH_MS del throttle.
    lastYahooMs = 0;
  }
}

// Feeds rápidos: IOL como fuente primaria de cada panel (1 request por panel
// vía api/iol/panel) con data912 en paralelo como fallback si IOL falla o
// viene vacío; más dólar e IOL 24hs de CEDEARs. Renderiza en cuanto llegan,
// sin bloquearse por el burst CI (que va en refreshT0()).
export async function refreshFast(): Promise<void> {
  if (!isMarketOpen()) return;
  if (loading()) return;
  loading.set(true);
  // El casillero CEDEARs ya no se pide a data912: lo llena la cadena
  // Cohen → IOL de 24hs (abajo). El resto de los paneles sigue igual.
  const fetchable = PANELS.filter((p) => !!p.url && p.id !== 'cedears');
  const calls: Promise<FeedResult>[] = fetchable.map(async (p): Promise<FeedResult> => {
    const fallback = httpGet<any>(p.url!)
      .then((res) => ({ rows: normalize(res), error: null as string | null }))
      .catch((err) => ({ rows: [] as any[], error: (err?.message ?? 'Error de red') as string | null }));
    if (!p.iolUrl) {
      const r = await fallback;
      return { id: p.id, rows: r.rows, error: r.error };
    }
    const iol = httpGet<any>(p.iolUrl)
      .then((res) => normalize(res))
      .catch(() => [] as any[]);
    // IOL y fallback salen en paralelo (ex forkJoin): el fallback ya está
    // pedido cuando IOL vuelve vacío, no se encadena un segundo round-trip.
    const [iolRows, fb] = await Promise.all([iol, fallback]);
    return iolRows.length
      ? { id: p.id, rows: iolRows, error: null, iol: true }
      : { id: p.id, rows: fb.rows, error: fb.error, iol: false };
  });
  // CEDEARs 24hs: Cohen → IOL (data912 fuera de la cadena).
  calls.push(
    fetchCedears('H24').then(({ rows, src }): FeedResult => ({ id: '__cedears_t1', rows, error: null, src }))
  );

  // El try/finally no cambia el orden del original (loading se baja en el mismo
  // punto, justo antes de runMonitor): es la red de seguridad de que el guard
  // se libere igual si algo tira. Con un `loading` trabado en true el ciclo
  // rápido no volvería a correr nunca más. `set` filtra por identidad, así que
  // el segundo `set(false)` del finally es un no-op.
  try {
    const results = await Promise.all(calls);

    const dataAcc = { ...data() };
    const errAcc = { ...errors() };
    const tsAcc = { ...lastUpdated() };
    const srcAcc = { ...feedSource() };
    const now = new Date();
    let t1Rows: CedearRow[] = [];
    let t1Src: CedearsSrc = null;
    for (const r of results) {
      if (r.id === '__cedears_t1') {
        t1Rows = (r.rows as CedearRow[]) ?? [];
        t1Src = r.src ?? null;
        continue;
      }
      if (r.error) {
        errAcc[r.id] = r.error;
      } else {
        dataAcc[r.id] = r.rows;
        errAcc[r.id] = null;
        tsAcc[r.id] = now;
      }
      if (r.iol !== undefined) srcAcc[r.id] = r.iol;
    }
    // 24hs: lo que haya entregado la cadena Cohen → IOL; vacío = sin libro
    // (data912 ya no participa).
    const t1Real = t1Rows.length > 0;
    cedearsT1.set(t1Rows);
    iolSource.update((s) => ({ ...s, t1: t1Real }));
    cedearsFeed.update((f) => ({ ...f, t1: t1Src }));
    // El casillero CEDEARs de Cotizaciones usa el mismo libro.
    dataAcc['cedears'] = t1Rows;
    errAcc['cedears'] = t1Real ? null : 'sin datos';
    if (t1Real) tsAcc['cedears'] = now;

    data.set(dataAcc);
    errors.set(errAcc);
    lastUpdated.set(tsAcc);
    feedSource.set(srcAcc);
    loading.set(false);
    runMonitor();
  } finally {
    loading.set(false);
  }
}

// Libro de CEDEARs de un plazo con prioridad Cohen → IOL → último snapshot
// válido conocido (localStorage) → []. Si Cohen falla o devuelve vacío
// (auth pendiente, feed caído, mercado cerrado) se pide a IOL; si IOL
// TAMBIÉN falla o devuelve vacío, se sirve el último libro real guardado
// (ver panel-snapshot.ts) en vez de dejar el panel sin datos. Sólo si no
// hay ningún snapshot guardado (primera ejecución en un navegador limpio)
// se retorna vacío. src indica quién entregó filas; null = snapshot o
// ninguna fuente respondió con datos.
export async function fetchCedears(s: Settlement): Promise<{ rows: CedearRow[]; src: CedearsSrc }> {
  const asRows = (raw: unknown): CedearRow[] => (Array.isArray(raw) ? raw : []);
  const fromSnapshot = (): { rows: CedearRow[]; src: CedearsSrc } => {
    const snap = loadSnapshot(s);
    return { rows: snap ?? [], src: null };
  };
  const iol = async (): Promise<{ rows: CedearRow[]; src: CedearsSrc }> => {
    try {
      const rows = asRows(await httpGet<CedearRow[]>(iolCedearsUrl(s)));
      if (rows.length) {
        saveSnapshot(s, rows);
        return { rows, src: 'iol' as CedearsSrc };
      }
      return fromSnapshot();
    } catch {
      return fromSnapshot();
    }
  };
  const cohenUrl = cohenCedearsUrl(s);
  if (!cohenUrl) return iol();
  // ex switchMap: await secuencial. Cohen con filas corta la cadena; Cohen
  // vacío o caído (el throw de httpGet en 4xx/5xx es lo que lo hace caer acá)
  // pasa el turno a IOL.
  let rows: CedearRow[];
  try {
    rows = asRows(await httpGet<CedearRow[]>(cohenUrl));
  } catch {
    rows = [];
  }
  if (rows.length) {
    saveSnapshot(s, rows);
    return { rows, src: 'cohen' as CedearsSrc };
  }
  return iol();
}

// Burst CI (t0): Cohen entrega el libro CI real al instante; si no hay, IOL
// cotiza símbolo por símbolo (feed caro/lento que se auto-regula: no relanza
// hasta que el burst anterior terminó). Sin fuente real, el motor estima el
// CI desde el libro de 24hs (iolSource.t0=false).
export async function refreshT0(): Promise<void> {
  if (!isMarketOpen()) return;
  if (t0InFlight) return;
  t0InFlight = true;
  const { rows, src } = await fetchCedears('CI').finally(() => { t0InFlight = false; });
  const t0Real = rows.length > 0;
  cedearsT0.set(t0Real ? rows : cedearsT1());
  iolSource.update((s) => ({ ...s, t0: t0Real }));
  cedearsFeed.update((f) => ({ ...f, t0: src }));
  runMonitor();
}

export function normalize(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.results)) return raw.results;
  if (raw && typeof raw === 'object') return [raw];
  return [];
}

export function setActive(id: string): void {
  activePanel.set(id);
  view.set('arbitraje');
  filter.set('');
}

/**
 * `navigate` es el único agregado respecto de la firma de Angular: allá el
 * `Router` se inyectaba en la clase, acá el store es código puro (no puede
 * usar `useRouter()`), así que el shell le pasa `router.push`.
 */
export function setView(v: View, navigate?: (path: string) => void): void {
  view.set(v);
  detailPanel.set(null);
  filter.set('');
  // 'operaciones' vive en su propia ruta (app/operar): en Angular el tab era
  // un <a routerLink="/operar"> y la directiva ya navegaba al clickear, así
  // que setView sólo sincronizaba el signal local para que el estado activo
  // del nav fuera instantáneo. Acá se mantiene la misma red de seguridad: si
  // se llama a setView('operaciones') sin pasar por un link, se navega a mano.
  if (v === 'operaciones' && typeof window !== 'undefined' && !window.location.pathname.startsWith('/operar')) {
    navigate?.('/operar');
  }
}

export function openDetail(id: string): void {
  detailPanel.set(id);
  filter.set('');
}

export function closeDetail(): void {
  detailPanel.set(null);
  filter.set('');
}

export async function downloadXLSX(): Promise<void> {
  // xlsx sólo en cliente (pesa y toca APIs de browser al escribir el archivo):
  // se carga on-demand al apretar el botón, no en el bundle inicial.
  const XLSX = await import('xlsx');
  const wasPaused = paused();
  paused.set(true);
  try {
    const wb = XLSX.utils.book_new();
    const snapshot = data();
    const ts = lastUpdated();
    // Resumen
    const resumen = [
      ['Cotizaciones Argento — snapshot'],
      ['Generado', new Date().toISOString()],
      [],
      ['Panel', 'Filas', 'Última actualización'],
      ...PANELS.map((p) => [p.label, (snapshot[p.id] ?? []).length, ts[p.id]?.toISOString() ?? '']),
    ];
    const wsResumen = XLSX.utils.aoa_to_sheet(resumen);
    XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');

    for (const p of PANELS) {
      const rows = snapshot[p.id] ?? [];
      const ws = rows.length
        ? XLSX.utils.json_to_sheet(rows)
        : XLSX.utils.aoa_to_sheet([['Sin datos']]);
      const sheetName = p.label.substring(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }

    const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    XLSX.writeFile(wb, `cotizaciones-argento-${date}.xlsx`);
  } finally {
    if (!wasPaused) paused.set(false);
  }
}

// Etiqueta en español de una columna cruda del feed (vista detalle).
export function colLabel(col: string): string {
  return COL_LABELS[col] ?? col;
}

export function isNumCol(col: string): boolean {
  return !TEXT_COLS.has(col);
}

export function fmt(v: any): string {
  if (v == null) return '';
  if (typeof v === 'number') {
    const abs = Math.abs(v);
    if (abs > 0 && abs < 0.01) return v.toPrecision(3);
    return v.toLocaleString('es-AR', { maximumFractionDigits: 4 });
  }
  if (v instanceof Date) return v.toLocaleString('es-AR');
  // Timestamps ISO de los feeds (p. ej. fechaActualizacion) → hora local.
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.toLocaleString('es-AR');
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function panelStatus(id: string): string {
  // Las arb tabs no tienen url propia: usan el feed de CEDEARs (Cohen → IOL).
  const arbTab = arbTabs.find((t) => t.id === id);
  if (arbTab) {
    const ts = lastUpdated()['cedears'];
    if (!ts) return 'esperando CEDEARs…';
    const sec = Math.round((Date.now() - ts.getTime()) / 1000);
    // Sin nombre de proveedor en la UI (pedido de Elio 2026-07-23: no
    // exponer qué APIs usamos en el dashboard) — sólo se distingue el caso
    // "estimado desde 24hs" porque es una calidad de dato, no una fuente.
    const isCi = arbTab.settlement === 'CI';
    const real = isCi ? iolSource().t0 : iolSource().t1;
    const src = isCi ? cedearsFeed().t0 : cedearsFeed().t1;
    const estimado = !src && !real;
    return `hace ${sec}s${estimado ? ' · estimado desde 24hs' : ''}`;
  }
  const ts = lastUpdated()[id];
  const err = errors()[id];
  if (err) return `error: ${err.substring(0, 30)}`;
  if (!ts) return '—';
  const sec = Math.round((Date.now() - ts.getTime()) / 1000);
  return `hace ${sec}s`;
}

// --- Monitor de alertas ---

export function runMonitor(): void {
  const opps = scanOpportunities(
    cedearsT0(), cedearsT1(), iolSource(), monitorSettings
  );
  bestOpps.set([...opps].sort((a, b) => b.netPct - a.netPct));
  const byTab = new Map(opps.map(o => [o.tabId, o] as const));
  let fired = false;
  for (const tab of ARB_TABS) {
    const net = byTab.get(tab.id)?.netPct ?? Number.NEGATIVE_INFINITY;
    const prev = armed[tab.id] ?? true;
    const s = nextAlertState(prev, net, { fire: ALERT_FIRE, rearm: ALERT_REARM });
    armed[tab.id] = s.armed;
    if (s.fire) fired = true;
  }
  activeAlerts.set(
    opps.filter(o => o.netPct >= ALERT_FIRE).sort((a, b) => b.netPct - a.netPct)
  );
  if (fired && alertsEnabled()) playBeep();
}

export function toggleAlerts(): void {
  const next = !alertsEnabled();
  alertsEnabled.set(next);
  if (next) initAudio();   // el click cuenta como gesto → habilita el audio
}

// Se usa además como listener de pointerdown/keydown (el ex `unlockAudio`):
// es una referencia estable de módulo, así que removeEventListener la encuentra.
export function initAudio(): void {
  try {
    if (!audioCtx) {
      const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (Ctor) audioCtx = new Ctor();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    loadAlertSound();
  } catch { /* audio no disponible: ignorar */ }
}

// Pre-carga /alert.wav como AudioBuffer. Web Audio reproduce igual con la
// pestaña en segundo plano o el navegador minimizado, siempre que el
// contexto se haya desbloqueado con un gesto del usuario.
export function loadAlertSound(): void {
  if (alertBuffer || alertBufferLoading || !audioCtx) return;
  alertBufferLoading = true;
  const ctx = audioCtx;
  fetch('/alert.wav')
    .then((r) => r.arrayBuffer())
    .then((buf) => ctx.decodeAudioData(buf))
    .then((decoded) => { alertBuffer = decoded; })
    .catch(() => { alertBufferLoading = false; });
}

export function playBeep(): void {
  try {
    initAudio();
    const ctx = audioCtx;
    if (!ctx) return;
    // Sonido custom de alerta; beep sintetizado sólo si el .wav aún no cargó.
    if (alertBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = alertBuffer;
      src.connect(ctx.destination);
      src.start();
      return;
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.26);
  } catch { /* ignorar */ }
}

// Re-export de los tipos que consume el shell y los componentes.
export type { ArbTab, CedearRow, ArbOpportunity };

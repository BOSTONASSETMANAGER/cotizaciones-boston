'use client';

/**
 * Operar.tsx — Port de src/app/operar.component.ts (Angular 21) a React 19 /
 * Next 16. Paridad exacta: mismos nombres de signals/campos/métodos, mismos
 * textos en español, mismas constantes, mismos comentarios de negocio.
 *
 * Decisiones de la migración (ver MIGRATION-CONTRACT.md §4/§5/§5-bis/§6):
 *
 *  - SIGNALS POR-INSTANCIA. A diferencia del store global del shell
 *    (lib/store.ts, signals a nivel de módulo), TODO el estado de esta
 *    pantalla es por-instancia — igual que los `signal()` de una clase de
 *    componente Angular. Se resuelve con una FACTORY (`createOperarStore()`)
 *    que crea los signals + computeds + métodos en un closure, instanciada
 *    una sola vez por montaje con `useRef` (ver `useOperarStore()`). Así el
 *    código portado se lee igual que el Angular: `this.subview()` →
 *    `subview()`, `this.paused.set(x)` → `paused.set(x)`.
 *    La suscripción a React es UNA sola (`useSyncExternalStore` sobre un
 *    contador de versión que se incrementa en cualquier `set()`/`update()`
 *    de cualquier signal del store, ver `sig()`), en vez de ~40 `useSignal()`
 *    sueltos: reproduce la detección de cambios de Angular (un cambio de
 *    signal → re-render → todos los computed se re-evalúan al leerse) con un
 *    único punto de integración.
 *
 *  - EFFECTS. Cada `effect()` de Angular es un `useEffect` acá, DECLARADO EN
 *    EL MISMO ORDEN que en el original (Angular corre los effects en orden de
 *    creación y ese orden es semántico: `prefetchHome` tiene que correr ANTES
 *    de `hydrateFromRoute`, que cambia subview() a 'ticket').
 *
 *  - `@ViewChild` → `useRef`. `ngOnDestroy` → cleanup del useEffect de montaje.
 *
 *  - lightweight-charts NO es SSR-safe: se importa con `await import(...)`
 *    dentro del efecto que crea el gráfico. Sólo los tipos se importan arriba
 *    (`import type`, se borran en compilación).
 */

import { Fragment, useEffect, useRef, useSyncExternalStore } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { IChartApi, ISeriesApi, TickMarkType, Time, UTCTimestamp } from 'lightweight-charts';

import { signal, computed } from '@/lib/signal';
import { iolCedearsUrl, cohenHistoricoUrl, type CedearRow } from '@/lib/market.config';
import {
  PanelRow,
  OperarSubview,
  InstrumentId,
  InstrumentPill,
  INSTRUMENT_PILLS,
  DolarStripRow,
  MoverRow,
  FondoRow,
  FONDO_TIPO_LABEL,
  CurrencyPillId,
  CURRENCY_PILLS,
  PanelSubTabDef,
  PanelSortColumn,
  PanelSortState,
  ChartRango,
  CHART_RANGOS,
  HistoricoPoint,
  TicketStep,
  TicketState,
  TicketTipoPrecio,
  TICKET_TIPO_PRECIO,
  TicketPlazo,
  TICKET_PLAZOS,
  OperarInstrumento,
  TenenciaRow,
  TicketTipoOperacion,
  INSTRUMENTO_CHIP_LABEL,
} from '@/lib/operar.types';
import {
  SimulatedMovement,
  loadMovements,
  addMovement,
  loadHomeColLeft,
  loadHomeColRight,
  saveHomeColLeft,
  saveHomeColRight,
} from '@/lib/operar-storage';

import './Operar.css';

// Tira de dólares — hardcodeada, sin proxy propio todavía.
// TODO: wire a /Cotizaciones/MEP cuando haya proxy.
const DOLAR_STRIP: DolarStripRow[] = [
  { label: 'Oficial', value: 1230 },
  { label: 'MEP', value: 1418 },
  { label: 'CCL', value: 1432 },
];

// fechaDesde de la ventana de un rango del gráfico, en UNIDADES DE CALENDARIO
// reales (no un multiplicador fijo de días): 1 semana/mes/semestre/año/
// quinquenio hacia atrás desde `today` (por defecto, ahora). Devuelve un Date
// nuevo, nunca muta `today`. Sirve para derivar `dias` con precisión de
// calendario para Cohen (cohenHistoricoUrl pide `dias`, no fechas — contrato
// de la serverless function sin tocar, ver restricción de no alterar
// endpoints) y para el mensaje amigable de "sin datos" (regla 3, más abajo).
function rangoFechaDesde(rango: ChartRango, today: Date = new Date()): Date {
  const d = new Date(today);
  switch (rango) {
    case '1S': d.setDate(d.getDate() - 7); break;
    case '1M': d.setMonth(d.getMonth() - 1); break;
    case '6M': d.setMonth(d.getMonth() - 6); break;
    case '1A': d.setFullYear(d.getFullYear() - 1); break;
    case 'MAX': d.setFullYear(d.getFullYear() - 5); break; // tope razonable, no todo el historial
  }
  return d;
}

// yyyy-MM-dd — mismo formato ISO corto que exige el endpoint de serie
// histórica de IOL (ver ymd() server-side en api/iol/historico.js). Se usa
// para logging/diagnóstico del rango real pedido, nunca se manda a mano al
// endpoint de IOL (ese proxy sigue recibiendo `rango` como antes).
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Punto ya transformado al formato que exige TradingView Lightweight
// Charts (BaselineSeries): time en UNIX epoch segundos, value = cierre real
// (ultimoPrecio de HistoricoPoint — ver operar.types.ts, no hay campo
// "cierre" real). Sólo se construye a partir de historicoData(), nunca con
// datos hardcodeados/mock.
interface ChartBaselinePoint {
  time: UTCTimestamp;
  value: number;
}

// Rangos intradía: sus marcas necesitan granularidad de hora disponible
// (timeVisible:true) para que TradingView pueda distinguir varios puntos
// del mismo día al hacer zoom in — el tickMarkFormatter (abajo) decide el
// TEXTO final igual, pero sin timeVisible TradingView ni siquiera ofrece
// el nivel de detalle Time/TimeWithSeconds. 6M/1A/MAX son series diarias
// de punta a punta: timeVisible:false para que NINGUNA marca pueda
// mostrar hora bajo ninguna circunstancia (requisito explícito).
// (era `private static readonly` de OperarComponent — acá constante de módulo)
const INTRADAY_RANGOS = new Set<ChartRango>(['1S', '1M']);

// Módulo de lightweight-charts cargado en runtime (nunca en el top-level:
// no es SSR-safe, ver el useEffect del gráfico).
type LightweightCharts = typeof import('lightweight-charts');

// ── Capa HTTP: HttpClient de Angular → fetch ────────────────────────────────
// OJO, ESTO ES CRÍTICO PARA LA PARIDAD: `HttpClient.get()` RECHAZA cuando el
// status HTTP no es 2xx, y todos los `catchError(() => of(fallback))` del
// original dependen de eso (la cascada Cohen → IOL del histórico, el
// fondosError, los [] de los paneles). `fetch` en cambio RESUELVE igual con
// 404/500, así que un catch() nunca se dispararía y el `.json()` de un cuerpo
// de error se colaría como si fuera data válida. Por eso el error se tira a
// mano acá, con la misma forma que un HttpErrorResponse (status + error) para
// que el console.error de diagnóstico del histórico siga imprimiendo lo mismo.
class HttpError extends Error {
  constructor(readonly status: number, readonly error: unknown) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

async function httpGet<T>(url: string): Promise<T> {
  // `cache: 'no-store'` (§5 del contrato): las cotizaciones no se cachean.
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : raw;
    } catch {
      /* cuerpo de error no-JSON: se deja el texto crudo, igual que HttpClient */
    }
    throw new HttpError(res.status, body);
  }
  return (await res.json()) as T;
}

// Espeja `[class.x]="cond"` de Angular: concatena sólo las clases cuya
// condición es verdadera y deja las clases fijas intactas (§5-bis: los
// nombres de clase se portan literales, NO hay CSS Modules).
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ────────────────────────────────────────────────────────────────────────────
// Store por-instancia (ex `export class OperarComponent`)
// ────────────────────────────────────────────────────────────────────────────
function createOperarStore() {
  // Punto único de integración con React: cualquier set()/update() de
  // cualquier signal creado con sig() incrementa `version` y notifica, y el
  // componente re-renderiza (equivalente a la detección de cambios de
  // Angular para este componente).
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => {
    version += 1;
    for (const l of listeners) l();
  };
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  };
  const getSnapshot = () => version;

  function sig<T>(initial: T) {
    const s = signal<T>(initial);
    s.subscribe(notify);
    return s;
  }

  // Navegación (ex `private router = inject(Router)`): la inyecta el
  // componente con el router de next/navigation en un useEffect (ver
  // setNavigate) — el store es código plano, sin hooks.
  let navigate: (href: string) => void = () => {};
  const setNavigate = (fn: (href: string) => void) => {
    navigate = fn;
  };

  // Hidratación de estado por ruta (/operar/:ticker, ver app/operar/**):
  // en Angular eran `input()` bindeados vía withComponentInputBinding
  // (app.config.ts) desde el param de ruta `ticker` y los query params
  // `tipo`/`origin` — acá los sincroniza el componente desde el prop
  // `ticker` y `useSearchParams()`, sin servicio de navegación propio ni
  // estado intermedio. Cualquier click en un activo o en "Comprar" navega
  // directo a esta ruta (ver goToOrder/comprarDirecto/comprarMasDesdeCartera/
  // venderDesdeCartera más abajo) y `hydrateFromRoute` monta directo la
  // pantalla de orden (gráfico + Puntas + formulario), sin pasar por Ficha ni
  // por ningún resumen previo.
  const ticker = sig<string | null>(null);
  const tipo = sig<TicketTipoOperacion>('compra');
  const origin = sig<'ficha' | 'cartera' | 'panel' | 'home'>('home');

  const pills: InstrumentPill[] = INSTRUMENT_PILLS;
  const dolarStrip: DolarStripRow[] = DOLAR_STRIP;
  const currencyPills = CURRENCY_PILLS;
  const chartRangos = CHART_RANGOS;
  const subview = sig<OperarSubview>('home');
  const selectedInstrumentId = sig<InstrumentId | null>(null);
  const selectedSymbol = sig<string | null>(null);
  const query = sig('');

  const accionesRows = sig<PanelRow[]>([]);
  const cedearsRows = sig<CedearRow[]>([]);
  const bonosRows = sig<PanelRow[]>([]);
  const letrasRows = sig<PanelRow[]>([]);
  // Fondos (FCI) — datos reales vía api/iol/fondos.js (ver loadFondos()).
  // Fetch propio (no entra en el Promise.all de loadHome porque es un endpoint
  // sin relación con acciones/cedears/bonos, y con manejo de error propio:
  // sin fallback real posible, ver template op-fondos). fondosLoading
  // arranca en true para mostrar "Cargando…" desde el primer render, no un
  // estado vacío falso antes de que la request termine.
  const fondosRows = sig<FondoRow[]>([]);
  const fondosLoading = sig(true);
  const fondosError = sig(false);
  const onsRows = sig<PanelRow[]>([]);
  // Panel de Acciones en US$ (mapea a /api/iol/panel?id=usa) — único caso con
  // fuente real fuera de AR$, ver docs/api-iol.md §3.1.
  const usaRows = sig<PanelRow[]>([]);

  // Estado propio de la subvista Panel.
  const panelQuery = sig('');
  const panelCurrency = sig<CurrencyPillId>('ars');
  const panelSubTab = sig<string>('lider');
  const panelSort = sig<PanelSortState>({ column: 'symbol', dir: 'asc' });

  // Estado propio de la subvista Ficha.
  const chartRango = sig<ChartRango>('1M');
  const historicoData = sig<HistoricoPoint[]>([]);
  const historicoLoading = sig(false);
  // Aviso amigable cuando el rango pedido no trajo datos reales de NINGUNA
  // fuente (Cohen ni IOL) — p. ej. 1S cayendo un fin de semana largo sin
  // ruedas. Regla 3 (invariabilidad): en ese caso se CONSERVAN los últimos
  // datos válidos ya cargados (no se pisa historicoData ni se inventa nada)
  // y sólo se muestra este mensaje; null = sin aviso pendiente.
  const historicoAviso = sig<string | null>(null);
  const fichaBookOpen = sig(true);

  // Estado propio de la subvista Ticket — 100% UI, sin request a operatoria
  // (ver docs/api-iol.md §4; Elio pidió que quede hardcodeado hasta que IOL
  // habilite la API para la cuenta).
  const tipoPrecioOpts = TICKET_TIPO_PRECIO;
  const plazoOpts = TICKET_PLAZOS;
  const ticketStep = sig<TicketStep>('form');
  const ticketState = sig<TicketState>(defaultTicketState());
  const ticketAccepted = sig(false);
  const ticketBannerShown = sig(false);
  // Compra o venta (ver openTicket) y subvista desde la que se abrió el
  // Ticket, para saber a dónde volver con "← Volver" (goBackFromTicketForm).
  // 'panel'/'home' se agregan para el botón "Comprar" directo desde las
  // filas de Panel y de Home (Acciones/Destacados) — ver comprarDirecto.
  const ticketTipo = sig<TicketTipoOperacion>('compra');
  const ticketOrigin = sig<'ficha' | 'cartera' | 'panel' | 'home'>('ficha');

  // Estado propio de la subvista Cartera — simulación en localStorage, ver
  // operar-storage.ts y operar.types.ts §Cartera simulada.
  // OJO (§6 del contrato): en Angular esto era `signal(loadMovements())`, que
  // lee localStorage en el inicializador. Acá arranca en [] y lo hidrata
  // `hydrateFromStorage()` desde un useEffect de montaje, para que el HTML
  // del server y el primer render del cliente coincidan.
  const carteraTab = sig<'tenencias' | 'movimientos'>('tenencias');
  const simulatedMovements = sig<SimulatedMovement[]>([]);
  // Symbol de Tenencias con las acciones "Comprar más"/"Vender" desplegadas.
  const tenenciaExpandida = sig<string | null>(null);
  const instrumentoLabel = INSTRUMENTO_CHIP_LABEL;

  // Filtro por tipo de instrumento de Tenencias — mismos pills que Home
  // (ver .op-pills/.op-pill), sólo se agrega 'todos' adelante. 'Todos' por
  // default (ver PROMPT 7). No afecta a Movimientos ni a la composición
  // (composicionCartera se calcula siempre sobre TODAS las tenencias).
  const tenenciasFiltro = sig<InstrumentId | 'todos'>('todos');
  const tenenciasFilterOptions: Array<{ id: InstrumentId | 'todos'; label: string; initials: string }> = [
    { id: 'todos', label: 'Todos', initials: 'TD' },
    ...INSTRUMENT_PILLS,
  ];
  const tenenciasFiltradas = computed<TenenciaRow[]>(() => {
    const filtro = tenenciasFiltro();
    const all = tenencias();
    return filtro === 'todos' ? all : all.filter((t) => t.instrumento === filtro);
  });

  // Composición de la cartera por tipo de instrumento — % sobre el VALOR
  // actual de mercado (cantidad × precio actual, misma métrica que ya usa
  // el resumen de Cartera: Total invertido/Valor actual), no por cantidad
  // de posiciones. ASUNCIÓN A CONFIRMAR con Elio, ver reporte del PROMPT 7.
  // Siempre sobre tenencias() completas (ignora tenenciasFiltro) — el
  // widget muestra la composición real de TODA la cartera.
  const composicionCartera = computed<{ instrumento: OperarInstrumento; label: string; pct: number }[]>(() => {
    const rows = tenencias();
    const total = rows.reduce((s, t) => s + t.valorActual, 0);
    if (total <= 0) return [];
    const porTipo = new Map<OperarInstrumento, number>();
    for (const t of rows) {
      porTipo.set(t.instrumento, (porTipo.get(t.instrumento) ?? 0) + t.valorActual);
    }
    return [...porTipo.entries()]
      .map(([instrumento, valor]) => ({ instrumento, label: instrumentoLabel[instrumento], pct: (valor / total) * 100 }))
      .sort((a, b) => b.pct - a.pct);
  });

  let homeLoaded = false;
  // Ids ya fetcheados en esta sesión del componente (letras/ons son lazy;
  // acciones/cedears/bonos ya vienen del prefetch de Home).
  const lazyFetched = new Set<'letras' | 'ons'>();
  let usaFetched = false;
  // Cache de serie histórica por symbol+rango — no se re-fetchea si ya se pidió.
  const historicoCache = new Map<string, HistoricoPoint[]>();

  // Lectura del estado persistido en localStorage (§6): va en un useEffect de
  // montaje, NO en el inicializador de los signals. Cubre lo que en Angular
  // hacían `signal(loadMovements())` y `signal(loadHomeColLeft() ?? …)`.
  function hydrateFromStorage() {
    const movs = loadMovements();
    if (movs.length) simulatedMovements.set(movs);
    const left = loadHomeColLeft();
    if (left) homeInstrumentLeft.set(left);
    const right = loadHomeColRight();
    if (right) homeInstrumentRight.set(right);
  }

  // Prefetch al entrar a Home; sólo una vez por sesión del componente (Panel/
  // Ficha/Ticket no tienen fetch propio todavía).
  // (ex `private prefetchHome = effect(...)`; el polling de 20s que se armaba
  // acá adentro vive ahora en un useEffect de montaje del componente — ver
  // startHomePolling: subview() arranca siempre en 'home', así que el timer
  // arrancaba igual en el primer ciclo).
  function prefetchHome() {
    if (subview() === 'home' && !homeLoaded) {
      homeLoaded = true;
      void loadHome();
      void loadFondos();
      // Si el instrumento persistido de alguna columna es Letras/ONs (ver
      // loadHomeColLeft/Right en operar-storage.ts), dispara su fetch lazy
      // ya mismo — antes esto sólo pasaba al hacer click en un toggle
      // (selectHomeInstrument), pero ahora la columna puede arrancar
      // directo en ese instrumento por la persistencia.
      ensurePanelData(homeInstrumentLeft());
      ensurePanelData(homeInstrumentRight());
    }
  }

  // Índice rotativo del widget compacto de Destacados (header, al lado del
  // buscador) — antes mostraba fijo topMover() (el mayor % de ganancia);
  // ahora rota entre TODOS los elementos de destacados() cada 4.5s. Se
  // alimenta de datos vivos: destacados() ya es un computed sobre
  // accionesRows/cedearsRows (refrescadas por el polling de arriba), así que
  // el elemento que se está mostrando en cada momento se actualiza solo si
  // cambia su precio/variación mientras está en pantalla — currentMoverIndex
  // sólo decide CUÁL mostrar, no clona el dato.
  const currentMoverIndex = sig(0);
  const moverRotationPaused = sig(false);
  // Tick de la rotación (ex `timer(4_500, 4_500).subscribe(...)`) — el
  // setInterval vive en un useEffect de montaje del componente.
  function rotateMover() {
    if (moverRotationPaused()) return;
    const n = destacados().length;
    if (!n) return;
    currentMoverIndex.update((i) => (i + 1) % n);
  }

  // Mover que muestra el widget rotativo del header: clamp por si
  // destacados() cambió de tamaño (ej. de 5 a menos) entre rotaciones.
  const rotatingMover = computed<MoverRow | null>(() => {
    const list = destacados();
    if (!list.length) return null;
    const idx = currentMoverIndex() % list.length;
    return list[idx];
  });
  // Envoltorio en array de 0/1 para poder recrear el nodo en cada rotación
  // (ver comentario en el JSX) — necesario para que el fade se reproduzca en
  // cada rotación en vez de quedar estático.
  const rotatingMoverList = computed<MoverRow[]>(() => {
    const m = rotatingMover();
    return m ? [m] : [];
  });

  function pauseMoverRotation() {
    moverRotationPaused.set(true);
  }

  function resumeMoverRotation() {
    moverRotationPaused.set(false);
  }

  // Fetch de la serie histórica al entrar a Ficha O al Ticket (pantalla de
  // compra, con Puntas+Orden — ver JSX) o al cambiar de rango (cacheado por
  // symbol+rango en loadHistorico, ver más abajo). El Ticket también muestra
  // el gráfico (ver .op-chart-card en el JSX de 'ticket'), así que necesita
  // la misma data que Ficha.
  function fichaFetch() {
    const sym = selectedSymbol();
    const rango = chartRango();
    const view = subview();
    if ((view !== 'ficha' && view !== 'ticket') || !sym) return;
    void loadHistorico(sym, rango);
  }

  // Hidratación directa desde /operar/:ticker (ver ticker/tipo/origin arriba):
  // cuando el param de ruta cambia (navegación por URL, back/forward, o
  // refresh de página), monta la pantalla de orden (Ticket: gráfico + Puntas +
  // formulario) para ESE símbolo sin pasar por Home/Panel/Ficha — mismo
  // estado que dejaría openTicket(), pero disparado por la ruta en vez de por
  // un click ya procesado en memoria. Bypassea cualquier vista intermedia: no
  // hay modal ni resumen previo entre el click y esta pantalla.
  function hydrateFromRoute() {
    const t = ticker();
    if (!t) return;
    const symbol = decodeURIComponent(t).toUpperCase();
    if (selectedSymbol() === symbol && subview() === 'ticket') return;
    openTicket(tipo(), symbol, origin());
  }

  const searchResults = computed<PanelRow[]>(() => {
    const q = query().trim().toLowerCase();
    if (!q) return [];
    const all: PanelRow[] = [...accionesRows(), ...cedearsRows()];
    return all
      .filter((r) => String(r.symbol ?? '').toLowerCase().includes(q) || String(r.desc ?? '').toLowerCase().includes(q))
      .slice(0, 8);
  });

  // Panel de Acciones (primer contenedor de Home): 2 columnas INDEPENDIENTES
  // (pedido de Elio, reemplaza el toggle global único que tenían antes) —
  // cada columna elige su propio tipo de instrumento vía dropdown y persiste
  // esa elección en localStorage (ver operar-storage.ts), mismo patrón que
  // market-hours.config.ts. Reusa exactamente la misma fuente cacheada que
  // ya lee panelRawRows para Panel — nada de fetch/datos nuevos, sólo lee
  // accionesRows/cedearsRows/bonosRows/letrasRows/onsRows según el
  // instrumento elegido en cada columna.
  // (§6: el default del config va en el inicializador; el valor real de
  // localStorage lo aplica hydrateFromStorage() en el montaje.)
  const homeInstrumentLeft = sig<InstrumentId>('acciones');
  const homeInstrumentRight = sig<InstrumentId>('cedears');
  const homeInstrumentLabelLeft = computed<string>(() => pills.find((p) => p.id === homeInstrumentLeft())?.label ?? '');
  const homeInstrumentLabelRight = computed<string>(() => pills.find((p) => p.id === homeInstrumentRight())?.label ?? '');

  // Dropdown custom de instrumento (reemplaza el <select> nativo, ver
  // .op-dropdown en el JSX): abre/cierra por click en el botón, se cierra al
  // elegir una opción o al clickear afuera (ver closeDropdowns, registrado
  // una sola vez en un useEffect de montaje).
  const dropdownOpenLeft = sig(false);
  const dropdownOpenRight = sig(false);

  function toggleDropdownLeft(ev: { stopPropagation(): void }) {
    ev.stopPropagation();
    dropdownOpenRight.set(false);
    dropdownOpenLeft.set(!dropdownOpenLeft());
  }

  function toggleDropdownRight(ev: { stopPropagation(): void }) {
    ev.stopPropagation();
    dropdownOpenLeft.set(false);
    dropdownOpenRight.set(!dropdownOpenRight());
  }

  function pickHomeInstrumentLeft(id: InstrumentId) {
    selectHomeInstrumentLeft(id);
    dropdownOpenLeft.set(false);
  }

  function pickHomeInstrumentRight(id: InstrumentId) {
    selectHomeInstrumentRight(id);
    dropdownOpenRight.set(false);
  }

  function rowsForInstrument(id: InstrumentId): PanelRow[] {
    const rows: PanelRow[] = id === 'cedears' ? cedearsRows() : (
      id === 'bonos' ? bonosRows() :
      id === 'letras' ? letrasRows() :
      id === 'ons' ? onsRows() :
      accionesRows()
    );
    return [...rows].sort((a, b) => String(a.symbol ?? '').localeCompare(String(b.symbol ?? '')));
  }

  // Cada columna ahora es la lista COMPLETA de su propio instrumento (ya no
  // es una mitad alfabética de una única lista global, ver comentario de
  // arriba) — mismo orden alfabético que antes.
  const homeRowsLeft = computed<PanelRow[]>(() => rowsForInstrument(homeInstrumentLeft()));
  const homeRowsRight = computed<PanelRow[]>(() => rowsForInstrument(homeInstrumentRight()));
  // Preview mobile (PROMPT 9), ahora por columna: primeras 8 de cada
  // instrumento independiente. Sólo se usa en .op-acciones-cards (≤760px);
  // el desktop sigue mostrando homeRowsLeft/homeRowsRight completas.
  const homePreviewMobileLeft = computed<PanelRow[]>(() => homeRowsLeft().slice(0, 8));
  const homePreviewMobileRight = computed<PanelRow[]>(() => homeRowsRight().slice(0, 8));

  // Top 5 movers por variación absoluta, 100% real sobre acciones+cedears
  // cacheados. Antes eran 4 (1 destacado grande + 3 chicos en grid de 2
  // columnas): el 3ro quedaba solo en su fila, dejando un hueco vacío al
  // lado — con 5 (1 grande + 4 chicos) el grid de 2x2 de los chicos cierra
  // sin huecos (ver .op-mover-top ocupando la fila completa en el template).
  const destacados = computed<MoverRow[]>(() => {
    const all: PanelRow[] = [...accionesRows(), ...cedearsRows()];
    return [...all]
      .filter((r) => r?.symbol)
      .sort((a, b) => Math.abs(b.pct_change || 0) - Math.abs(a.pct_change || 0))
      .slice(0, 5)
      .map((r) => ({ symbol: r.symbol, price: price(r), pctChange: r.pct_change || 0 }));
  });

  // Widget compacto nuevo, al lado del buscador (reemplaza el espacio que
  // ocupaban los 5 toggles de instrumento): la acción/cedear con MAYOR % de
  // ganancia en tiempo real. Reusa la misma fuente/orden que destacados() en
  // vez de reinventar el cálculo — a diferencia de destacados() (top 4 por
  // variación ABSOLUTA, mezcla ganancias y pérdidas), acá se filtra sólo
  // pct_change positivo y se ordena descendente para quedarnos con el mayor
  // ganador real del momento.
  const topMover = computed<MoverRow | null>(() => {
    const all: PanelRow[] = [...accionesRows(), ...cedearsRows()];
    const ganadores = all
      .filter((r) => r?.symbol && (r.pct_change || 0) > 0)
      .sort((a, b) => (b.pct_change || 0) - (a.pct_change || 0));
    const top = ganadores[0];
    return top ? { symbol: top.symbol, price: price(top), pctChange: top.pct_change || 0 } : null;
  });

  const selectedInstrumentLabel = computed<string>(() => {
    const id = selectedInstrumentId();
    return pills.find((p) => p.id === id)?.label ?? '';
  });

  // Sub-tabs por instrumento. Heurística simple (ver panelFilteredRows);
  // Cedears/Letras/ONs no tienen sub-tab todavía → tabla directa.
  const panelSubTabs = computed<PanelSubTabDef[]>(() => {
    const id = selectedInstrumentId();
    if (id === 'acciones') return [{ id: 'lider', label: 'Panel líder' }, { id: 'general', label: 'Panel general' }];
    if (id === 'bonos') return [{ id: 'usd', label: 'Soberanos US$' }, { id: 'ars', label: 'Soberanos AR$' }];
    return [];
  });

  // Filas crudas del instrumento+moneda elegidos, reusando los signals ya
  // cacheados (Home o el fetch lazy de letras/ons/usa — nunca se re-fetchea).
  const panelRawRows = computed<PanelRow[]>(() => {
    const id = selectedInstrumentId();
    if (!id) return [];
    if (id === 'acciones' && panelCurrency() === 'usd') return usaRows();
    switch (id) {
      case 'acciones': return accionesRows();
      case 'cedears': return cedearsRows();
      case 'bonos': return bonosRows();
      case 'letras': return letrasRows();
      case 'ons': return onsRows();
      default: return [];
    }
  });

  const isGeneralEmpty = computed<boolean>(() =>
    selectedInstrumentId() === 'acciones' && panelSubTab() === 'general'
  );

  // Aplica sub-tab (heurística de prefijo/sufijo de símbolo) + buscador propio de Panel.
  const panelFilteredRows = computed<PanelRow[]>(() => {
    let rows = panelRawRows();
    const id = selectedInstrumentId();
    const sub = panelSubTab();
    if (id === 'acciones') {
      // "Panel general" es placeholder vacío por ahora (ver isGeneralEmpty / TODO en el JSX).
      if (sub === 'general') rows = [];
    } else if (id === 'bonos') {
      // Heurística: símbolos que terminan en D son la pata en dólares (soberanos US$).
      rows = rows.filter((r) => (String(r.symbol ?? '').endsWith('D') ? sub === 'usd' : sub === 'ars'));
    }
    const q = panelQuery().trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) =>
        String(r.symbol ?? '').toLowerCase().includes(q) || String(r.desc ?? '').toLowerCase().includes(q)
      );
    }
    return rows;
  });

  const panelSortedRows = computed<PanelRow[]>(() => {
    const rows = [...panelFilteredRows()];
    const { column, dir } = panelSort();
    const mul = dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      if (column === 'symbol') return String(a.symbol ?? '').localeCompare(String(b.symbol ?? '')) * mul;
      if (column === 'price') return (price(a) - price(b)) * mul;
      return ((a.pct_change || 0) - (b.pct_change || 0)) * mul;
    });
    return rows;
  });

  // Fila cacheada del símbolo de Ficha, buscada en TODOS los paneles ya
  // fetcheados (Home + Panel) — sin refetch, dato real que ya tenemos en memoria.
  const selectedRow = computed<PanelRow | null>(() => {
    const sym = selectedSymbol();
    return sym ? findCachedRow(sym) : null;
  });

  // Tenencias de Cartera: posición NETA por symbol (compras - ventas),
  // valuada contra el precio REAL cacheado (nunca el simulado) — fallback al
  // costo promedio con badge "estimado" si el símbolo no está en ningún
  // panel. costoPromedio es el costo ponderado de TODAS las compras
  // históricas (no se recalcula al vender, método estándar de costo
  // promedio); si la cantidad neta llega a 0 el symbol desaparece (sigue en
  // Movimientos, ver movimientosOrdenados).
  const tenencias = computed<TenenciaRow[]>(() => {
    const bySymbol = new Map<string, SimulatedMovement[]>();
    for (const m of simulatedMovements()) {
      const list = bySymbol.get(m.symbol) ?? [];
      list.push(m);
      bySymbol.set(m.symbol, list);
    }
    const rows: TenenciaRow[] = [];
    for (const [symbol, movs] of bySymbol) {
      const compras = movs.filter((m) => m.tipo === 'compra');
      const cantidadCompras = compras.reduce((s, m) => s + m.cantidad, 0);
      const cantidadVentas = movs.filter((m) => m.tipo === 'venta').reduce((s, m) => s + m.cantidad, 0);
      const cantidadNeta = cantidadCompras - cantidadVentas;
      if (cantidadNeta <= 0) continue;
      const costoPromedio = cantidadCompras > 0 ? compras.reduce((s, m) => s + m.monto, 0) / cantidadCompras : 0;
      const row = findCachedRow(symbol);
      const precioActual = row ? price(row) : costoPromedio;
      rows.push({
        symbol,
        instrumento: movs[0].instrumento,
        cantidad: cantidadNeta,
        precioPromedio: costoPromedio,
        valorActual: cantidadNeta * precioActual,
        pnl: cantidadNeta * precioActual - costoPromedio * cantidadNeta,
        estimado: !row,
      });
    }
    return rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  });

  // Tope duro de Vender: cantidad neta actual en Tenencias del symbol del
  // Ticket. Infinity fuera de modo venta, para no ramificar el clamp en
  // setCantidad/incCantidad.
  const maxVendible = computed<number>(() => {
    if (ticketTipo() !== 'venta') return Infinity;
    const symbol = selectedSymbol();
    if (!symbol) return 0;
    return tenencias().find((t) => t.symbol === symbol)?.cantidad ?? 0;
  });

  // Movimientos de Cartera, más reciente primero.
  const movimientosOrdenados = computed<SimulatedMovement[]>(() =>
    [...simulatedMovements()].sort((a, b) => b.timestamp - a.timestamp)
  );

  // Header resumen de Cartera (3 números protagonistas, ver JSX). Total
  // invertido = costo de la posición NETA actual (costoPromedio × cantidad de
  // cada tenencia), no el bruto histórico de compras — una venta reduce este
  // número. Ganancia total = mismo cálculo que Tenencias (valor actual real -
  // costo de la posición). Variación de hoy = pct_change diario de cada panel
  // cacheado aplicado al valor actual de cada tenencia y sumado (0 para
  // símbolos "estimado", que no tienen pct_change real).
  const resumenCartera = computed<{ totalInvertido: number; gananciaTotal: number; variacionHoy: number; variacionHoyPct: number }>(() => {
    const tenenciasList = tenencias();
    const totalInvertido = tenenciasList.reduce((s, t) => s + t.precioPromedio * t.cantidad, 0);
    const gananciaTotal = tenenciasList.reduce((s, t) => s + t.pnl, 0);
    let variacionHoy = 0;
    for (const t of tenenciasList) {
      const row = findCachedRow(t.symbol);
      if (row) variacionHoy += t.valorActual * ((row.pct_change || 0) / 100);
    }
    const valorActualTotal = tenenciasList.reduce((s, t) => s + t.valorActual, 0);
    const valorAyerTotal = valorActualTotal - variacionHoy;
    const variacionHoyPct = valorAyerTotal > 0 ? (variacionHoy / valorAyerTotal) * 100 : 0;
    return { totalInvertido, gananciaTotal, variacionHoy, variacionHoyPct };
  });

  // Serie transformada al formato de TradingView Lightweight Charts
  // (BaselineSeries): time en UNIX epoch SEGUNDOS (Math.floor(ms/1000)),
  // value = cierre real (ultimoPrecio — IOL no trae campo "cierre"; en una
  // serie diaria el último precio de cada día ES el cierre de esa rueda,
  // ver operar.types.ts). Fuente exclusiva: historicoData(), que ya llena
  // loadHistorico() con la cadena real Cohen → IOL — nunca datos mock. Se
  // reordena estrictamente ascendente por tiempo (TradingView exige orden
  // cronológico estricto, sin duplicados) aunque historicoData() ya venga
  // ordenado — dedupe por si dos puntos cayeran en el mismo segundo.
  const chartBaselineData = computed<ChartBaselinePoint[]>(() => {
    const d = historicoData();
    const seen = new Set<number>();
    const points: ChartBaselinePoint[] = [];
    for (const p of d) {
      const ms = new Date(p.fechaHora).getTime();
      if (isNaN(ms)) continue;
      const time = Math.floor(ms / 1000) as UTCTimestamp;
      if (seen.has(time)) continue;
      seen.add(time);
      points.push({ time, value: +p.ultimoPrecio || 0 });
    }
    return points.sort((a, b) => a.time - b.time);
  });

  // Instancias de gráfico (ex `private fichaChart`/`private ticketChart`).
  // Ficha y Ticket comparten los mismos historicoData()/chartRango(), pero
  // cada subvista tiene su propia instancia de gráfico — ver
  // createOrUpdateChart(). Sólo uno de los dos contenedores está en el DOM a
  // la vez según subview(), por eso cada instancia se crea/destruye
  // perezosamente cuando su contenedor aparece.
  // lastTime: último UNIX timestamp (segundos) escrito en la serie — arranca
  // en el último punto histórico (setData) y lo pisa cada tick en vivo
  // (update, ver pushLiveTick) para poder exigir tiempo no-decreciente
  // (TradingView tira error si update() llega con un time menor al último).
  interface ChartInstance {
    chart: IChartApi;
    series: ISeriesApi<'Baseline'>;
    el: HTMLElement;
    lastTime: UTCTimestamp | null;
  }
  const charts: Record<'fichaChart' | 'ticketChart', ChartInstance | null> = {
    fichaChart: null,
    ticketChart: null,
  };

  // Crea (una sola vez por contenedor) o actualiza el BaselineSeries con los
  // datos reales vigentes. baseValue = primer precio de la serie cargada
  // (pedido explícito: rendimientos sobre ese precio inicial en verde/rojo).
  // `lwc` es el módulo lightweight-charts ya cargado en runtime por el
  // componente (`await import(...)`) — nunca se importa arriba, no es SSR-safe.
  function createOrUpdateChart(
    lwc: LightweightCharts,
    ref: 'fichaChart' | 'ticketChart',
    containerRef: { current: HTMLElement | null },
  ) {
    const el = containerRef.current;
    const data = chartBaselineData();
    if (!el || data.length < 2) return;
    const rango = chartRango();

    let instance = charts[ref];
    // El contenedor es un render condicional — React lo destruye/recrea cada
    // vez que chartBaselineData().length cae por debajo de 2 (o cambia de
    // subvista y vuelve). Si el <div> real cambió, la instancia vieja quedó
    // apuntando a un nodo fuera del DOM: se descarta y se crea una nueva
    // sobre el actual.
    if (instance && instance.el !== el) {
      instance.chart.remove();
      instance = null;
      charts[ref] = null;
    }
    if (!instance) {
      const chart = lwc.createChart(el, {
        autoSize: true,
        layout: {
          background: { color: 'transparent' },
          textColor: '#78787f', // var(--ink-3)
        },
        grid: {
          vertLines: { visible: false },
          horzLines: { color: '#f3f4f6' },
        },
        rightPriceScale: { borderColor: '#e4e3df' }, // var(--line)
        timeScale: {
          borderColor: '#e4e3df',
          borderVisible: false,
          secondsVisible: false,
          // rightOffset: margen de confort fijo a la derecha del último
          // punto real (en unidades de barra, no píxeles) — ajustado según rango
          rightOffset: 12,
          // fixRightEdge/fixLeftEdge: permiten cierto margen de scroll más allá
          // de los datos para mejor experiencia de usuario
          fixRightEdge: false,
          fixLeftEdge: false,
          // lockVisibleTimeRangeOnResize: mantiene el rango visible al redimensionar
          lockVisibleTimeRangeOnResize: true,
          // tickMarkFormatter: evalúa tickMarkType (igual que TradingView
          // internamente) para que cada TIPO de marca tenga su propio
          // formato — nunca fechas repetidas en fila. En 6M/1A/MAX
          // timeVisible queda en false (ver aplicación más abajo), así que
          // TradingView NUNCA pide Time/TimeWithSeconds para esas vistas;
          // en 1S/1M sí puede pedirlas al hacer zoom profundo intradía.
          //   - Time/TimeWithSeconds (zoom profundo, sólo 1S/1M): "14:00".
          //   - DayOfMonth (marca diaria — el caso normal de 1S/1M): "15 jul"
          //     — un día por marca, nunca duplicado en la fila.
          //   - Month/Year (rangos largos 6M/1A/MAX): "jul" / "2026".
          tickMarkFormatter: (time: Time, tickMarkType: TickMarkType) => {
            const ms = typeof time === 'number' ? time * 1000 : new Date(String(time)).getTime();
            const d = new Date(ms);
            if (isNaN(d.getTime())) return '';
            switch (tickMarkType) {
              case lwc.TickMarkType.Year:
                return d.toLocaleDateString('es-AR', { year: 'numeric' });
              case lwc.TickMarkType.Month:
                return d.toLocaleDateString('es-AR', { month: 'short' });
              case lwc.TickMarkType.DayOfMonth:
                return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' }); // "15 jul"
              case lwc.TickMarkType.Time:
              case lwc.TickMarkType.TimeWithSeconds:
                return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
              default:
                return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
            }
          },
        },
        crosshair: { mode: 1 }, // Magnet
      });
      const series = chart.addSeries(lwc.BaselineSeries, {
        baseValue: { type: 'price', price: data[0].value },
        topLineColor: 'rgba(38, 166, 154, 1)',
        topFillColor1: 'rgba(38, 166, 154, 0.28)',
        bottomLineColor: 'rgba(239, 83, 80, 1)',
        bottomFillColor1: 'rgba(239, 83, 80, 0.28)',
      });
      instance = { chart, series, el, lastTime: null };
      charts[ref] = instance;
    } else {
      instance.series.applyOptions({ baseValue: { type: 'price', price: data[0].value } });
    }
    // timeVisible se reaplica en cada render (no sólo al crear el chart):
    // el mismo chart/instancia se reusa entre clicks de rango (1S -> 6M sin
    // recrear el <div>), así que si no se reafirma acá, un click a 6M
    // después de haber estado en 1S dejaría timeVisible:true pisado del
    // rango anterior y podría filtrar horas donde NO deben aparecer.
    instance.chart.applyOptions({
      timeScale: { timeVisible: INTRADAY_RANGOS.has(rango) },
    });
    instance.series.setData(data);
    instance.lastTime = data[data.length - 1].time;
    applyRangoVisibleRange(instance.chart, rango, data);
  }

  // Aplica la ventana visible según el botón de rango activo — SIEMPRE
  // anclada al ÚLTIMO DATO REAL de la serie (data[data.length-1].time), NUNCA
  // a "hoy"/Date.now() (que puede ser fin de semana/feriado sin rueda, o
  // simplemente no coincidir con el último punto real si el feed viene
  // atrasado): así "to" jamás es una fecha futura sin datos.
  //   - MAX: fitContent() nativo — encaja todo el historial disponible de
  //     punta a punta, tal cual pide la consigna.
  //   - 1S/1M/6M/1A: setVisibleRange({ from, to }) con `to` = último dato
  //     real y `from` = ese mismo timestamp menos la ventana de calendario
  //     exacta (7 días / 1 mes / 6 meses / 1 año, ver rangoFechaDesde).
  //     setVisibleRange ya "clampea" from/to a los datos existentes (ver
  //     docs de TradingView), así que si la serie real es más corta que la
  //     ventana pedida (símbolo con poco historial) no rompe, sólo muestra
  //     lo que hay — nunca inventa ni extrapola.
  function applyRangoVisibleRange(chart: IChartApi, rango: ChartRango, data: ChartBaselinePoint[]) {
    if (rango === 'MAX') {
      chart.timeScale().fitContent();
      return;
    }
    const lastTime = data[data.length - 1].time;
    const from = Math.floor(rangoFechaDesde(rango, new Date(lastTime * 1000)).getTime() / 1000) as UTCTimestamp;
    chart.timeScale().setVisibleRange({ from, to: lastTime });
  }

  // Tick real en vivo (WebSocket/polling de Cohen/IOL ya activo en la
  // plataforma, ver liveTick más abajo) → series.update(), NUNCA
  // setData(): update() es O(1) y anima el último tramo de la curva sin
  // redibujar toda la serie ni resetear el zoom/scroll del usuario — llamar
  // a setData() en cada tick (varias veces por segundo) degradaría el
  // rendimiento y cortaría la animación, tal como pide la consigna.
  // TradingView exige tiempo no-decreciente en update(): si el tick real
  // llega con un timestamp <= lastTime (reloj del cliente atrasado respecto
  // al último punto histórico, o dos ticks en el mismo segundo), se
  // redondea a lastTime+1s en vez de descartarlo silenciosamente.
  function pushLiveTick(ref: 'fichaChart' | 'ticketChart', point: ChartBaselinePoint) {
    const instance = charts[ref];
    if (!instance) return;
    const time = (instance.lastTime != null && point.time <= instance.lastTime
      ? (instance.lastTime + 1) as UTCTimestamp
      : point.time);
    instance.series.update({ time, value: point.value });
    instance.lastTime = time;
  }

  // Último tick real empujado al gráfico (symbol+precio) — dedupe para no
  // llamar update() de nuevo si el polling trajo el mismo precio sin cambios
  // (loadHome() re-corre cada 20s aunque el precio no haya movido).
  let lastLiveTick: { symbol: string; value: number } | null = null;

  // Feed en tiempo real: reacciona a selectedRow() (precio real cacheado de
  // acciones/cedears/bonos, refrescado por el polling de 20s de loadHome()
  // — mismo feed real IOL que ya está activo en la plataforma, sin
  // WebSocket propio para esto). Cada vez que el precio real del symbol
  // seleccionado cambia, empuja un tick real vía series.update() (nunca
  // setData()) al gráfico que esté montado (Ficha o Ticket). Si letras/ONs/
  // US$ no tienen polling propio (fetch único, ver ensurePanelData), esta
  // señal simplemente no dispara ticks nuevos para esos symbols — cero
  // datos inventados, sólo lo que el feed real entrega.
  function liveTick() {
    const row = selectedRow();
    const view = subview();
    const symbol = selectedSymbol();
    if (!row || !symbol || (view !== 'ficha' && view !== 'ticket')) return;
    const value = price(row);
    if (!(value > 0)) return;
    if (lastLiveTick?.symbol === symbol && lastLiveTick.value === value) return;
    lastLiveTick = { symbol, value };
    const point: ChartBaselinePoint = { time: Math.floor(Date.now() / 1000) as UTCTimestamp, value };
    pushLiveTick('fichaChart', point);
    pushLiveTick('ticketChart', point);
  }

  // Precio efectivo del Paso 1: precio límite si el usuario eligió esa
  // modalidad; si no, el lado del libro que corresponde según la dirección:
  // comprar paga la punta Venta (px_ask), vender cobra la punta Compra
  // (px_bid) — con el fallback de último cierre si el libro está vacío (ver
  // bookAskPx/bookBidPx).
  const precioEfectivo = computed<number>(() => {
    const s = ticketState();
    if (s.tipoPrecio === 'limite') return s.precioLimite ?? 0;
    return ticketTipo() === 'venta' ? bookBidPx(selectedRow()) : bookAskPx(selectedRow());
  });

  // El monto tipeado no alcanza para 1 nominal entero al precio efectivo:
  // se muestra un aviso en vez de dejar el monto en 0 silenciosamente.
  const montoBelowMinimum = computed<boolean>(() => {
    const s = ticketState();
    const px = precioEfectivo();
    return !!s.monto && s.monto > 0 && px > 0 && Math.floor(s.monto / px) === 0;
  });

  // Monto estimado para el resumen del Paso 2: si el usuario cargó un monto
  // en el Paso 1 se respeta tal cual; si no, se estima cantidad × precio efectivo.
  const montoEstimado = computed<number>(() => {
    const s = ticketState();
    if (s.monto && s.monto > 0) return s.monto;
    return s.cantidad * precioEfectivo();
  });

  // Limpieza de los charts de TradingView al destruir el componente (salir
  // de /operar) — evita memory leaks (listeners de resize, canvas, etc. que
  // la librería no libera sola si el <div> anfitrión desaparece del DOM).
  // (ex ngOnDestroy)
  function destroyCharts() {
    charts.fichaChart?.chart.remove();
    charts.ticketChart?.chart.remove();
    charts.fichaChart = null;
    charts.ticketChart = null;
  }

  // Cierra el dropdown custom de instrumento (ver .op-dropdown) al clickear
  // afuera (ex @HostListener('document:click')).
  function closeDropdowns() {
    if (dropdownOpenLeft()) dropdownOpenLeft.set(false);
    if (dropdownOpenRight()) dropdownOpenRight.set(false);
  }

  function defaultTicketState(): TicketState {
    return { tipoPrecio: 'mercado', precioLimite: null, plazo: 't1', cantidad: 0, monto: null };
  }

  async function loadHome() {
    // catchError(() => of([])) → .catch(() => []). Ver httpGet: el throw
    // manual en !res.ok es lo que hace que estos catch se disparen igual que
    // con HttpClient.
    const [acciones, cedears, bonos] = await Promise.all([
      httpGet<PanelRow[]>('/api/iol/panel?id=acciones').catch(() => [] as PanelRow[]),
      // CEDEARs: el panel de IOL no soporta id=cedears (ver docs/api-iol.md §3.1);
      // el libro real sale de api/iol/cedears.js (§3.2), mismo feed que usa Arbitraje.
      httpGet<CedearRow[]>(iolCedearsUrl('H24')).catch(() => [] as CedearRow[]),
      httpGet<PanelRow[]>('/api/iol/panel?id=bonos').catch(() => [] as PanelRow[]),
    ]);
    accionesRows.set(Array.isArray(acciones) ? acciones : []);
    cedearsRows.set(Array.isArray(cedears) ? cedears : []);
    bonosRows.set(Array.isArray(bonos) ? bonos : []);
  }

  // Fondos (FCI): fetch propio, separado de loadHome() — sin fallback real
  // posible (data912 no cubre FCIs, ver comentario del template op-fondos),
  // así que un error acá se comunica con fondosError() en vez de dejar
  // fondosRows() vacío indistinguible de "todavía cargando" o "0 fondos".
  async function loadFondos() {
    fondosLoading.set(true);
    fondosError.set(false);
    const rows = await httpGet<FondoRow[]>('/api/iol/fondos').catch(() => null);
    fondosLoading.set(false);
    if (!Array.isArray(rows)) {
      fondosError.set(true);
      return;
    }
    fondosRows.set(rows);
  }

  // Label legible del tipoFondo real de IOL (ver FONDO_TIPO_LABEL) — fallback
  // al valor crudo si aparece algún tipoFondo no mapeado todavía, en vez de
  // ocultarlo.
  function fondoTipoLabel(tipoFondo: string | null): string {
    if (!tipoFondo) return '—';
    return FONDO_TIPO_LABEL[tipoFondo] ?? tipoFondo;
  }

  // Filas duplicadas para el marquee del carrusel de Fondos: el track
  // renderiza la lista DOS veces y la animación corre a translateX(-50%),
  // así el loop es continuo sin salto (ver .op-fondos-carousel en Operar.css).
  const fondosTicker = computed<FondoRow[]>(() => {
    const rows = fondosRows();
    return rows.length ? [...rows, ...rows] : [];
  });

  // Encabezado simplificado para el carrusel: saca sufijos que no aportan en
  // un ticker compacto ("FCI", "En Pesos", "Fondo De Dinero") y normaliza
  // los nombres que IOL manda EN MAYÚSCULAS (ej. "ADCAP BALANCEADO X") a
  // Title Case. Sólo se tocan palabras de 4+ mayúsculas: siglas cortas como
  // "IOL" y números romanos ("X", "XVI") quedan como están.
  function fondoShortName(name: string): string {
    const cleaned = name
      .replace(/\s+FCI$/i, '')
      .replace(/\s+En Pesos$/i, '')
      .replace(/\s+Fondo De Dinero$/i, '')
      .trim();
    return cleaned.replace(/[A-ZÁÉÍÓÚÜÑ]{4,}/g, (w) => w.charAt(0) + w.slice(1).toLowerCase());
  }

  function price(row: PanelRow | CedearRow | null | undefined): number {
    const px = +(row as any)?.px_bid;
    if (px > 0) return px;
    return +(row as any)?.c || 0;
  }

  // Busca un symbol en TODOS los paneles ya fetcheados (Home + Panel + Ficha
  // US$) — sin refetch, dato real que ya tenemos en memoria. Usado por Ficha
  // (selectedRow) y por Tenencias de Cartera para valuar al precio actual.
  function findCachedRow(symbol: string): PanelRow | null {
    const all: PanelRow[] = [
      ...accionesRows(), ...cedearsRows(), ...bonosRows(),
      ...letrasRows(), ...onsRows(), ...usaRows(),
    ];
    return all.find((r) => r.symbol === symbol) ?? null;
  }

  // Instrumento del symbol para un SimulatedMovement: usa el instrumento de
  // Panel si el Ticket se abrió navegando por una pill; si vino de la
  // búsqueda de Home (selectedInstrumentId sin setear) lo infiere buscando en
  // qué panel cacheado está el símbolo, con 'acciones' de última instancia.
  function inferInstrumento(symbol: string): OperarInstrumento {
    const id = selectedInstrumentId();
    if (id) return id;
    if (accionesRows().some((r) => r.symbol === symbol)) return 'acciones';
    if (cedearsRows().some((r) => r.symbol === symbol)) return 'cedears';
    if (bonosRows().some((r) => r.symbol === symbol)) return 'bonos';
    if (letrasRows().some((r) => r.symbol === symbol)) return 'letras';
    if (onsRows().some((r) => r.symbol === symbol)) return 'ons';
    return 'acciones';
  }

  // Libro sin puntas activas (mercado cerrado). Se usa para mostrar el
  // fallback de último cierre en el mini-libro en vez de "$0,00".
  function bookIsEmpty(row: PanelRow | CedearRow | null | undefined): boolean {
    return (+(row as any)?.q_bid || 0) === 0 && (+(row as any)?.q_ask || 0) === 0;
  }

  function lastClose(row: PanelRow | CedearRow | null | undefined): number {
    return +(row as any)?.c || 0;
  }

  function bookBidPx(row: PanelRow | CedearRow | null | undefined): number {
    return bookIsEmpty(row) ? lastClose(row) : +(row as any)?.px_bid || 0;
  }

  function bookAskPx(row: PanelRow | CedearRow | null | undefined): number {
    return bookIsEmpty(row) ? lastClose(row) : +(row as any)?.px_ask || 0;
  }

  function selectInstrument(id: InstrumentId) {
    selectedInstrumentId.set(id);
    subview.set('panel');
    panelQuery.set('');
    panelCurrency.set('ars');
    panelSort.set({ column: 'symbol', dir: 'asc' });
    panelSubTab.set(id === 'bonos' ? 'usd' : 'lider');
    ensurePanelData(id);
  }

  // Dropdown de instrumento de cada columna del panel de Acciones (ver
  // homeRowsLeft/homeRowsRight, pedido de Elio): a diferencia de
  // selectInstrument() NO navega a Panel, cambia el instrumento mostrado en
  // esa columna sin salir de Home, y persiste la elección en localStorage
  // (ver operar-storage.ts) para que no se resetee al recargar. Reusa
  // ensurePanelData() para el mismo fetch lazy de Letras/ONs que ya usa
  // Panel (cacheado en lazyFetched, nunca se re-fetchea) — Acciones/Cedears/
  // Bonos ya vienen precargados por loadHome().
  function selectHomeInstrumentLeft(id: InstrumentId) {
    homeInstrumentLeft.set(id);
    saveHomeColLeft(id);
    ensurePanelData(id);
  }

  function selectHomeInstrumentRight(id: InstrumentId) {
    homeInstrumentRight.set(id);
    saveHomeColRight(id);
    ensurePanelData(id);
  }

  // Letras/ONs no vienen del prefetch de Home: fetch propio, una sola vez por
  // id (cacheado en lazyFetched). Acciones/Cedears/Bonos ya están cacheados
  // por loadHome() — no se re-fetchean acá.
  function ensurePanelData(id: InstrumentId) {
    if (id !== 'letras' && id !== 'ons') return;
    if (lazyFetched.has(id)) return;
    lazyFetched.add(id);
    void (async () => {
      const rows = await httpGet<PanelRow[]>(`/api/iol/panel?id=${id}`).catch(() => [] as PanelRow[]);
      const arr = Array.isArray(rows) ? rows : [];
      if (id === 'letras') letrasRows.set(arr);
      else onsRows.set(arr);
    })();
  }

  function isCurrencyDisabled(id: CurrencyPillId): boolean {
    if (id === 'usdc') return true; // sin panel real todavía
    if (id === 'usd') return selectedInstrumentId() !== 'acciones';
    return false;
  }

  function selectCurrency(id: CurrencyPillId) {
    if (isCurrencyDisabled(id)) return;
    panelCurrency.set(id);
    if (id === 'usd') ensureUsaData();
  }

  function ensureUsaData() {
    if (usaFetched) return;
    usaFetched = true;
    void (async () => {
      const rows = await httpGet<PanelRow[]>('/api/iol/panel?id=usa').catch(() => [] as PanelRow[]);
      usaRows.set(Array.isArray(rows) ? rows : []);
    })();
  }

  function toggleSort(column: PanelSortColumn) {
    panelSort.update((s) => (s.column === column ? { column, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { column, dir: 'asc' }));
  }

  function sortArrow(column: PanelSortColumn): string {
    const s = panelSort();
    if (s.column !== column) return '';
    return s.dir === 'asc' ? '▲' : '▼';
  }

  // REGLA 1 (bypass de vistas intermedias): clickear un activo en cualquier
  // listado (buscador, Destacados, Home, Panel) ya NO abre Ficha — navega
  // directo a /operar/{ticker}, que hidrata la pantalla de orden completa
  // (gráfico + Puntas + formulario, ver hydrateFromRoute arriba). Sin
  // resumen previo ni paso intermedio entre el click y la orden.
  function selectSymbol(row: { symbol: string }) {
    goToOrder(row.symbol, 'compra', 'home');
  }

  // Navegación real por Router (REGLA 1/2 del refactor): el onClick invoca
  // directo la ruta de operación con el ticker por parámetro — el router de
  // Next monta app/operar/[ticker]/page.tsx, que pasa el ticker como prop, y
  // hydrateFromRoute monta el gráfico/Puntas/Orden ya resueltos, sin pasar
  // por ningún estado intermedio en memoria.
  function goToOrder(symbol: string, tipo: TicketTipoOperacion, origin: 'ficha' | 'cartera' | 'panel' | 'home') {
    navigate(`/operar/${encodeURIComponent(symbol)}?tipo=${tipo}&origin=${origin}`);
  }

  // Click en un botón de temporalidad (1S/1M/6M/1A/MÁX): actualiza el estado
  // visual activo (chartRango(), ver la clase `on` en el JSX) y dispara el
  // re-fetch real vía el efecto `fichaFetch` (mismo mecanismo ya usado para
  // symbol — cambiar chartRango() re-ejecuta loadHistorico con el rango
  // nuevo). Limpia cualquier aviso de "sin datos" del rango anterior: cada
  // click arranca su propio ciclo de fetch/aviso.
  function selectRango(r: ChartRango) {
    historicoAviso.set(null);
    chartRango.set(r);
  }

  // Serie histórica (Ficha/Ticket): Cohen es la fuente PRIMARIA (get_trade_history
  // vía Primary/XOMS, ver docs/api-cohen.md §2/§5); si el feed de Cohen no
  // está configurado, falla o devuelve vacío/null (símbolo sin trades en el
  // rango, feed caído, plazo sin universo), cae a IOL — mismo patrón
  // Cohen→IOL que ya usa fetchCedears() en el store del shell. Regla 1: un []
  // o null de Cohen NUNCA se considera respuesta válida, siempre dispara el
  // fallback a IOL (ver la cascada abajo).
  //
  // Regla 3 (invariabilidad): si IOL TAMBIÉN devuelve [] para el rango nuevo
  // (ej. 1S cayendo en un fin de semana largo sin ruedas, feed caído), NO se
  // pisa historicoData() con un arreglo vacío ni se inventa nada — se
  // CONSERVAN los últimos datos válidos ya cargados y se muestra un aviso
  // amigable (historicoAviso) arriba del gráfico vigente.
  async function loadHistorico(symbol: string, rango: ChartRango) {
    const key = `${symbol}:${rango}`;
    const cached = historicoCache.get(key);
    if (cached) {
      historicoData.set(cached);
      historicoAviso.set(null);
      return;
    }
    historicoLoading.set(true);
    // Ventana de calendario real del rango (1 semana/mes/semestre/año/
    // quinquenio hacia atrás desde hoy, ver rangoFechaDesde) — `dias` para
    // Cohen (cohenHistoricoUrl pide un entero de días, contrato sin tocar)
    // se deriva de esa ventana en vez de un multiplicador fijo, así que
    // "1M" siempre es un mes calendario real (28-31 días), no "30 días fijos".
    const desde = rangoFechaDesde(rango);
    const hasta = new Date();
    const dias = Math.max(1, Math.ceil((hasta.getTime() - desde.getTime()) / 86_400_000));

    const fetchIol = async (): Promise<HistoricoPoint[]> => {
      try {
        const points = await httpGet<HistoricoPoint[]>(
          `/api/iol/historico?mercado=bCBA&simbolo=${encodeURIComponent(symbol)}&rango=${rango}`
        );
        return Array.isArray(points) ? points : [];
      } catch (e) {
        // Sin este log, un 404/500 del proxy queda indistinguible de "sin
        // datos" (array vacío legítimo) — costó un diagnóstico entero
        // encontrar que esto tapaba un 404 real. El fallback a [] sigue
        // igual, pero el error ya no es mudo.
        // OJO: esto sólo funciona porque httpGet() TIRA el error en !res.ok
        // (fetch, a diferencia de HttpClient, resuelve normal con 4xx/5xx).
        const err = e as HttpError;
        console.error('[Ficha] error cargando histórico (IOL)', {
          symbol, rango, desde: ymd(desde), hasta: ymd(hasta), status: err.status, body: err.error,
        });
        return [];
      }
    };

    const cohenUrl = cohenHistoricoUrl(symbol, 'H24', dias);
    let points: HistoricoPoint[];
    if (cohenUrl) {
      // Regla 1: [] o null de Cohen no es respuesta válida → cae a IOL.
      const raw = await httpGet<HistoricoPoint[]>(cohenUrl).catch(() => [] as HistoricoPoint[]);
      const cohen = Array.isArray(raw) ? raw : [];
      points = cohen.length ? cohen : await fetchIol();
    } else {
      points = await fetchIol();
    }

    historicoLoading.set(false);
    const raw = Array.isArray(points) ? points : [];
    if (!raw.length) {
      // Regla 3: ni Cohen ni IOL trajeron datos para este rango — se deja
      // historicoData() (y por lo tanto el gráfico) EXACTAMENTE como
      // estaba, no se cachea el vacío (para reintentar en el próximo
      // click a este mismo rango) y se avisa sin romper nada.
      historicoAviso.set(`Sin cotizaciones de ${symbol} en el rango ${rango}. Se muestran los últimos datos disponibles.`);
      return;
    }
    // Ambas fuentes pueden venir en cualquier orden (IOL: más reciente
    // primero; Cohen: ascendente por construcción, ver feed.py). Se
    // normaliza siempre a orden cronológico ascendente (viejo -> nuevo,
    // izq -> der).
    const arr = raw.slice().sort((a, b) => new Date(a.fechaHora).getTime() - new Date(b.fechaHora).getTime());
    historicoCache.set(key, arr);
    historicoData.set(arr);
    historicoAviso.set(null);
  }

  // Si Ficha se abrió desde Panel (hay instrumento elegido) volvemos a Panel;
  // si vino de la búsqueda de Home (sin instrumento), volvemos a Home.
  function goBackFromFicha() {
    subview.set(selectedInstrumentId() ? 'panel' : 'home');
  }

  function goTicket() {
    const symbol = selectedSymbol();
    if (!symbol) return;
    goToOrder(symbol, 'compra', 'ficha');
  }

  // Desde Tenencias de Cartera (ver toggleTenenciaExpandida): navega directo
  // a la orden (ya no abre un Ticket "in-memory" sin ruta), tipo='compra'/
  // 'venta' según la acción.
  function comprarMasDesdeCartera(symbol: string) {
    goToOrder(symbol, 'compra', 'cartera');
  }

  function venderDesdeCartera(symbol: string) {
    goToOrder(symbol, 'venta', 'cartera');
  }

  // Botón "Comprar" directo desde una fila de Panel o de Home (Acciones/
  // Destacados/buscador): REGLA 1 — bypassea Ficha y cualquier resumen
  // previo, navega directo a /operar/{ticker} (ver goToOrder). origin
  // decide a dónde vuelve "← Volver" (goBackFromTicketForm).
  function comprarDirecto(symbol: string, origin: 'panel' | 'home') {
    goToOrder(symbol, 'compra', origin);
  }

  function openTicket(tipo: TicketTipoOperacion, symbol: string, origin: 'ficha' | 'cartera' | 'panel' | 'home') {
    selectedSymbol.set(symbol);
    ticketTipo.set(tipo);
    ticketOrigin.set(origin);
    ticketStep.set('form');
    ticketState.set(defaultTicketState());
    ticketAccepted.set(false);
    ticketBannerShown.set(false);
    subview.set('ticket');
  }

  // Vuelve a donde se abrió el Ticket (ver openTicket): Ficha si vino del
  // botón "Comprar" de una ficha, Cartera si vino de Tenencias, o Panel/Home
  // si vino del botón "Comprar" directo de una fila (ver comprarDirecto).
  function goBackFromTicketForm() {
    const dest = ticketOrigin();
    subview.set(dest);
    // Vuelve a home cuando la orden se abrió por navegación directa (ver
    // goToOrder) — saca al usuario de /operar/{ticker} para que la URL
    // refleje la vista real. Cartera/Panel siguen resolviéndose en memoria
    // (no tienen ruta propia todavía), sólo home limpia el path.
    if (dest === 'home' || dest === 'panel') navigate('/operar');
  }

  function toggleTenenciaExpandida(symbol: string) {
    tenenciaExpandida.set(tenenciaExpandida() === symbol ? null : symbol);
  }

  function setTipoPrecio(t: TicketTipoPrecio) {
    ticketState.update((s) => ({ ...s, tipoPrecio: t }));
    syncMontoFromCantidad();
  }

  function setPrecioLimite(v: number) {
    ticketState.update((s) => ({ ...s, precioLimite: +v >= 0 ? +v : 0 }));
    syncMontoFromCantidad();
  }

  function setPlazo(p: TicketPlazo) {
    ticketState.update((s) => ({ ...s, plazo: p }));
  }

  // Cantidad es el campo primario: cada cambio recalcula Monto = cantidad ×
  // precioEfectivo (columna Venta o límite, ver precioEfectivo()). En modo
  // venta, tope duro = maxVendible() — no se puede cargar más de lo que hay
  // en Tenencias (ver `disabled` del botón + / hint "Disponible" en el JSX).
  function incCantidad() {
    const px = precioEfectivo();
    ticketState.update((s) => {
      const cantidad = Math.min(maxVendible(), s.cantidad + 1);
      return { ...s, cantidad, monto: px > 0 ? cantidad * px : s.monto };
    });
  }

  function decCantidad() {
    const px = precioEfectivo();
    ticketState.update((s) => {
      const cantidad = Math.max(0, s.cantidad - 1);
      return { ...s, cantidad, monto: px > 0 ? cantidad * px : s.monto };
    });
  }

  function setCantidad(v: number) {
    const cantidad = Math.min(maxVendible(), Math.max(0, Math.floor(+v) || 0));
    const px = precioEfectivo();
    ticketState.update((s) => ({ ...s, cantidad, monto: px > 0 ? cantidad * px : s.monto }));
  }

  // Monto es editable, pero nunca queda en un valor arbitrario: se recalcula
  // Cantidad = floor(monto / precioEfectivo) y con eso se vuelve a recalcular
  // Monto = cantidad × precioEfectivo (múltiplo entero de nominales). Si no
  // alcanza para 1 nominal, se conserva el valor tipeado (sin forzarlo a 0)
  // y el estado se comunica vía montoBelowMinimum() en el JSX.
  function setMonto(v: number) {
    const montoRaw = +v >= 0 ? +v : 0;
    const px = precioEfectivo();
    if (px <= 0) {
      ticketState.update((s) => ({ ...s, monto: montoRaw }));
      return;
    }
    const cantidad = Math.floor(montoRaw / px);
    if (cantidad <= 0) {
      ticketState.update((s) => ({ ...s, cantidad: 0, monto: montoRaw }));
      return;
    }
    ticketState.update((s) => ({ ...s, cantidad, monto: cantidad * px }));
  }

  // Sincroniza Monto tras un cambio de precio (tipo o límite) que no vino de
  // Cantidad/Monto directamente, para no dejar un monto stale que ya no
  // corresponda a cantidad × precioEfectivo.
  function syncMontoFromCantidad() {
    const px = precioEfectivo();
    if (px <= 0) return;
    ticketState.update((s) => (s.cantidad > 0 ? { ...s, monto: s.cantidad * px } : s));
  }

  function plazoLabel(id: TicketPlazo): string {
    return plazoOpts.find((p) => p.id === id)?.label ?? id;
  }

  // Fecha/hora relativa de un movimiento (tarjeta mobile de Movimientos).
  function relativeTime(ts: number): string {
    const min = Math.floor((Date.now() - ts) / 60000);
    if (min < 1) return 'ahora';
    if (min < 60) return `hace ${min} min`;
    const hs = Math.floor(min / 60);
    if (hs < 24) return `hace ${hs} h`;
    return `hace ${Math.floor(hs / 24)} d`;
  }

  // "Revisar orden" — deshabilitado con cantidad=0 (ver `disabled` en el JSX).
  function goTicketConfirmar() {
    if (ticketState().cantidad <= 0) return;
    ticketStep.set('confirmar');
  }

  // Conserva los valores cargados (ticketState no se resetea al volver).
  function goTicketForm() {
    ticketStep.set('form');
  }

  // Sin operatoria habilitada: cero request a IOL, sólo banner informativo.
  // Elio pidió que ADEMÁS quede una simulación completa (compra + cartera +
  // movimientos) en paralelo, para mostrar cómo se vería el producto
  // terminado — no reemplaza el banner de "no habilitado", lo complementa.
  function confirmarOperacion() {
    if (!ticketAccepted()) return;
    const symbol = selectedSymbol();
    if (symbol) {
      addMovement({
        symbol,
        instrumento: inferInstrumento(symbol),
        tipo: ticketTipo(),
        cantidad: ticketState().cantidad,
        precio: precioEfectivo(),
        monto: montoEstimado(),
        plazo: ticketState().plazo,
      });
      simulatedMovements.set(loadMovements());
    }
    ticketBannerShown.set(true);
  }

  function goHome() {
    subview.set('home');
    // Si estábamos en /operar/{ticker} (navegación directa, ver goToOrder),
    // limpia la URL a /operar para que quede consistente con la vista.
    if (ticker()) navigate('/operar');
  }

  function goCartera() {
    simulatedMovements.set(loadMovements());
    subview.set('cartera');
  }

  // Desde el link "Ver en Cartera" del banner de confirmación: arranca en
  // Movimientos para que el registro recién creado se vea de entrada.
  function goCarteraFromTicket() {
    carteraTab.set('movimientos');
    goCartera();
  }

  // TODO etapa siguiente: navegar a Ficha con el instrumento de la fila (AL30/Caución/Plazo fijo).
  function onRefRowClick(): void {}

  function fmt(v: number | null | undefined, dec = 2): string {
    if (v == null || !isFinite(v)) return '–';
    return v.toLocaleString('es-AR', { maximumFractionDigits: dec, minimumFractionDigits: dec });
  }

  return {
    // integración con React
    subscribe, getSnapshot, setNavigate,
    // inputs de ruta
    ticker, tipo, origin,
    // constantes
    pills, dolarStrip, currencyPills, chartRangos, tipoPrecioOpts, plazoOpts,
    instrumentoLabel, tenenciasFilterOptions,
    // signals
    subview, selectedInstrumentId, selectedSymbol, query,
    accionesRows, cedearsRows, bonosRows, letrasRows, onsRows, usaRows,
    fondosRows, fondosLoading, fondosError,
    panelQuery, panelCurrency, panelSubTab, panelSort,
    chartRango, historicoData, historicoLoading, historicoAviso, fichaBookOpen,
    ticketStep, ticketState, ticketAccepted, ticketBannerShown, ticketTipo, ticketOrigin,
    carteraTab, simulatedMovements, tenenciaExpandida, tenenciasFiltro,
    currentMoverIndex,
    homeInstrumentLeft, homeInstrumentRight, dropdownOpenLeft, dropdownOpenRight,
    // computeds
    tenenciasFiltradas, composicionCartera, searchResults,
    homeInstrumentLabelLeft, homeInstrumentLabelRight,
    homeRowsLeft, homeRowsRight, homePreviewMobileLeft, homePreviewMobileRight,
    destacados, topMover, rotatingMover, rotatingMoverList,
    selectedInstrumentLabel, panelSubTabs, panelRawRows, isGeneralEmpty,
    panelFilteredRows, panelSortedRows, selectedRow, tenencias, maxVendible,
    movimientosOrdenados, resumenCartera, chartBaselineData, fondosTicker,
    precioEfectivo, montoBelowMinimum, montoEstimado,
    // ciclo de vida / efectos
    hydrateFromStorage, prefetchHome, rotateMover, fichaFetch, hydrateFromRoute,
    liveTick, createOrUpdateChart, destroyCharts, closeDropdowns,
    // datos
    loadHome, loadFondos, ensurePanelData, loadHistorico,
    // métodos de UI
    pauseMoverRotation, resumeMoverRotation,
    toggleDropdownLeft, toggleDropdownRight, pickHomeInstrumentLeft, pickHomeInstrumentRight,
    fondoTipoLabel, fondoShortName, price, bookIsEmpty, lastClose, bookBidPx, bookAskPx,
    selectInstrument, selectHomeInstrumentLeft, selectHomeInstrumentRight,
    isCurrencyDisabled, selectCurrency, toggleSort, sortArrow, selectSymbol,
    selectRango, goBackFromFicha, goTicket, comprarMasDesdeCartera, venderDesdeCartera,
    comprarDirecto, goBackFromTicketForm, toggleTenenciaExpandida,
    setTipoPrecio, setPrecioLimite, setPlazo, incCantidad, decCantidad, setCantidad, setMonto,
    plazoLabel, relativeTime, goTicketConfirmar, goTicketForm, confirmarOperacion,
    goHome, goCartera, goCarteraFromTicket, onRefRowClick, fmt,
  };
}

type OperarStore = ReturnType<typeof createOperarStore>;

// Una instancia de store por montaje del componente (equivalente a los
// `signal()` de una clase de componente Angular). useRef y no useState porque
// no hace falta re-renderizar cuando se crea.
function useOperarStore(): OperarStore {
  const ref = useRef<OperarStore | null>(null);
  if (!ref.current) ref.current = createOperarStore();
  return ref.current;
}

// ────────────────────────────────────────────────────────────────────────────
// Componente (ex template inline de OperarComponent)
// ────────────────────────────────────────────────────────────────────────────
export interface OperarProps {
  /** Param de ruta `:ticker` (/operar/:ticker). Sin ticker → vista Home. */
  ticker?: string | null;
}

export default function Operar({ ticker = null }: OperarProps) {
  const st = useOperarStore();
  // Única suscripción a React: cualquier set()/update() de cualquier signal
  // del store incrementa la versión y re-renderiza (ver createOperarStore).
  useSyncExternalStore(st.subscribe, st.getSnapshot, st.getSnapshot);

  const router = useRouter();
  const searchParams = useSearchParams();
  // ?tipo=venta abre el formulario en modo venta en vez de compra (lo usa
  // "vender desde Cartera", ver venderDesdeCartera). ?origin decide a dónde
  // vuelve "← Volver". Mismos nombres/valores que los query params de Angular.
  const tipoParam = (searchParams.get('tipo') === 'venta' ? 'venta' : 'compra') as TicketTipoOperacion;
  const originRaw = searchParams.get('origin');
  const originParam = (originRaw === 'ficha' || originRaw === 'cartera' || originRaw === 'panel' || originRaw === 'home'
    ? originRaw
    : 'home') as 'ficha' | 'cartera' | 'panel' | 'home';

  // ex @ViewChild('fichaChartContainer' / 'ticketChartContainer')
  const fichaChartContainer = useRef<HTMLDivElement | null>(null);
  const ticketChartContainer = useRef<HTMLDivElement | null>(null);

  const {
    pills, dolarStrip, currencyPills, chartRangos, tipoPrecioOpts, plazoOpts,
    instrumentoLabel, tenenciasFilterOptions,
    subview, selectedSymbol, query, searchResults, selectSymbol,
    fondosRows, fondosTicker, fondoShortName,
    pauseMoverRotation, resumeMoverRotation, rotatingMoverList, comprarDirecto,
    goCartera, tenencias,
    dropdownOpenLeft, toggleDropdownLeft, homeInstrumentLabelLeft, homeInstrumentLeft,
    pickHomeInstrumentLeft, homeRowsLeft, homePreviewMobileLeft,
    dropdownOpenRight, toggleDropdownRight, homeInstrumentLabelRight, homeInstrumentRight,
    pickHomeInstrumentRight, homeRowsRight, homePreviewMobileRight,
    selectInstrument, goHome, selectedInstrumentLabel, panelQuery,
    panelCurrency, isCurrencyDisabled, selectCurrency, panelSubTabs, panelSubTab,
    isGeneralEmpty, panelSortedRows, toggleSort, panelSort, sortArrow,
    goBackFromFicha, selectedRow, chartRango, selectRango, historicoAviso,
    chartBaselineData, historicoLoading, fichaBookOpen, bookIsEmpty, bookBidPx, bookAskPx,
    goTicket, ticketStep, goBackFromTicketForm, ticketTipo, ticketState,
    setTipoPrecio, setPrecioLimite, setPlazo, maxVendible, setCantidad, decCantidad,
    incCantidad, montoBelowMinimum, precioEfectivo, setMonto, goTicketConfirmar,
    goTicketForm, plazoLabel, montoEstimado, ticketAccepted, ticketBannerShown,
    goCarteraFromTicket, confirmarOperacion, resumenCartera, carteraTab,
    composicionCartera, tenenciasFiltro, tenenciasFiltradas, toggleTenenciaExpandida,
    tenenciaExpandida, comprarMasDesdeCartera, venderDesdeCartera,
    movimientosOrdenados, relativeTime, fmt, price,
  } = st;

  // ── Efectos (ex effect()/ngOnDestroy/@HostListener) ───────────────────────
  // ORDEN: el mismo que el de creación de los effect() en el original —
  // Angular los corre en orden de creación y ese orden es semántico.

  // Router de Next inyectado en el store (ex `inject(Router)`).
  useEffect(() => {
    st.setNavigate((href) => router.push(href));
  }, [st, router]);

  // Estado persistido en localStorage (§6): en Angular vivía en los
  // inicializadores de los signals (`signal(loadMovements())`), acá va en el
  // montaje para no romper la hidratación. Declarado ANTES de prefetchHome,
  // que lee homeInstrumentLeft/Right para su fetch lazy.
  useEffect(() => {
    st.hydrateFromStorage();
  }, [st]);

  // ex `private prefetchHome = effect(...)`
  useEffect(() => {
    st.prefetchHome();
  }, [st, subview()]);

  // Polling de refresco automático (pedido: Destacados "en tiempo real"):
  // re-corre loadHome() cada 20s mientras el componente esté vivo, así
  // accionesRows/cedearsRows/bonosRows se refrescan solos y destacados()/
  // topMover() (computed sobre esas signals) reflejan precio/variación
  // nuevos sin que el usuario haga nada. Limpieza en el cleanup del efecto
  // (equivalente al takeUntilDestroyed(DestroyRef) del original) para no
  // dejar el timer corriendo si el usuario navega fuera de Operar.
  // (en Angular el timer se armaba dentro de prefetchHome; subview() arranca
  // siempre en 'home', así que arrancaba igual en el primer ciclo)
  useEffect(() => {
    const id = setInterval(() => { void st.loadHome(); }, 20_000);
    return () => clearInterval(id);
  }, [st]);

  // ex `private moverRotation = timer(4_500, 4_500).subscribe(...)`
  useEffect(() => {
    const id = setInterval(() => st.rotateMover(), 4_500);
    return () => clearInterval(id);
  }, [st]);

  // ex `private fichaFetch = effect(...)`
  useEffect(() => {
    st.fichaFetch();
  }, [st, selectedSymbol(), chartRango(), subview()]);

  // ex `private hydrateFromRoute = effect(...)` — se sincronizan primero los
  // "inputs" de ruta en el store (para que goHome() pueda leer ticker()).
  useEffect(() => {
    if (st.ticker() !== ticker) st.ticker.set(ticker);
    if (st.tipo() !== tipoParam) st.tipo.set(tipoParam);
    if (st.origin() !== originParam) st.origin.set(originParam);
    st.hydrateFromRoute();
  }, [st, ticker, tipoParam, originParam]);

  // ex `private renderChart = effect(...)`. Deps: historicoData (única fuente
  // de chartBaselineData), subview y chartRango — las mismas signals que
  // leía el effect de Angular. lightweight-charts se importa acá adentro:
  // no es SSR-safe y no puede estar en el top-level del módulo.
  const historicoDataValue = st.historicoData();
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const lwc = await import('lightweight-charts');
      if (cancelled) return;
      if (fichaChartContainer.current) st.createOrUpdateChart(lwc, 'fichaChart', fichaChartContainer);
      if (ticketChartContainer.current) st.createOrUpdateChart(lwc, 'ticketChart', ticketChartContainer);
    })();
    return () => { cancelled = true; };
  }, [st, historicoDataValue, subview(), chartRango()]);

  // ex `private liveTick = effect(...)`. Corre después de cada render (el
  // componente re-renderiza ante cualquier cambio de signal, igual que la
  // detección de cambios de Angular) y es idempotente por el dedupe de
  // lastLiveTick.
  useEffect(() => {
    st.liveTick();
  });

  // ex @HostListener('document:click') → closeDropdowns.
  // OJO, DIFERENCIA REAL Angular→React: en Angular el (click) del botón hace
  // stopPropagation y el evento nativo nunca llega a document, así que este
  // handler sólo corría con clicks de AFUERA. En React los listeners viven en
  // el contenedor raíz (que con App Router es `document`), así que el
  // stopPropagation() del evento sintético NO impide que un listener
  // registrado en ESE MISMO nodo se ejecute igual → el dropdown se abría y se
  // cerraba en el mismo click. Se preserva el comportamiento original
  // filtrando por target: un click dentro de un .op-dropdown (botón o menú)
  // no cierra nada; el resto sí.
  useEffect(() => {
    const onDocumentClick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target?.closest?.('.op-dropdown')) return;
      st.closeDropdowns();
    };
    document.addEventListener('click', onDocumentClick);
    return () => document.removeEventListener('click', onDocumentClick);
  }, [st]);

  // ex ngOnDestroy: limpieza de los charts de TradingView al desmontar.
  useEffect(() => () => st.destroyCharts(), [st]);

  // ── Subvistas ─────────────────────────────────────────────────────────────

  function renderHome() {
    return (
      <>
        {/* Acciones: primer contenedor de Home, con datos reales de
             accionesRows()/cedearsRows()/etc. — misma fuente que consume
             Panel (ver loadHome/panelRawRows). 2 columnas INDEPENDIENTES,
             cada una con su propio dropdown de instrumento (ver
             .op-acciones-grid más abajo) — mismo mecanismo de grilla que
             Cotizaciones.tsx (.mosaic), colapsa a 1 columna en
             mobile ≤760px como el resto de la app.

             Pedido de Elio (reemplaza los toggles globales que había antes):
             los 5 toggles de tipo de instrumento se sacaron de esta fila —
             ya no hacen falta, la selección ahora vive en cada columna del
             panel de Acciones vía dropdown (ver selectHomeInstrumentLeft/
             Right). En el espacio que quedó libre va el widget "Destacados"
             compacto (ver .op-top-mover más abajo): la acción/cedear con
             mayor % de ganancia en tiempo real, reusando la misma fuente que
             la card completa de Destacados de más abajo (ver topMover()) —
             esa card NO se toca, este widget es una pieza aparte y
             adicional. El buscador sigue abriendo su propio dropdown de
             resultados (cruza Acciones+Cedears, ver searchResults) — no
             filtra el panel de Acciones, son mecanismos distintos. */}
        <div className="op-home-head">
          <div className="op-search-wrap">
            <input
              className="op-search"
              type="text"
              placeholder="Buscar símbolo o descripción…"
              value={query()}
              onChange={(e) => query.set(e.target.value)}
            />
            {query().trim() && searchResults().length ? (
              <div className="op-search-results">
                {searchResults().map((r) => (
                  <button key={r.symbol} className="op-result" onClick={() => selectSymbol(r)}>
                    <span className="or-sym">{r.symbol}</span>
                    <span className="or-desc">{r.desc || ''}</span>
                    <span className="or-px num">{fmt(price(r))}</span>
                    <span className={cx('or-chip', r.pct_change >= 0 && 'pos', r.pct_change < 0 && 'neg')}>
                      {r.pct_change >= 0 ? '+' : ''}{fmt(r.pct_change)}%
                    </span>
                  </button>
                ))}
              </div>
            ) : query().trim() ? (
              <div className="op-search-results">
                <div className="op-empty op-empty-inline">Sin resultados para «{query()}».</div>
              </div>
            ) : null}
          </div>

          {/* Carrusel de Fondos (pedido de Elio): la sección Fondos dejó de
               ser una card al pie de Home y pasó a ser este ticker horizontal
               en el espacio libre entre el buscador y el panel de Dólar.
               Marquee CSS infinito (ver .op-fondos-carousel): fondosTicker()
               duplica fondosRows() para que el loop de translateX(-50%) sea
               continuo sin salto. Pausa en hover (animation-play-state).
               Encabezado simplificado vía fondoShortName(): saca sufijos
               redundantes (FCI, "En Pesos", etc.) y normaliza MAYÚSCULAS.
               Sólo se muestra con datos reales — cargando o con error no
               ocupa lugar (la barra queda como estaba antes). */}
          {fondosRows().length ? (
            <div className="op-fondos-carousel" title="Fondos — variación últimos 12 meses">
              <div className="ofc-track">
                {fondosTicker().map((f, $index) => (
                  <span className="ofc-item" key={$index}>
                    <span className="ofc-name">{fondoShortName(f.name)}</span>
                    <span className={cx('ofc-pct num', f.variacionAnual >= 0 && 'pos', f.variacionAnual < 0 && 'neg')}>
                      {f.variacionAnual >= 0 ? '+' : ''}{fmt(f.variacionAnual)}%
                    </span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {/* Widget compacto de Destacados, al lado del buscador. Rota
               automáticamente entre destacados() cada 4.5s (ver
               currentMoverIndex/rotatingMover/rotateMover en el store) —
               antes mostraba fijo el mayor % de ganancia. Fade vía la clase
               otm-fade-in + key por symbol (React recrea el nodo al cambiar
               de mover, la transición CSS de opacity corre sola). Pausa en
               hover (pauseMoverRotation/resumeMoverRotation), reanuda al
               sacar el cursor. Sin destino de "ver más" — para el detalle
               completo sigue existiendo la card .op-destacados de más abajo,
               sin cambios. */}
          <div className="op-top-mover" onMouseEnter={() => pauseMoverRotation()} onMouseLeave={() => resumeMoverRotation()}>
            {/* map con key por symbol en vez de un render condicional: fuerza
                 a React a destruir/recrear el nodo cada vez que
                 rotatingMover() cambia de símbolo (mismo truco que
                 FlipNum.tsx) — así la animación CSS de entrada (otm-fade-in)
                 vuelve a correr en cada rotación en vez de quedar estática
                 por reusar el mismo elemento. rotatingMoverList() envuelve
                 rotatingMover() en un array de 0 o 1 elemento. */}
            {rotatingMoverList().length ? (
              rotatingMoverList().map((m) => (
                <Fragment key={m.symbol}>
                  <button className="op-top-mover-body otm-fade-in" type="button" onClick={() => selectSymbol(m)} title={`Ver ficha de ${m.symbol}`}>
                    <span className="otm-lbl">Destacada</span>
                    <span className="otm-sym">{m.symbol}</span>
                    <span className="otm-px num">{fmt(m.price)}</span>
                    <span className={cx('otm-chip', m.pctChange >= 0 && 'pos', m.pctChange < 0 && 'neg')}>
                      {m.pctChange >= 0 ? '+' : ''}{fmt(m.pctChange)}%
                    </span>
                  </button>
                  <button className="op-buy-row-btn op-top-mover-buy" type="button" title={`Comprar ${m.symbol}`} aria-label={'Comprar ' + m.symbol} onClick={() => comprarDirecto(m.symbol, 'home')}>
                    Comprar
                  </button>
                </Fragment>
              ))
            ) : (
              <>
                <span className="otm-lbl">Destacada</span>
                <span className="op-empty-inline op-top-mover-empty">Esperando cotizaciones…</span>
              </>
            )}
          </div>

          {/* Panel de Dólar, ubicado al lado del bloque "Destacada" en la
               barra superior (pedido de UI: mismo nivel que el buscador y
               Destacada, no en el mosaico de abajo). Reusa dolarStrip ya
               existente en el store, con una piel compacta propia
               (.op-top-dolar) en vez de la card completa .op-dolares. */}
          <div className="op-top-dolar">
            {dolarStrip.map((d) => (
              <div className="otd-item" key={d.label}>
                <span className="otd-lbl">{d.label}</span>
                <span className="otd-val num">$ {fmt(d.value)}</span>
              </div>
            ))}
          </div>

          <button className="op-cartera-btn op-subtab on" type="button" onClick={() => goCartera()} title="Cartera" aria-label="Ver cartera">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
            <span>Cartera</span>
            {tenencias().length ? (
              <span className="op-cartera-badge">{tenencias().length}</span>
            ) : null}
          </button>
        </div>

        <div className="op-card op-acciones">
          {/* 2 columnas INDEPENDIENTES (pedido de Elio): cada una con su
               propio dropdown de instrumento (select nativo, ver
               .op-col-select) en vez de un h3 fijo + toggles globales. La
               selección de cada dropdown persiste en localStorage (ver
               selectHomeInstrumentLeft/Right en el store), mismo patrón
               que el dropdown de horario de mercado de Arbitraje
               (market-hours.config.ts). */}
          <div className="op-acciones-grid">
            <div className="op-acciones-col">
              <div className={cx('op-dropdown', dropdownOpenLeft() && 'open')}>
                <button
                  className="op-dropdown-btn"
                  type="button"
                  onClick={(e) => toggleDropdownLeft(e)}
                  aria-haspopup="listbox"
                  aria-expanded={dropdownOpenLeft()}
                  aria-label="Instrumento columna izquierda"
                >
                  <span>{homeInstrumentLabelLeft()}</span>
                  <span className="op-dropdown-arrow">▾</span>
                </button>
                {dropdownOpenLeft() ? (
                  <ul className="op-dropdown-menu" role="listbox">
                    {pills.map((p) => (
                      <li
                        key={p.id}
                        className={cx('op-dropdown-option', homeInstrumentLeft() === p.id && 'selected')}
                        role="option"
                        aria-selected={homeInstrumentLeft() === p.id}
                        onClick={() => pickHomeInstrumentLeft(p.id)}
                      >{p.label}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              {homeRowsLeft().length ? (
                <>
                  <div className="op-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Símbolo</th>
                          <th className="num">Precio</th>
                          <th className="num">Variación</th>
                          <th className="op-th-accion"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {homeRowsLeft().map((r) => (
                          <tr key={r.symbol} className="op-row-buy" onClick={() => comprarDirecto(r.symbol, 'home')} title={`Comprar ${r.symbol}`}>
                            <td>
                              <span className="opt-sym">{r.symbol}</span>
                              {r.desc ? <span className="opt-desc">{r.desc}</span> : null}
                            </td>
                            <td className="num">{fmt(price(r))}</td>
                            <td className={cx('num', r.pct_change >= 0 && 'pos', r.pct_change < 0 && 'neg')}>
                              {r.pct_change >= 0 ? '+' : ''}{fmt(r.pct_change)}%
                            </td>
                            <td className="op-td-accion">
                              <span className="op-row-arrow" aria-hidden="true">›</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="op-acciones-cards">
                    {homePreviewMobileLeft().map((r) => (
                      <div key={r.symbol} className="op-acc-card" onClick={() => comprarDirecto(r.symbol, 'home')} title={`Comprar ${r.symbol}`}>
                        <div className="op-acc-id">
                          <span className="opt-sym">{r.symbol}</span>
                          {r.desc ? <span className="opt-desc">{r.desc}</span> : null}
                        </div>
                        <div className="op-acc-row">
                          <span className="op-acc-price num">{fmt(price(r))}</span>
                          <span className={cx('op-acc-chip num', r.pct_change >= 0 && 'pos', r.pct_change < 0 && 'neg')}>
                            {r.pct_change >= 0 ? '+' : ''}{fmt(r.pct_change)}%
                          </span>
                          <span className="op-row-arrow op-acc-arrow" aria-hidden="true">›</span>
                        </div>
                      </div>
                    ))}
                    <button className="op-acc-verall" type="button" onClick={() => selectInstrument(homeInstrumentLeft())}>
                      Ver todo en {homeInstrumentLabelLeft()}
                    </button>
                  </div>
                </>
              ) : (
                <div className="op-empty">Cargando {homeInstrumentLabelLeft().toLowerCase()}…</div>
              )}
            </div>

            <div className="op-acciones-col">
              <div className={cx('op-dropdown', dropdownOpenRight() && 'open')}>
                <button
                  className="op-dropdown-btn"
                  type="button"
                  onClick={(e) => toggleDropdownRight(e)}
                  aria-haspopup="listbox"
                  aria-expanded={dropdownOpenRight()}
                  aria-label="Instrumento columna derecha"
                >
                  <span>{homeInstrumentLabelRight()}</span>
                  <span className="op-dropdown-arrow">▾</span>
                </button>
                {dropdownOpenRight() ? (
                  <ul className="op-dropdown-menu" role="listbox">
                    {pills.map((p) => (
                      <li
                        key={p.id}
                        className={cx('op-dropdown-option', homeInstrumentRight() === p.id && 'selected')}
                        role="option"
                        aria-selected={homeInstrumentRight() === p.id}
                        onClick={() => pickHomeInstrumentRight(p.id)}
                      >{p.label}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              {homeRowsRight().length ? (
                <>
                  <div className="op-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Símbolo</th>
                          <th className="num">Precio</th>
                          <th className="num">Variación</th>
                          <th className="op-th-accion"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {homeRowsRight().map((r) => (
                          <tr key={r.symbol} className="op-row-buy" onClick={() => comprarDirecto(r.symbol, 'home')} title={`Comprar ${r.symbol}`}>
                            <td>
                              <span className="opt-sym">{r.symbol}</span>
                              {r.desc ? <span className="opt-desc">{r.desc}</span> : null}
                            </td>
                            <td className="num">{fmt(price(r))}</td>
                            <td className={cx('num', r.pct_change >= 0 && 'pos', r.pct_change < 0 && 'neg')}>
                              {r.pct_change >= 0 ? '+' : ''}{fmt(r.pct_change)}%
                            </td>
                            <td className="op-td-accion">
                              <span className="op-row-arrow" aria-hidden="true">›</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="op-acciones-cards">
                    {homePreviewMobileRight().map((r) => (
                      <div key={r.symbol} className="op-acc-card" onClick={() => comprarDirecto(r.symbol, 'home')} title={`Comprar ${r.symbol}`}>
                        <div className="op-acc-id">
                          <span className="opt-sym">{r.symbol}</span>
                          {r.desc ? <span className="opt-desc">{r.desc}</span> : null}
                        </div>
                        <div className="op-acc-row">
                          <span className="op-acc-price num">{fmt(price(r))}</span>
                          <span className={cx('op-acc-chip num', r.pct_change >= 0 && 'pos', r.pct_change < 0 && 'neg')}>
                            {r.pct_change >= 0 ? '+' : ''}{fmt(r.pct_change)}%
                          </span>
                          <span className="op-row-arrow op-acc-arrow" aria-hidden="true">›</span>
                        </div>
                      </div>
                    ))}
                    <button className="op-acc-verall" type="button" onClick={() => selectInstrument(homeInstrumentRight())}>
                      Ver todo en {homeInstrumentLabelRight()}
                    </button>
                  </div>
                </>
              ) : (
                <div className="op-empty">Cargando {homeInstrumentLabelRight().toLowerCase()}…</div>
              )}
            </div>
          </div>
        </div>
      </>
    );
  }

  function renderPanel() {
    return (
      <>
        <div className="op-panel-head">
          <button className="op-back" onClick={() => goHome()}>← Volver</button>
          <h2 className="op-panel-title">{selectedInstrumentLabel()}</h2>
        </div>

        <div className="op-search-wrap">
          <input
            className="op-search"
            type="text"
            placeholder="Buscar símbolo o descripción…"
            value={panelQuery()}
            onChange={(e) => panelQuery.set(e.target.value)}
          />
        </div>

        <div className="op-panel-toolbar">
          <div className="op-cur-pills">
            {currencyPills.map((c) => (
              <button
                key={c.id}
                className={cx('op-cur-pill', panelCurrency() === c.id && 'on')}
                type="button"
                disabled={isCurrencyDisabled(c.id)}
                title={isCurrencyDisabled(c.id) ? 'Próximamente' : ''}
                onClick={() => selectCurrency(c.id)}
              >{c.label}</button>
            ))}
          </div>

          {panelSubTabs().length ? (
            <div className="op-subtabs">
              {panelSubTabs().map((t) => (
                <button
                  key={t.id}
                  className={cx('op-subtab', panelSubTab() === t.id && 'on')}
                  type="button"
                  onClick={() => panelSubTab.set(t.id)}
                >{t.label}</button>
              ))}
            </div>
          ) : null}
        </div>

        {isGeneralEmpty() ? (
          <>
            <div className="op-empty">Panel general — próximamente.</div>
            {/* TODO: integrar /Titulos/Cotizacion/Paneles para la clasificación real */}
          </>
        ) : panelSortedRows().length ? (
          <div className="op-table-wrap">
            <table>
              <thead>
                <tr>
                  <th onClick={() => toggleSort('symbol')} className={cx(panelSort().column === 'symbol' && 'sorted')}>
                    Nombre <span className="op-sort-arrow">{sortArrow('symbol')}</span>
                  </th>
                  <th className={cx('num', panelSort().column === 'price' && 'sorted')} onClick={() => toggleSort('price')}>
                    Precio <span className="op-sort-arrow">{sortArrow('price')}</span>
                  </th>
                  <th className={cx('num', panelSort().column === 'pct' && 'sorted')} onClick={() => toggleSort('pct')}>
                    Variación <span className="op-sort-arrow">{sortArrow('pct')}</span>
                  </th>
                  <th className="op-th-accion"></th>
                </tr>
              </thead>
              <tbody>
                {panelSortedRows().map((r) => (
                  <tr key={r.symbol} className="op-row-buy" onClick={() => comprarDirecto(r.symbol, 'panel')} title={`Comprar ${r.symbol}`}>
                    <td>
                      <span className="opt-sym">{r.symbol}</span>
                      {r.desc ? <span className="opt-desc">{r.desc}</span> : null}
                    </td>
                    <td className="num">{fmt(price(r))}</td>
                    <td className={cx('num', r.pct_change >= 0 && 'pos', r.pct_change < 0 && 'neg')}>
                      {r.pct_change >= 0 ? '+' : ''}{fmt(r.pct_change)}%
                    </td>
                    <td className="op-td-accion">
                      <span className="op-row-arrow" aria-hidden="true">›</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : panelQuery().trim() ? (
          <div className="op-empty">Sin resultados para «{panelQuery()}».</div>
        ) : (
          <div className="op-empty">Cargando cotizaciones…</div>
        )}
      </>
    );
  }

  function renderFicha() {
    const r = selectedRow();
    const aviso = historicoAviso();
    return (
      <>
        <div className="op-ficha-head">
          <button className="op-back" onClick={() => goBackFromFicha()}>← Volver</button>
          <div className="op-ficha-id">
            <span className="fh-sym">{selectedSymbol()}</span>
            {r?.desc ? <span className="fh-desc">{r.desc}</span> : null}
          </div>
        </div>

        <div className="op-ficha-price">
          {r ? (
            <>
              <span className="fp-val num">$ {fmt(price(r))}</span>
              <span className={cx('fp-chip', r.pct_change >= 0 && 'pos', r.pct_change < 0 && 'neg')}>
                {r.pct_change >= 0 ? '+' : ''}{fmt(r.pct_change)}%
              </span>
            </>
          ) : (
            <span className="fp-val num">—</span>
          )}
        </div>

        {/* Sección de 2 columnas de Ficha: mismo mecanismo de grilla que
             .mosaic/.col de Cotizaciones.css (grid de 2 columnas +
             gap 14px, align-items:start, colapsa a 1 columna en el mismo
             breakpoint ≤1000px que usa Home — ver .op-ficha-mosaic/@media
             más abajo). Columna izquierda: selector de rango + gráfico
             (van juntos, el selector controla el gráfico). Columna derecha:
             Puntas. Ningún bloque se reescribe, sólo se reubican dentro de
             la nueva grilla — el botón sticky Comprar queda fuera, debajo,
             con su comportamiento intacto. */}
        <div className="op-ficha-mosaic">
          <div className="op-ficha-col">
            <div className="op-rango-pills">
              {chartRangos.map((rg) => (
                <button key={rg.id} className={cx('op-rango-pill', chartRango() === rg.id && 'on')} type="button" onClick={() => selectRango(rg.id)}>
                  {rg.label}
                </button>
              ))}
            </div>

            {aviso ? <div className="op-chart-aviso">{aviso}</div> : null}
            {chartBaselineData().length >= 2 ? (
              <div className="fc-wrap">
                <div ref={fichaChartContainer} className="fc-chart"></div>
                {/* Loader sutil superpuesto (no reemplaza el gráfico
                     mientras recarga otro rango — regla 3: se conservan los
                     últimos datos válidos visibles hasta que llega el nuevo
                     rango, en vez de vaciar la pantalla). */}
                {historicoLoading() ? (
                  <div className="fc-loading-overlay"><span className="fc-spinner"></span></div>
                ) : null}
              </div>
            ) : historicoLoading() ? (
              <div className="op-empty">Cargando gráfico…</div>
            ) : (
              <div className="op-empty">Sin datos históricos para este rango.</div>
            )}
          </div>

          <div className="op-ficha-col">
            <div className="op-card op-book">
              <button className="op-book-toggle" type="button" onClick={() => fichaBookOpen.set(!fichaBookOpen())}>
                <span className="ob-title-wrap">
                  <h3>Puntas</h3>
                  {bookIsEmpty(r) ? <span className="ori-chip warn">estimado</span> : null}
                </span>
                <span className={cx('ob-chevron', fichaBookOpen() && 'open')}>›</span>
              </button>
              {fichaBookOpen() ? (
                <div className="op-book-row">
                  <div className="ob-side ob-buy">
                    <span className="ob-lbl">Compra</span>
                    <span className="ob-qty num">{fmt(r?.q_bid ?? 0, 0)}</span>
                    <span className="ob-px num">{fmt(bookBidPx(r))}</span>
                  </div>
                  <div className="ob-side ob-sell">
                    <span className="ob-lbl">Venta</span>
                    <span className="ob-px num">{fmt(bookAskPx(r))}</span>
                    <span className="ob-qty num">{fmt(r?.q_ask ?? 0, 0)}</span>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <button className="op-buy-sticky" type="button" onClick={() => goTicket()}>Comprar {selectedSymbol()}</button>
      </>
    );
  }

  function renderTicket() {
    const r = selectedRow();
    const aviso = historicoAviso();
    if (ticketStep() === 'form') {
      return (
        <>
          <div className="op-ficha-head">
            <button className="op-back" onClick={() => goBackFromTicketForm()}>← Volver</button>
            <div className="op-ficha-id">
              <span className="fh-sym">{selectedSymbol()}</span>
              <span className="fh-desc">{ticketTipo() === 'venta' ? 'Vender' : 'Comprar'}</span>
            </div>
          </div>

          {/* Gráfico histórico (mismo TradingView chart que Ficha, ver
               .fc-wrap/createOrUpdateChart() en el store): arriba de
               Puntas/Orden, en la pantalla de compra. loadHistorico() se
               dispara para esta subvista vía fichaFetch (ver el useEffect del
               componente) — mismos historicoData()/historicoLoading()/
               chartRango() que ya usa Ficha, sin duplicar estado ni lógica. */}
          <div className="op-card op-chart-card">
            <div className="op-rango-pills">
              {chartRangos.map((rg) => (
                <button key={rg.id} className={cx('op-rango-pill', chartRango() === rg.id && 'on')} type="button" onClick={() => selectRango(rg.id)}>
                  {rg.label}
                </button>
              ))}
            </div>

            {aviso ? <div className="op-chart-aviso">{aviso}</div> : null}
            {chartBaselineData().length >= 2 ? (
              <div className="fc-wrap">
                <div ref={ticketChartContainer} className="fc-chart"></div>
                {historicoLoading() ? (
                  <div className="fc-loading-overlay"><span className="fc-spinner"></span></div>
                ) : null}
              </div>
            ) : historicoLoading() ? (
              <div className="op-empty">Cargando gráfico…</div>
            ) : (
              <div className="op-empty">Sin datos históricos para este rango.</div>
            )}
          </div>

          {/* Puntas + Orden en 2 columnas — grid dedicado del Ticket
               (.op-ticket-mosaic), mismo mecanismo que .op-home-mosaic/
               .op-ficha-mosaic (grid de 2 columnas + gap 14px). A diferencia
               de esos otros mosaicos, acá align-items es stretch (default,
               ver CSS): Orden tiene más filas que Puntas (Precio/Plazo +
               Cantidad/Monto vs. sólo Compra/Venta), así que con
               align-items:start la columna de Puntas quedaba visualmente más
               chica al lado de Orden — con stretch ambas cards ocupan la
               altura de la fila más alta del grid (Orden), Puntas se estira
               parejo aunque su contenido siga arriba. Se usa una clase propia
               en vez de reusar .op-ficha-mosaic para no atar el
               breakpoint/estilo del Ticket al de Ficha (subvistas distintas,
               alcance estricto pide no tocar Ficha). Mismo breakpoint
               ≤1000px que el resto de la app (ver @media más abajo) — por
               debajo de ese ancho las columnas colapsan a 1 sola, Puntas
               arriba y Orden abajo. El botón "Revisar orden" vive DENTRO de
               la card Orden, como cierre de esa columna (ver op-order-body
               más abajo) — ya no es una franja a lo ancho completo de toda
               la pantalla. Contenido interno de cada card intacto. */}
          <div className="op-ticket-mosaic">
            {/* op-book-fill: clase adicional SOLO en esta instancia de
                 Ticket (combinada con op-card op-book, igual que
                 op-book-row-stacked más abajo) — Ficha usa "op-card op-book"
                 sin este modificador y no se ve afectada. Cadena de alturas
                 completa para que Compra/Venta se repartan el 100% de la
                 columna en partes iguales (ver CSS, selectores
                 .op-card.op-book-fill / .op-book-row-stacked / .ob-side
                 dentro de ese scope):
                 grid (align-items:stretch, default) estira este .op-card a
                 la altura de fila (= altura de Orden) → op-book-fill lo
                 vuelve flex-column con height:100% → op-book-row-stacked
                 toma flex:1 de ese alto → cada .ob-side toma flex:1 1 0
                 del alto de op-book-row-stacked. */}
            <div className="op-card op-book op-book-fill">
              <div className="ob-title-wrap">
                <h3>Puntas</h3>
                {bookIsEmpty(r) ? <span className="ori-chip warn">estimado</span> : null}
              </div>
              {/* Compra/Venta apiladas (no lado a lado) SOLO en esta
                   instancia de Ticket: clase adicional op-book-row-stacked
                   combinada con op-book-row (ver CSS, selector compuesto
                   .op-book-row.op-book-row-stacked) — Ficha sigue usando
                   op-book-row sola, sin este modificador, así que su
                   Compra/Venta lado a lado no cambia. */}
              <div className="op-book-row op-book-row-stacked">
                <div className="ob-side ob-buy">
                  <span className="ob-lbl">Compra</span>
                  <span className="ob-qty num">{fmt(r?.q_bid ?? 0, 0)}</span>
                  <span className="ob-px num">{fmt(bookBidPx(r))}</span>
                </div>
                <div className="ob-side ob-sell">
                  <span className="ob-lbl">Venta</span>
                  <span className="ob-px num">{fmt(bookAskPx(r))}</span>
                  <span className="ob-qty num">{fmt(r?.q_ask ?? 0, 0)}</span>
                </div>
              </div>
            </div>

            <div className="op-card op-order">
              <h3>Orden</h3>
              <div className="op-order-body">
                <div className="op-ticket-row">
                  <label className="op-field">
                    <span className="of-lbl">Precio</span>
                    <select className="op-select" value={ticketState().tipoPrecio} onChange={(e) => setTipoPrecio(e.target.value as TicketTipoPrecio)}>
                      {tipoPrecioOpts.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                  </label>

                  {ticketState().tipoPrecio === 'limite' ? (
                    <label className="op-field">
                      <span className="of-lbl">Precio límite</span>
                      <input
                        className="op-input num"
                        type="number" min="0" step="0.01"
                        value={ticketState().precioLimite ?? ''}
                        onChange={(e) => setPrecioLimite(Number(e.target.value))}
                      />
                    </label>
                  ) : null}

                  <label className="op-field">
                    <span className="of-lbl">Plazo de liquidación</span>
                    <select className="op-select" value={ticketState().plazo} onChange={(e) => setPlazo(e.target.value as TicketPlazo)}>
                      {plazoOpts.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </select>
                  </label>
                </div>

                {/* Cantidad + Monto a invertir en 2 columnas — mismo contenedor
                     .op-ticket-row/.op-field que ya usan Precio/Plazo de arriba
                     (flex + gap 14px + flex-wrap, min-width 140px por campo).
                     Reusar el contenedor existente evita reescribir el
                     comportamiento responsive: al no entrar los 2 min-width
                     140px + gap en el ancho disponible, flex-wrap los apila en
                     1 columna igual que ya le pasa a Precio/Plazo en mobile —
                     no hace falta una media query nueva. Stepper de Cantidad y
                     label "Disponible"/aviso de Monto quedan intactos, sólo se
                     reubican dentro de la fila. */}
                <div className="op-ticket-row">
                  <div className="op-field">
                    <div className="of-row">
                      <span className="of-lbl">Cantidad</span>
                      {ticketTipo() === 'venta' ? (
                        <span className="of-hint">Disponible: {fmt(maxVendible(), 0)}</span>
                      ) : null}
                    </div>
                    <div className="op-stepper">
                      <input
                        className="op-step-input num"
                        type="number" min="0" step="1"
                        value={ticketState().cantidad}
                        onChange={(e) => setCantidad(Number(e.target.value))}
                      />
                      <button className="op-step-btn" type="button" onClick={() => decCantidad()} disabled={ticketState().cantidad <= 0}>−</button>
                      <button className="op-step-btn" type="button" onClick={() => incCantidad()} disabled={ticketState().cantidad >= maxVendible()}>+</button>
                    </div>
                  </div>

                  <div className="op-field">
                    <div className="of-row">
                      <span className="of-lbl">Monto a invertir</span>
                      {montoBelowMinimum() ? (
                        <span className="of-hint of-hint-warn">No alcanza para 1 nominal · mín. $ {fmt(precioEfectivo())}</span>
                      ) : (
                        /* TODO: viene de estadocuenta si se habilita más adelante */
                        <span className="of-hint">Disponible: $ 0,00</span>
                      )}
                    </div>
                    <input
                      className="op-input op-input-monto num"
                      type="number" min="0" step="100"
                      value={ticketState().monto ?? ''}
                      onChange={(e) => setMonto(Number(e.target.value))}
                    />
                  </div>
                </div>

                {/* "Revisar orden" como cierre de la columna Orden (ver
                     comentario del mosaico más arriba) — mismo botón/clases
                     de siempre, sólo se reubica dentro de op-order-body en
                     vez de vivir afuera de las 2 columnas. margin-top:auto
                     (op-order-body es flex-column) lo empuja al fondo de la
                     card cuando Orden queda más baja que su contenido en
                     mobile (1 columna, ver @media) sin afectar el layout de
                     desktop, donde ya es el último elemento del flujo. */}
                <button className="op-buy-sticky op-buy-sticky-sm" type="button" disabled={ticketState().cantidad <= 0} onClick={() => goTicketConfirmar()}>
                  Revisar orden
                </button>
              </div>
            </div>
          </div>
        </>
      );
    }
    return (
      <>
        <div className="op-ficha-head">
          <button className="op-back" onClick={() => goTicketForm()}>← Volver</button>
          <div className="op-ficha-id">
            <span className="fh-sym">Revisar orden</span>
            <span className="fh-desc">{selectedSymbol()}</span>
          </div>
        </div>

        <div className="op-card op-ref">
          <h3>Resumen</h3>
          <div className="op-summary-list">
            <div className="op-summary-row">
              <span className="orr-lbl">Símbolo</span>
              <span className="orr-right"><span className="orr-val">{selectedSymbol()}</span></span>
            </div>
            <div className="op-summary-row">
              <span className="orr-lbl">Operación</span>
              <span className="orr-right"><span className="orr-val">{ticketTipo() === 'venta' ? 'Vender' : 'Comprar'}</span></span>
            </div>
            <div className="op-summary-row">
              <span className="orr-lbl">Precio</span>
              <span className="orr-right">
                <span className="orr-val">
                  {ticketState().tipoPrecio === 'mercado' ? (
                    'Mercado'
                  ) : (
                    <>Límite · $ {fmt(ticketState().precioLimite ?? 0)}</>
                  )}
                </span>
              </span>
            </div>
            <div className="op-summary-row">
              <span className="orr-lbl">Plazo</span>
              <span className="orr-right"><span className="orr-val">{plazoLabel(ticketState().plazo)}</span></span>
            </div>
            <div className="op-summary-row">
              <span className="orr-lbl">Cantidad</span>
              <span className="orr-right"><span className="orr-val num">{fmt(ticketState().cantidad, 0)}</span></span>
            </div>
            <div className="op-summary-row">
              <span className="orr-lbl">Monto estimado</span>
              <span className="orr-right"><span className="orr-val num">$ {fmt(montoEstimado())}</span></span>
            </div>
          </div>
        </div>

        {/* TODO: reemplazar por texto legal real aprobado por Boston antes de
             habilitar esta pantalla en producción. */}
        <p className="op-legal">
          Esta operación está sujeta a las condiciones de mercado vigentes al momento de su ejecución.
          Los precios e importes mostrados son estimados y pueden variar.
        </p>

        <label className="op-checkbox-row">
          <input
            type="checkbox"
            className="op-checkbox"
            checked={ticketAccepted()}
            onChange={(e) => ticketAccepted.set(e.target.checked)}
          />
          <span>Confirmo que leí y acepto los términos de esta operación</span>
        </label>

        {ticketBannerShown() ? (
          <div className="op-warn-banner">
            <p>La operatoria online todavía no está habilitada para esta cuenta. Esta operación no fue enviada.</p>
            <button className="op-warn-banner-link" type="button" onClick={() => goCarteraFromTicket()}>Ver en Cartera →</button>
          </div>
        ) : null}

        <button className="op-buy-sticky" type="button" disabled={!ticketAccepted()} onClick={() => confirmarOperacion()}>
          Confirmar operación
        </button>
      </>
    );
  }

  function renderCartera() {
    return (
      <>
        <div className="op-panel-head">
          <button className="op-back" onClick={() => goHome()}>← Volver</button>
          <h2 className="op-panel-title">Cartera</h2>
        </div>

        <div className="op-warn-banner">
          <p>DATOS SIMULADOS — no representa operaciones reales ni información de tu cuenta.</p>
        </div>

        {tenencias().length ? (
          <div className="op-card">
            <div className="op-dolares-row">
              <div className="op-dollar-item">
                <span className="od-lbl">Total invertido</span>
                <span className="op-resumen-val num">$ {fmt(resumenCartera().totalInvertido)}</span>
              </div>
              <div className="op-dollar-item">
                <span className="od-lbl">Ganancia / Pérdida total</span>
                <div className={cx('op-resumen-prof', resumenCartera().gananciaTotal >= 0 && 'pos', resumenCartera().gananciaTotal < 0 && 'neg')}>
                  <span className="rp-val num">
                    {resumenCartera().gananciaTotal >= 0 ? '+' : ''}$ {fmt(resumenCartera().gananciaTotal)}
                  </span>
                </div>
              </div>
              <div className="op-dollar-item">
                <span className="od-lbl">Variación de hoy</span>
                <span className={cx('op-resumen-val num', resumenCartera().variacionHoy >= 0 && 'pos', resumenCartera().variacionHoy < 0 && 'neg')}>
                  {resumenCartera().variacionHoy >= 0 ? '+' : ''}$ {fmt(resumenCartera().variacionHoy)}
                </span>
                <span className="op-resumen-pct">
                  ({resumenCartera().variacionHoyPct >= 0 ? '+' : ''}{fmt(resumenCartera().variacionHoyPct)}%) hoy
                </span>
              </div>
            </div>
          </div>
        ) : null}

        <div className="op-subtabs">
          <button className={cx('op-subtab', carteraTab() === 'tenencias' && 'on')} type="button" onClick={() => carteraTab.set('tenencias')}>Tenencias</button>
          <button className={cx('op-subtab', carteraTab() === 'movimientos' && 'on')} type="button" onClick={() => carteraTab.set('movimientos')}>Movimientos</button>
        </div>

        {carteraTab() === 'tenencias' ? (
          tenencias().length ? (
            <>
              <div className="op-card op-cart-comp-card">
                <span className="od-lbl">Composición de la cartera</span>
                <div className="op-cart-comp-row">
                  {composicionCartera().map((c) => (
                    <span className="op-cart-comp-chip" key={c.instrumento}>
                      <span className="op-cart-comp-pct num">{fmt(c.pct, 0)}%</span>
                      <span className="op-cart-comp-lbl">{c.label}</span>
                    </span>
                  ))}
                </div>
              </div>

              <div className="op-pills op-cart-filter">
                {tenenciasFilterOptions.map((p) => (
                  <button key={p.id} className={cx('op-pill', tenenciasFiltro() === p.id && 'on')} type="button" onClick={() => tenenciasFiltro.set(p.id)}>
                    <span className="op-pill-circle">{p.initials}</span>
                    <span className="op-pill-label">{p.label}</span>
                  </button>
                ))}
              </div>

              {tenenciasFiltradas().length ? (
                <>
                  <div className="op-table-wrap op-cartera-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Símbolo</th>
                          <th className="num">Cantidad</th>
                          <th className="num">Precio prom.</th>
                          <th className="num">Valor actual</th>
                          <th className="num">P&amp;L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tenenciasFiltradas().map((t) => (
                          <Fragment key={t.symbol}>
                            <tr onClick={() => toggleTenenciaExpandida(t.symbol)}>
                              <td>
                                <span className="opt-sym">{t.symbol}</span>
                                <span className="ori-chip">{instrumentoLabel[t.instrumento]}</span>
                                {t.estimado ? <span className="ori-chip warn">estimado</span> : null}
                              </td>
                              <td className="num">{fmt(t.cantidad, 0)}</td>
                              <td className="num">{fmt(t.precioPromedio)}</td>
                              <td className="num">{fmt(t.valorActual)}</td>
                              <td className={cx('num', t.pnl >= 0 && 'pos', t.pnl < 0 && 'neg')}>
                                {t.pnl >= 0 ? '+' : ''}{fmt(t.pnl)}
                              </td>
                            </tr>
                            {tenenciaExpandida() === t.symbol ? (
                              <tr className="op-tenencia-actions-row">
                                <td colSpan={5}>
                                  <div className="op-subtabs">
                                    <button className="op-subtab on" type="button" onClick={() => comprarMasDesdeCartera(t.symbol)}>Comprar más</button>
                                    <button className="op-subtab sell" type="button" onClick={() => venderDesdeCartera(t.symbol)}>Vender</button>
                                  </div>
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="op-mobile-cards">
                    {tenenciasFiltradas().map((t) => (
                      <div key={t.symbol} className="op-card op-cart-card" onClick={() => toggleTenenciaExpandida(t.symbol)}>
                        <div className="op-id-row">
                          <span className="opt-sym">{t.symbol}</span>
                          <span className="ori-chip">{instrumentoLabel[t.instrumento]}</span>
                          {t.estimado ? <span className="ori-chip warn">estimado</span> : null}
                        </div>
                        <div className="op-dolares-row">
                          <div className="op-dollar-item">
                            <span className="od-lbl">Cantidad</span>
                            <span className="od-val num">{fmt(t.cantidad, 0)}</span>
                          </div>
                          <div className="op-dollar-item">
                            <span className="od-lbl">Precio prom.</span>
                            <span className="od-val num">{fmt(t.precioPromedio)}</span>
                          </div>
                          <div className="op-dollar-item">
                            <span className="od-lbl">Valor actual</span>
                            <span className="od-val num">{fmt(t.valorActual)}</span>
                          </div>
                        </div>
                        <div className={cx('op-cart-delta', t.pnl >= 0 && 'pos', t.pnl < 0 && 'neg')}>
                          <span className="od-lbl">P&amp;L</span>
                          <span className="op-cart-delta-val num">{t.pnl >= 0 ? '+' : ''}{fmt(t.pnl)}</span>
                        </div>
                        {tenenciaExpandida() === t.symbol ? (
                          <div className="op-subtabs">
                            <button className="op-subtab on" type="button" onClick={() => comprarMasDesdeCartera(t.symbol)}>Comprar más</button>
                            <button className="op-subtab sell" type="button" onClick={() => venderDesdeCartera(t.symbol)}>Vender</button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="op-empty">
                  No tenés tenencias de este tipo.
                  <button className="op-empty-cta" type="button" onClick={() => tenenciasFiltro.set('todos')}>Ver todos</button>
                </div>
              )}
            </>
          ) : (
            <div className="op-empty">
              Todavía no tenés compras simuladas.
              <button className="op-empty-cta" type="button" onClick={() => goHome()}>Elegí un símbolo para comprar</button>
            </div>
          )
        ) : (
          movimientosOrdenados().length ? (
            <>
              <div className="op-table-wrap op-cartera-table">
                <table>
                  <thead>
                    <tr>
                      <th>Tipo</th>
                      <th>Símbolo</th>
                      <th className="num">Cantidad</th>
                      <th className="num">Precio</th>
                      <th className="num">Monto</th>
                      <th>Plazo</th>
                      <th>Liquidación est.</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movimientosOrdenados().map((m) => (
                      <tr key={m.id} className={cx(m.tipo === 'compra' && 'op-buy', m.tipo === 'venta' && 'op-sell')}>
                        <td>{m.tipo === 'compra' ? 'Compra' : 'Venta'}</td>
                        <td>
                          <span className="opt-sym">{m.symbol}</span>
                          <span className="ori-chip">{instrumentoLabel[m.instrumento]}</span>
                        </td>
                        <td className="num">{fmt(m.cantidad, 0)}</td>
                        <td className="num">{fmt(m.precio)}</td>
                        <td className="num">{fmt(m.monto)}</td>
                        <td>{plazoLabel(m.plazo)}</td>
                        <td>{m.fechaLiquidacionEstimada}</td>
                        <td>
                          <span className={cx('ori-chip', m.estado === 'simulada_pendiente' && 'warn', m.estado === 'simulada_liquidada' && 'pos')}>
                            {m.estado === 'simulada_pendiente' ? 'Pendiente' : 'Liquidada'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="op-mobile-cards">
                {movimientosOrdenados().map((m) => (
                  <div key={m.id} className="op-card op-cart-card">
                    <div className="op-cart-top">
                      <div className="op-id-row">
                        <span className="opt-sym">{m.symbol}</span>
                        <span className={cx('ori-chip', m.tipo === 'compra' && 'accent', m.tipo === 'venta' && 'warn')}>
                          {m.tipo === 'compra' ? 'Compra' : 'Venta'}
                        </span>
                      </div>
                      <span className="of-hint">{relativeTime(m.timestamp)}</span>
                    </div>
                    <div className="op-dolares-row">
                      <div className="op-dollar-item">
                        <span className="od-lbl">Cantidad</span>
                        <span className="od-val num">{fmt(m.cantidad, 0)}</span>
                      </div>
                      <div className="op-dollar-item">
                        <span className="od-lbl">Precio</span>
                        <span className="od-val num">{fmt(m.precio)}</span>
                      </div>
                      <div className="op-dollar-item">
                        <span className="od-lbl">Monto</span>
                        <span className="od-val num">{fmt(m.monto)}</span>
                      </div>
                    </div>
                    <span className={cx('ori-chip op-cart-status', m.estado === 'simulada_pendiente' && 'warn', m.estado === 'simulada_liquidada' && 'pos')}>
                      {m.estado === 'simulada_pendiente' ? 'Pendiente' : 'Liquidada'}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="op-empty">
              Todavía no tenés movimientos simulados.
              <button className="op-empty-cta" type="button" onClick={() => goHome()}>Elegí un símbolo para comprar</button>
            </div>
          )
        )}
      </>
    );
  }

  return (
    <div className="operar">
      {subview() === 'home' ? renderHome()
        : subview() === 'panel' ? renderPanel()
        : subview() === 'ficha' ? renderFicha()
        : subview() === 'ticket' ? renderTicket()
        : subview() === 'cartera' ? renderCartera()
        : null}
    </div>
  );
}

import { Component, OnDestroy, OnInit, ViewChild, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
// RouterLink se quitó al ocultar el botón "Operaciones" del nav (su único uso);
// si se restaura ese botón (ver comentario en app.html), reañadir RouterLink acá
// y al array de imports.
import { Router, RouterOutlet, NavigationEnd } from '@angular/router';
import { forkJoin, Observable, Subscription, timer } from 'rxjs';
import { catchError, filter, map, of, switchMap } from 'rxjs';
import * as XLSX from 'xlsx';
import { runTour } from './tour.util';
import { ArbitrageComponent } from './arbitrage.component';
import { CotizacionesComponent } from './cotizaciones.component';
import { CedearsHeatmapComponent } from './cedears-heatmap.component';
import {
  ARB_TABS, DEFAULTS, ArbTab, CedearRow, Settlement, cohenCedearsUrl, iolCedearsUrl,
  bondType, noteType, INDEX_SPECS, ETF_SPECS, QuoteSpec, yahooSparkUrl,
} from './market.config';
import { scanOpportunities, nextAlertState } from './arb-engine';
import { saveSnapshot, loadSnapshot } from './panel-snapshot';
import type { ArbOpportunity, MonitorSettings } from './arb-engine';
import { isMarketOpen, isValidTimeRange, saveMarketHoursOverride, getEffectiveMarketHours } from './market-hours.config';
import { listenParentTour, isEmbedded } from './parent-tour.util';

interface PanelDef {
  id: string;
  label: string;
  url?: string;    // fuente de FALLBACK (data912 / dolarapi)
  iolUrl?: string; // fuente PRIMARIA (IOL vía serverless api/iol/panel.js)
  // optional transformer (e.g. dólar returns objects with nested fields)
  transform?: (raw: any) => any[];
}

// Panels de datos. IOL es la fuente primaria (iolUrl); data912 queda como
// fallback (url) si IOL falla o devuelve vacío. CEDEARs mantiene su propio
// flujo IOL por plazo (api/iol/cedears.js); Dólar no existe en IOL.
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

// Último close cuyo timestamp (epoch s) sea <= hoy - daysBack; la serie viene
// diaria y ascendente. Fallback al primer close de la serie (rango 1y): sirve
// para "% Año" cuando el primer punto cae unos días después del target.
function refCloseAt(ts: number[], close: (number | null)[], daysBack: number): number | null {
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
interface FeedResult {
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
const COT_TOUR_SEEN_KEY = 'hasSeenCotizacionesModeTutorial';

// Fuente que efectivamente entregó el libro de CEDEARs de un plazo.
type CedearsSrc = 'cohen' | 'iol' | null;

// Vista de primer nivel del navbar.
type View = 'arbitraje' | 'cotizaciones' | 'operaciones';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterOutlet, ArbitrageComponent, CotizacionesComponent, CedearsHeatmapComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private router = inject(Router);
  // Referencia al <app-arbitrage #arb> del template — sólo existe mientras
  // view() === 'arbitraje' (vive dentro de un @if). La usa showHelp() para
  // relanzar a mano el tour de esa vista.
  @ViewChild('arb') private arbComponent?: ArbitrageComponent;

  panels = PANELS;
  arbTabs = ARB_TABS;
  activePanel = signal<string>(ARB_TABS[0].id);

  // Nav de primer nivel (Arbitraje / Cotizaciones) y, dentro de Cotizaciones,
  // el casillero de detalle abierto ("Ver todo"); null = mosaico.
  view = signal<View>('arbitraje');
  detailPanel = signal<string | null>(null);
  // Wrapper para pasar panelStatus como input a <app-cotizaciones>.
  statusFn = (id: string) => this.panelStatus(id);

  // panelId -> rows
  data = signal<Record<string, any[]>>({});
  // panelId -> error string
  errors = signal<Record<string, string | null>>({});
  // panelId -> last update timestamp
  lastUpdated = signal<Record<string, Date | null>>({});
  // panelId -> true si las filas vigentes vinieron de IOL (false = data912).
  feedSource = signal<Record<string, boolean | undefined>>({});

  paused = signal(false);
  marketClosedAutoPause = signal(false);
  effectivePaused = computed(() => this.paused() || this.marketClosedAutoPause());
  // Horario de mercado editable (dropdown "Horario" del toolbar). Arranca
  // desde el override guardado en localStorage o, si no hay, el default de
  // market-hours.config.ts — ese archivo sigue siendo el fallback real.
  hoursMenuOpen = signal(false);
  marketHoursOpenInput = signal<string>(getEffectiveMarketHours().open);
  marketHoursCloseInput = signal<string>(getEffectiveMarketHours().close);
  marketHoursError = signal(false);
  intervalSec = signal<number>(DEFAULTS.refreshSec);
  // Modo de la pantalla Cotizaciones (Ley de Hick): 'basico' muestra solo lo
  // esencial; 'avanzado' el mosaico completo. Persiste en localStorage.
  uiMode = signal<'basico' | 'avanzado'>(
    localStorage.getItem('boston-cot-mode') === 'avanzado' ? 'avanzado' : 'basico'
  );
  loading = signal(false);
  filter = signal('');

  // Filas de CEDEARs por plazo. Prioridad: Cohen (feed Primary/XOMS) → IOL.
  // data912 quedó fuera de esta cadena. Si CI no tiene fuente real, se estima
  // desde el libro de 24hs (nunca desde data912).
  cedearsT0 = signal<CedearRow[]>([]); // Contado Inmediato
  cedearsT1 = signal<CedearRow[]>([]); // 24hs
  // true = libro real del plazo (Cohen o IOL); false = sin fuente real (CI estimado).
  iolSource = signal<{ t0: boolean; t1: boolean }>({ t0: false, t1: false });
  // Quién entregó cada plazo (para la etiqueta de estado).
  cedearsFeed = signal<{ t0: CedearsSrc; t1: CedearsSrc }>({ t0: null, t1: null });

  // Monitor de oportunidades de arbitraje.
  alertsEnabled = signal<boolean>(true);
  activeAlerts = signal<ArbOpportunity[]>([]);
  // Mejor round-trip por pestaña (sin umbral): alimenta "Mejores
  // oportunidades" del modo simple de Cotizaciones.
  bestOpps = signal<ArbOpportunity[]>([]);
  private armed: Record<string, boolean> = {};      // por tabId; true = listo para disparar
  private audioCtx?: AudioContext;
  private alertBuffer?: AudioBuffer;                 // /alert.wav decodificado
  private alertBufferLoading = false;
  private unlockAudio = () => this.initAudio();
  private monitorSettings: MonitorSettings = {
    commissionPct: DEFAULTS.commissionPct,
    minUsdVol: DEFAULTS.minUsdVol,
    ciAdjustPct: DEFAULTS.ciAdjustPct,
  };

  private sub?: Subscription;
  // Suscripción a router.events para el sync de deep-link (ver ngOnInit).
  private sub2?: Subscription;
  /** Baja del listener del tutorial dirigido desde el parent (boston-ar). */
  private stopParentTour?: () => void;
  /**
   * Embebidos en boston-ar el tutorial lo maneja el parent (con su propio botón
   * "?"), así que ocultamos el de acá: dejarlo visible sería un botón que no
   * hace nada, porque runTour() corta cuando detecta el iframe.
   */
  readonly embedded = isEmbedded();
  // Guard del burst CI: evita encolar bursts t0 cuando el anterior sigue en vuelo.
  private t0InFlight = false;

  // Estado del ciclo Yahoo (índices/ETFs): throttle + refs 1y por símbolo.
  private yahooInFlight = false;
  private lastYahooMs = 0;
  private yahooRefs = new Map<string, { w: number | null; y: number | null }>();
  private yahooRefsReady = false;
  private yahooRefsInFlight = false;

  // ArbTab activa, o null si la pestaña activa es una data tab.
  activeArbTab = computed<ArbTab | null>(() => {
    const id = this.activePanel();
    return this.arbTabs.find((t) => t.id === id) ?? null;
  });

  // Filas que recibe el componente de arbitraje según el plazo de la pestaña activa.
  activeArbRows = computed<CedearRow[]>(() => {
    const tab = this.activeArbTab();
    if (!tab) return [];
    return tab.settlement === 'CI' ? this.cedearsT0() : this.cedearsT1();
  });

  // ¿La pestaña activa muestra precios reales de plazo (IOL) o estimados (fallback)?
  activeCiIsReal = computed<boolean>(() => {
    const tab = this.activeArbTab();
    if (!tab) return false;
    return tab.settlement === 'CI' ? this.iolSource().t0 : this.iolSource().t1;
  });

  // Título y estado de la subbar: sub-tab de arbitraje, o el casillero de
  // Cotizaciones cuya vista detalle ("Ver todo") está abierta.
  subbarTitle = computed<string>(() => {
    if (this.view() === 'arbitraje') return this.activeArbTab()?.label ?? '';
    const id = this.detailPanel();
    if (!id) return '';
    if (id === 'mapa-cedears') return 'Mapa de calor';
    return this.panels.find((p) => p.id === id)?.label ?? '';
  });
  subbarStatus = computed<string>(() => {
    if (this.view() === 'arbitraje') return this.panelStatus(this.activePanel());
    const id = this.detailPanel();
    // El mapa de calor es una vista del feed de CEDEARs.
    return id ? this.panelStatus(id === 'mapa-cedears' ? 'cedears' : id) : '';
  });

  // Filas/columnas de la vista detalle (casillero abierto vía "Ver todo").
  detailRows = computed(() => {
    const id = this.detailPanel();
    let rows = id ? (this.data()[id] ?? []) : [];
    // Bonos/Letras: columna "Tipo" (CER, Bonares, Globales, …) también en el
    // detalle — y de paso el filtro de texto matchea por tipo.
    if (id === 'bonos' || id === 'letras') {
      const classify = id === 'bonos' ? bondType : noteType;
      rows = rows.map((r) => ({ symbol: r?.symbol, tipo: classify(String(r?.symbol ?? '')), ...r }));
    }
    const q = this.filter().trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q))
    );
  });

  detailColumns = computed<string[]>(() => {
    const id = this.detailPanel();
    const rows = id ? (this.data()[id] ?? []) : [];
    if (!rows.length) return [];
    const cols = new Set<string>();
    for (const r of rows.slice(0, 10)) Object.keys(r).forEach((k) => cols.add(k));
    return Array.from(cols);
  });

  ngOnInit() {
    this.marketClosedAutoPause.set(!isMarketOpen());
    this.refreshAll();
    this.startTimer();
    // Primer gesto en la página → desbloquear el audio (política de autoplay)
    // para que la alerta pueda sonar aunque la pestaña quede en segundo plano
    // o el navegador minimizado.
    document.addEventListener('pointerdown', this.unlockAudio, { once: true });
    document.addEventListener('keydown', this.unlockAudio, { once: true });

    // Deep link directo a /operar/{ticker} (link compartido, refresh de
    // página, back/forward del navegador): sincroniza el tab de primer
    // nivel a 'operaciones' para que el nav de arriba refleje la URL real,
    // sin que el usuario tenga que clickear "Operar" a mano.
    this.sub2 = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        if (e.urlAfterRedirects.startsWith('/operar') && this.view() !== 'operaciones') {
          this.view.set('operaciones');
        }
      });

    // Tutorial dirigido desde boston-ar: el tour corre en el parent y nos manda
    // qué solapa abrir y qué módulo resaltar en cada paso. Fuera del iframe no
    // llega ningún mensaje, así que esto es inerte en uso directo.
    this.stopParentTour = listenParentTour(
      () => this.view(),
      (v) => this.setView(v),
    );

    // Marca para el CSS: cinturón de seguridad que esconde cualquier popover u
    // overlay de driver.js que llegara a montarse dentro del iframe. runTour()
    // ya corta antes, pero si en el futuro alguien instancia driver a mano, el
    // tutorial del parent no queda con dos tarjetas encimadas.
    if (this.embedded) document.body.classList.add('bam-embedded');
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
    this.sub2?.unsubscribe();
    this.stopParentTour?.();
    document.removeEventListener('pointerdown', this.unlockAudio);
    document.removeEventListener('keydown', this.unlockAudio);
  }

  private startTimer() {
    this.sub?.unsubscribe();
    this.sub = timer(this.intervalSec() * 1000, this.intervalSec() * 1000).subscribe(() => {
      const open = isMarketOpen();
      this.marketClosedAutoPause.set(!open);
      if (!this.paused() && open) this.refreshAll();
    });
  }

  onIntervalChange() {
    this.startTimer();
  }

  togglePause() {
    this.paused.update((v) => !v);
  }

  setUiMode(m: 'basico' | 'avanzado') {
    this.uiMode.set(m);
    try { localStorage.setItem('boston-cot-mode', m); } catch {}
  }

  toggleHoursMenu() {
    this.hoursMenuOpen.update((v) => !v);
  }

  closeHoursMenu() {
    this.hoursMenuOpen.set(false);
  }

  setMarketHoursOpen(v: string) {
    this.marketHoursOpenInput.set(v);
    this.applyMarketHours();
  }

  setMarketHoursClose(v: string) {
    this.marketHoursCloseInput.set(v);
    this.applyMarketHours();
  }

  // Valida apertura < cierre; si no vale, marca el error y NO persiste (el
  // último valor válido guardado sigue rigiendo). Si vale, persiste y
  // reevalúa isMarketOpen() ya mismo — no espera al próximo tick del timer.
  private applyMarketHours() {
    const open = this.marketHoursOpenInput();
    const close = this.marketHoursCloseInput();
    const valid = isValidTimeRange(open, close);
    this.marketHoursError.set(!valid);
    if (!valid) return;
    saveMarketHoursOverride(open, close);
    this.marketClosedAutoPause.set(!isMarketOpen());
  }

  refreshAll() {
    // Ciclos independientes: los feeds rápidos no esperan al burst CI lento
    // ni al ciclo Yahoo (que además corre cada YAHOO_REFRESH_MS, no cada tick).
    this.refreshFast();
    this.refreshT0();
    this.refreshIndices();
  }

  // Índices internacionales y ETFs (Yahoo spark, 1 request por casillero).
  private refreshIndices() {
    if (!isMarketOpen()) return;
    const now = Date.now();
    if (this.yahooInFlight || now - this.lastYahooMs < YAHOO_REFRESH_MS) return;
    this.yahooInFlight = true;
    this.lastYahooMs = now;
    this.loadYahooRefs();

    const feeds: [string, QuoteSpec[]][] = [['indices', INDEX_SPECS], ['etfs', ETF_SPECS]];
    const calls = feeds.map(([id, specs]) =>
      this.http.get<any>(yahooSparkUrl(specs.map((s) => s.code), '1d', '5m')).pipe(
        map((res) => ({ id, specs, res, error: null as string | null })),
        catchError((err) => of({ id, specs, res: null, error: (err?.message ?? 'Error de red') as string | null }))
      )
    );
    forkJoin(calls).subscribe((results) => {
      this.yahooInFlight = false;
      const dataAcc = { ...this.data() };
      const errAcc = { ...this.errors() };
      const tsAcc = { ...this.lastUpdated() };
      const ts = new Date();
      for (const r of results) {
        const rows = r.res ? this.sparkRows(r.specs, r.res) : [];
        if (rows.length) {
          dataAcc[r.id] = rows;
          errAcc[r.id] = null;
          tsAcc[r.id] = ts;
        } else {
          errAcc[r.id] = r.error ?? 'sin datos';
        }
      }
      this.data.set(dataAcc);
      this.errors.set(errAcc);
      this.lastUpdated.set(tsAcc);
    });
  }

  // spark 1d → filas con la forma común de la app. `symbol` es el nombre
  // legible (S&P 500) y `code` el símbolo Yahoo; % Sem./% Año salen de los
  // cierres de referencia 1y (yahooRefs).
  private sparkRows(specs: QuoteSpec[], res: any): any[] {
    const rows: any[] = [];
    for (const s of specs) {
      const d = res?.[s.code];
      const closes: number[] = (d?.close ?? []).filter((x: any) => x != null && +x > 0);
      if (!closes.length) continue;
      const last = closes[closes.length - 1];
      const prev = +d?.chartPreviousClose || 0;
      const refs = this.yahooRefs.get(s.code);
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
  private loadYahooRefs() {
    if (this.yahooRefsReady || this.yahooRefsInFlight) return;
    this.yahooRefsInFlight = true;
    const feeds = [INDEX_SPECS, ETF_SPECS];
    const calls = feeds.map((specs) =>
      this.http.get<any>(yahooSparkUrl(specs.map((s) => s.code), '1y', '1d')).pipe(
        catchError(() => of(null))
      )
    );
    forkJoin(calls).subscribe((results) => {
      this.yahooRefsInFlight = false;
      let any = false;
      for (const res of results) {
        if (!res) continue;
        for (const code of Object.keys(res)) {
          const d = res[code];
          if (!d?.timestamp?.length || !d?.close?.length) continue;
          this.yahooRefs.set(code, {
            w: refCloseAt(d.timestamp, d.close, 7),
            y: refCloseAt(d.timestamp, d.close, 365),
          });
          any = true;
        }
      }
      if (any) {
        this.yahooRefsReady = true;
        // Fuerza un ciclo 1d inmediato para que % Sem./% Año aparezcan ya,
        // sin esperar los YAHOO_REFRESH_MS del throttle.
        this.lastYahooMs = 0;
      }
    });
  }

  // Feeds rápidos: IOL como fuente primaria de cada panel (1 request por panel
  // vía api/iol/panel.js) con data912 en paralelo como fallback si IOL falla o
  // viene vacío; más dólar e IOL 24hs de CEDEARs. Renderiza en cuanto llegan,
  // sin bloquearse por el burst CI (que va en refreshT0()).
  private refreshFast() {
    if (!isMarketOpen()) return;
    if (this.loading()) return;
    this.loading.set(true);
    // El casillero CEDEARs ya no se pide a data912: lo llena la cadena
    // Cohen → IOL de 24hs (abajo). El resto de los paneles sigue igual.
    const fetchable = PANELS.filter((p) => !!p.url && p.id !== 'cedears');
    const calls: Observable<FeedResult>[] = fetchable.map((p) => {
      const fallback = this.http.get<any>(p.url!).pipe(
        map((res) => ({ rows: this.normalize(res), error: null as string | null })),
        catchError((err) =>
          of({ rows: [] as any[], error: (err?.message ?? 'Error de red') as string | null })
        )
      );
      if (!p.iolUrl) {
        return fallback.pipe(map((r) => ({ id: p.id, rows: r.rows, error: r.error })));
      }
      const iol = this.http.get<any>(p.iolUrl).pipe(
        map((res) => this.normalize(res)),
        catchError(() => of([] as any[]))
      );
      return forkJoin([iol, fallback]).pipe(
        map(([iolRows, fb]): FeedResult =>
          iolRows.length
            ? { id: p.id, rows: iolRows, error: null, iol: true }
            : { id: p.id, rows: fb.rows, error: fb.error, iol: false }
        )
      );
    });
    // CEDEARs 24hs: Cohen → IOL (data912 fuera de la cadena).
    calls.push(
      this.fetchCedears('H24').pipe(
        map(({ rows, src }) => ({ id: '__cedears_t1', rows, error: null as string | null, src }))
      )
    );

    forkJoin(calls).subscribe((results) => {
      const dataAcc = { ...this.data() };
      const errAcc = { ...this.errors() };
      const tsAcc = { ...this.lastUpdated() };
      const srcAcc = { ...this.feedSource() };
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
      this.cedearsT1.set(t1Rows);
      this.iolSource.update((s) => ({ ...s, t1: t1Real }));
      this.cedearsFeed.update((f) => ({ ...f, t1: t1Src }));
      // El casillero CEDEARs de Cotizaciones usa el mismo libro.
      dataAcc['cedears'] = t1Rows;
      errAcc['cedears'] = t1Real ? null : 'sin datos';
      if (t1Real) tsAcc['cedears'] = now;

      this.data.set(dataAcc);
      this.errors.set(errAcc);
      this.lastUpdated.set(tsAcc);
      this.feedSource.set(srcAcc);
      this.loading.set(false);
      this.runMonitor();
    });
  }

  // Libro de CEDEARs de un plazo con prioridad Cohen → IOL → último snapshot
  // válido conocido (localStorage) → []. Si Cohen falla o devuelve vacío
  // (auth pendiente, feed caído, mercado cerrado) se pide a IOL; si IOL
  // TAMBIÉN falla o devuelve vacío, se sirve el último libro real guardado
  // (ver panel-snapshot.ts) en vez de dejar el panel sin datos. Sólo si no
  // hay ningún snapshot guardado (primera ejecución en un navegador limpio)
  // se retorna vacío. src indica quién entregó filas; null = snapshot o
  // ninguna fuente respondió con datos.
  private fetchCedears(s: Settlement): Observable<{ rows: CedearRow[]; src: CedearsSrc }> {
    const asRows = (raw: unknown): CedearRow[] => (Array.isArray(raw) ? raw : []);
    const fromSnapshot = (): { rows: CedearRow[]; src: CedearsSrc } => {
      const snap = loadSnapshot(s);
      return { rows: snap ?? [], src: null };
    };
    const iol$ = this.http.get<CedearRow[]>(iolCedearsUrl(s)).pipe(
      map((raw) => {
        const rows = asRows(raw);
        if (rows.length) {
          saveSnapshot(s, rows);
          return { rows, src: 'iol' as CedearsSrc };
        }
        return fromSnapshot();
      }),
      catchError(() => of(fromSnapshot()))
    );
    const cohenUrl = cohenCedearsUrl(s);
    if (!cohenUrl) return iol$;
    return this.http.get<CedearRow[]>(cohenUrl).pipe(
      map(asRows),
      catchError(() => of([] as CedearRow[])),
      switchMap((rows) => {
        if (rows.length) {
          saveSnapshot(s, rows);
          return of({ rows, src: 'cohen' as CedearsSrc });
        }
        return iol$;
      })
    );
  }

  // Burst CI (t0): Cohen entrega el libro CI real al instante; si no hay, IOL
  // cotiza símbolo por símbolo (feed caro/lento que se auto-regula: no relanza
  // hasta que el burst anterior terminó). Sin fuente real, el motor estima el
  // CI desde el libro de 24hs (iolSource.t0=false).
  private refreshT0() {
    if (!isMarketOpen()) return;
    if (this.t0InFlight) return;
    this.t0InFlight = true;
    this.fetchCedears('CI').subscribe(({ rows, src }) => {
      this.t0InFlight = false;
      const t0Real = rows.length > 0;
      this.cedearsT0.set(t0Real ? rows : this.cedearsT1());
      this.iolSource.update((s) => ({ ...s, t0: t0Real }));
      this.cedearsFeed.update((f) => ({ ...f, t0: src }));
      this.runMonitor();
    });
  }

  private normalize(raw: any): any[] {
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.results)) return raw.results;
    if (raw && typeof raw === 'object') return [raw];
    return [];
  }

  setActive(id: string) {
    this.activePanel.set(id);
    this.view.set('arbitraje');
    this.filter.set('');
  }

  setView(v: View) {
    this.view.set(v);
    this.detailPanel.set(null);
    this.filter.set('');
    // 'operaciones' vive detrás del router (ver app.routes.ts / RouterOutlet
    // en app.html): el tab "Operaciones" es un <a routerLink="/operar"> — la
    // propia directiva ya dispara la navegación al clickear, así que acá sólo
    // sincronizamos el signal local para que el estado activo del nav sea
    // instantáneo (sin esperar el NavigationEnd). Si en el futuro se llama a
    // setView('operaciones') sin pasar por el link (ej. programático), se
    // navega manualmente como red de seguridad.
    if (v === 'operaciones' && !this.router.url.startsWith('/operar')) {
      this.router.navigate(['/operar']);
    }
  }

  private startCotizacionesTour(force = false) {
    if (!document.querySelector('.seg-mode')) return; // vista cambió antes de que corriera el timeout
    runTour([
      {
        element: '#cot-mode-basico',
        popover: {
          title: 'Modo Simple',
          description: 'Muestra un resumen rápido con los números principales del mercado.',
        },
      },
      {
        element: '#cot-mode-avanzado',
        popover: {
          title: 'Modo Avanzado',
          description: 'Te permite ver todas las tablas detalladas, historial y mucha más información.',
        },
      },
    ], COT_TOUR_SEEN_KEY, { force });
  }

  // Botón "Ayuda" de la toolbar: único punto de entrada al tour de la vista
  // actual (el auto-disparo de primera vez se quitó); force=true ignora el
  // flag "visto" de localStorage.
  showHelp() {
    if (this.view() === 'arbitraje') {
      this.arbComponent?.startTour(true);
    } else if (this.view() === 'cotizaciones') {
      this.startCotizacionesTour(true);
    }
  }

  openDetail(id: string) {
    this.detailPanel.set(id);
    this.filter.set('');
  }

  closeDetail() {
    this.detailPanel.set(null);
    this.filter.set('');
  }

  downloadXLSX() {
    const wasPaused = this.paused();
    this.paused.set(true);
    try {
      const wb = XLSX.utils.book_new();
      const snapshot = this.data();
      const ts = this.lastUpdated();
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
      if (!wasPaused) this.paused.set(false);
    }
  }

  // Etiqueta en español de una columna cruda del feed (vista detalle).
  colLabel(col: string): string {
    return COL_LABELS[col] ?? col;
  }

  isNumCol(col: string): boolean {
    return !TEXT_COLS.has(col);
  }

  fmt(v: any): string {
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

  panelStatus(id: string): string {
    // Las arb tabs no tienen url propia: usan el feed de CEDEARs (Cohen → IOL).
    const arbTab = this.arbTabs.find((t) => t.id === id);
    if (arbTab) {
      const ts = this.lastUpdated()['cedears'];
      if (!ts) return 'esperando CEDEARs…';
      const sec = Math.round((Date.now() - ts.getTime()) / 1000);
      // Sin nombre de proveedor en la UI (pedido de Elio 2026-07-23: no
      // exponer qué APIs usamos en el dashboard) — sólo se distingue el caso
      // "estimado desde 24hs" porque es una calidad de dato, no una fuente.
      const isCi = arbTab.settlement === 'CI';
      const real = isCi ? this.iolSource().t0 : this.iolSource().t1;
      const src = isCi ? this.cedearsFeed().t0 : this.cedearsFeed().t1;
      const estimado = !src && !real;
      return `hace ${sec}s${estimado ? ' · estimado desde 24hs' : ''}`;
    }
    const ts = this.lastUpdated()[id];
    const err = this.errors()[id];
    if (err) return `error: ${err.substring(0, 30)}`;
    if (!ts) return '—';
    const sec = Math.round((Date.now() - ts.getTime()) / 1000);
    return `hace ${sec}s`;
  }

  // --- Monitor de alertas ---

  private runMonitor() {
    const opps = scanOpportunities(
      this.cedearsT0(), this.cedearsT1(), this.iolSource(), this.monitorSettings
    );
    this.bestOpps.set([...opps].sort((a, b) => b.netPct - a.netPct));
    const byTab = new Map(opps.map(o => [o.tabId, o] as const));
    let fired = false;
    for (const tab of ARB_TABS) {
      const net = byTab.get(tab.id)?.netPct ?? Number.NEGATIVE_INFINITY;
      const prev = this.armed[tab.id] ?? true;
      const s = nextAlertState(prev, net, { fire: ALERT_FIRE, rearm: ALERT_REARM });
      this.armed[tab.id] = s.armed;
      if (s.fire) fired = true;
    }
    this.activeAlerts.set(
      opps.filter(o => o.netPct >= ALERT_FIRE).sort((a, b) => b.netPct - a.netPct)
    );
    if (fired && this.alertsEnabled()) this.playBeep();
  }

  toggleAlerts() {
    const next = !this.alertsEnabled();
    this.alertsEnabled.set(next);
    if (next) this.initAudio();   // el click cuenta como gesto → habilita el audio
  }

  private initAudio() {
    try {
      if (!this.audioCtx) {
        const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (Ctor) this.audioCtx = new Ctor();
      }
      if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();
      this.loadAlertSound();
    } catch { /* audio no disponible: ignorar */ }
  }

  // Pre-carga /alert.wav como AudioBuffer. Web Audio reproduce igual con la
  // pestaña en segundo plano o el navegador minimizado, siempre que el
  // contexto se haya desbloqueado con un gesto del usuario.
  private loadAlertSound() {
    if (this.alertBuffer || this.alertBufferLoading || !this.audioCtx) return;
    this.alertBufferLoading = true;
    fetch('/alert.wav')
      .then((r) => r.arrayBuffer())
      .then((buf) => this.audioCtx!.decodeAudioData(buf))
      .then((decoded) => { this.alertBuffer = decoded; })
      .catch(() => { this.alertBufferLoading = false; });
  }

  private playBeep() {
    try {
      this.initAudio();
      const ctx = this.audioCtx;
      if (!ctx) return;
      // Sonido custom de alerta; beep sintetizado sólo si el .wav aún no cargó.
      if (this.alertBuffer) {
        const src = ctx.createBufferSource();
        src.buffer = this.alertBuffer;
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
}

"use client";

/**
 * page.tsx — El shell de la app (ex src/app/app.html + el binding de app.ts).
 *
 * El estado y el ciclo de datos viven en lib/store.ts; acá está el árbol de
 * UI, el ciclo de vida (ex ngOnInit/ngOnDestroy → useEffect de montaje) y los
 * `computed()` del original resueltos como cálculo de render.
 *
 * Los `class` del template Angular se portan intactos: el CSS es global y
 * verbatim (app/shell.css), no hay CSS Modules — ver MIGRATION-CONTRACT §5-bis.
 * Los `id`/clases que el tour de boston-ar busca por selector son API pública
 * de facto y NO se tocan: #cot-mode-basico, #cot-mode-avanzado, .seg-mode,
 * .arb-subtabs (§10).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import './shell.css';

import { useSignal } from '@/lib/signal';
import { bondType, noteType } from '@/lib/market.config';
import { isMarketOpen } from '@/lib/market-hours.config';
import { listenParentTour, isEmbedded } from '@/lib/parent-tour.util';
import Arbitrage, { type ArbitrageHandle } from '@/components/Arbitrage';
import Cotizaciones from '@/components/Cotizaciones';
import CedearsHeatmap from '@/components/CedearsHeatmap';
import {
  COT_TOUR_SEEN_KEY,
  activeAlerts,
  activePanel,
  alertsEnabled,
  arbTabs,
  bestOpps,
  cedearsFeed,
  cedearsT0,
  cedearsT1,
  closeDetail,
  closeHoursMenu,
  colLabel,
  data,
  detailPanel,
  downloadXLSX,
  errors,
  filter,
  fmt,
  hoursMenuOpen,
  hydrateFromStorage,
  initAudio,
  intervalSec,
  iolSource,
  isNumCol,
  lastUpdated,
  loading,
  marketClosedAutoPause,
  marketHoursCloseInput,
  marketHoursError,
  marketHoursOpenInput,
  onIntervalChange,
  openDetail,
  panelStatus,
  panels,
  paused,
  refreshAll,
  setActive,
  setMarketHoursClose,
  setMarketHoursOpen,
  setUiMode,
  setView,
  startTimer,
  stopTimer,
  toggleAlerts,
  toggleHoursMenu,
  togglePause,
  uiMode,
  view,
  type ArbTab,
  type CedearRow,
} from '@/lib/store';

export default function Shell() {
  const router = useRouter();
  // Ex `private router = inject(Router)` + `this.router.navigate(['/operar'])`:
  // lib/store.ts es código puro (sin hooks), así que el shell le presta el push.
  const navigate = (path: string) => router.push(path);

  // Suscripción a los signals del store: useSignal re-renderiza el shell
  // cuando cualquiera cambia. Después se leen llamándolos (`view()`, `data()`,
  // …) igual que en el template de Angular.
  useSignal(activePanel);
  useSignal(view);
  useSignal(detailPanel);
  useSignal(data);
  useSignal(errors);
  useSignal(lastUpdated);
  useSignal(paused);
  useSignal(marketClosedAutoPause);
  useSignal(hoursMenuOpen);
  useSignal(marketHoursOpenInput);
  useSignal(marketHoursCloseInput);
  useSignal(marketHoursError);
  useSignal(intervalSec);
  useSignal(uiMode);
  useSignal(loading);
  useSignal(filter);
  useSignal(cedearsT0);
  useSignal(cedearsT1);
  useSignal(iolSource);
  useSignal(cedearsFeed);
  useSignal(alertsEnabled);
  useSignal(activeAlerts);
  useSignal(bestOpps);

  // Ex `readonly embedded = isEmbedded()`: toca window.self/window.top, así que
  // no puede evaluarse en el render del server. Arranca en false (= el HTML del
  // server muestra el botón Ayuda) y se corrige al montar; embebido en
  // boston-ar el botón desaparece en el primer effect.
  const [embedded, setEmbedded] = useState(false);

  // Ex `@ViewChild('arb') arbComponent`: la referencia al componente de
  // arbitraje, que sólo existe mientras view() === 'arbitraje'. La usa
  // showHelp() para relanzar a mano el tour de esa vista.
  const arbRef = useRef<ArbitrageHandle | null>(null);

  // ex ngOnInit / ngOnDestroy.
  useEffect(() => {
    hydrateFromStorage();
    const emb = isEmbedded();
    setEmbedded(emb);

    marketClosedAutoPause.set(!isMarketOpen());
    refreshAll();
    startTimer();
    // Primer gesto en la página → desbloquear el audio (política de autoplay)
    // para que la alerta pueda sonar aunque la pestaña quede en segundo plano
    // o el navegador minimizado.
    document.addEventListener('pointerdown', initAudio, { once: true });
    document.addEventListener('keydown', initAudio, { once: true });

    // El deep link a /operar/{ticker} ya NO se sincroniza acá: en Angular el
    // shell escuchaba router.events porque /operar se pintaba dentro de su
    // <router-outlet>. En Next /operar y /operar/[ticker] son páginas propias
    // (app/operar), así que cada una fija su propio estado de nav — este shell
    // sólo renderiza en /.

    // Tutorial dirigido desde boston-ar: el tour corre en el parent y nos manda
    // qué solapa abrir y qué módulo resaltar en cada paso. Fuera del iframe no
    // llega ningún mensaje, así que esto es inerte en uso directo.
    const stopParentTour = listenParentTour(
      () => view(),
      (v) => setView(v, navigate),
    );

    // Marca para el CSS: cinturón de seguridad que esconde cualquier popover u
    // overlay de driver.js que llegara a montarse dentro del iframe. runTour()
    // ya corta antes, pero si en el futuro alguien instancia driver a mano, el
    // tutorial del parent no queda con dos tarjetas encimadas.
    if (emb) document.body.classList.add('bam-embedded');

    return () => {
      stopTimer();
      stopParentTour();
      document.removeEventListener('pointerdown', initAudio);
      document.removeEventListener('keydown', initAudio);
    };
    // Montaje/desmontaje únicos, como ngOnInit/ngOnDestroy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const effectivePaused = paused() || marketClosedAutoPause();

  // ArbTab activa, o null si la pestaña activa es una data tab.
  const activeArbTab: ArbTab | null = arbTabs.find((t) => t.id === activePanel()) ?? null;

  // Filas que recibe el componente de arbitraje según el plazo de la pestaña activa.
  const activeArbRows: CedearRow[] = !activeArbTab
    ? []
    : activeArbTab.settlement === 'CI' ? cedearsT0() : cedearsT1();

  // ¿La pestaña activa muestra precios reales de plazo (IOL) o estimados (fallback)?
  const activeCiIsReal: boolean = !activeArbTab
    ? false
    : activeArbTab.settlement === 'CI' ? iolSource().t0 : iolSource().t1;

  // Título y estado de la subbar: sub-tab de arbitraje, o el casillero de
  // Cotizaciones cuya vista detalle ("Ver todo") está abierta.
  const subbarTitle: string = (() => {
    if (view() === 'arbitraje') return activeArbTab?.label ?? '';
    const id = detailPanel();
    if (!id) return '';
    if (id === 'mapa-cedears') return 'Mapa de calor';
    return panels.find((p) => p.id === id)?.label ?? '';
  })();
  const subbarStatus: string = (() => {
    if (view() === 'arbitraje') return panelStatus(activePanel());
    const id = detailPanel();
    // El mapa de calor es una vista del feed de CEDEARs.
    return id ? panelStatus(id === 'mapa-cedears' ? 'cedears' : id) : '';
  })();

  // Filas/columnas de la vista detalle (casillero abierto vía "Ver todo").
  // useMemo porque el ciclo de datos re-renderiza el shell cada segundo y esto
  // mapea/filtra el feed completo del panel.
  const detailRows = useMemo(() => {
    const id = detailPanel();
    let rows = id ? (data()[id] ?? []) : [];
    // Bonos/Letras: columna "Tipo" (CER, Bonares, Globales, …) también en el
    // detalle — y de paso el filtro de texto matchea por tipo.
    if (id === 'bonos' || id === 'letras') {
      const classify = id === 'bonos' ? bondType : noteType;
      rows = rows.map((r) => ({ symbol: r?.symbol, tipo: classify(String(r?.symbol ?? '')), ...r }));
    }
    const q = filter().trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q))
    );
  }, [detailPanel(), data(), filter()]);

  const detailColumns = useMemo<string[]>(() => {
    const id = detailPanel();
    const rows = id ? (data()[id] ?? []) : [];
    if (!rows.length) return [];
    const cols = new Set<string>();
    for (const r of rows.slice(0, 10)) Object.keys(r).forEach((k) => cols.add(k));
    return Array.from(cols);
  }, [detailPanel(), data()]);

  // driver.js se carga on-demand (§6): sólo se usa al apretar "Ayuda".
  async function startCotizacionesTour(force = false) {
    if (!document.querySelector('.seg-mode')) return; // vista cambió antes de que corriera el timeout
    const { runTour } = await import('@/lib/tour.util');
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
  function showHelp() {
    if (view() === 'arbitraje') {
      arbRef.current?.startTour(true);
    } else if (view() === 'cotizaciones') {
      void startCotizacionesTour(true);
    }
  }

  const detailId = detailPanel();

  return (
    <>
      <header className="toolbar">
        <div className="brand" title="Boston Asset Management">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-logo" src="/boston-logo-dark.png" alt="Boston Asset Management" />
        </div>

        <nav className="nav">
          {/* Nav de primer nivel: Arbitraje / Cotizaciones */}
          <div className="seg">
            {/* Operar está OCULTO del nav (operatoria aún simulada, no lista para
                usuarios). El código sigue vivo: se entra navegando a /operar o
                /operar/[ticker] a mano (deep-link, ver app/operar). Para
                re-publicarlo, restaurar este botón (con Link de next/link):
                  <Link className={"seg-btn " + (view() === 'operaciones' ? 'on' : '')}
                        href="/operar" onClick={() => setView('operaciones', navigate)}>Operaciones</Link>
                y opcionalmente view = signal<View>('operaciones') en lib/store.ts. */}

            <button className={`seg-btn ${view() === 'arbitraje' ? 'on' : ''}`} onClick={() => setView('arbitraje', navigate)}>Arbitraje</button>
            <button className={`seg-btn ${view() === 'cotizaciones' ? 'on' : ''}`} onClick={() => setView('cotizaciones', navigate)}>Cotizaciones</button>
          </div>

          {/* Las 4 sub-tabs de arbitraje, solo visibles dentro de Arbitraje */}
          {view() === 'arbitraje' && (
            <div className="seg arb-subtabs">
              {arbTabs.map((t) => (
                <button
                  key={t.id}
                  className={`seg-btn ${activePanel() === t.id ? 'on' : ''}`}
                  onClick={() => setActive(t.id)}
                >{t.short}</button>
              ))}
            </div>
          )}
        </nav>

        <div className="controls">
          <button className="icon-btn" onClick={() => refreshAll()} disabled={loading()} title="Refrescar ahora">
            <svg className={loading() ? 'spin' : undefined} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
          </button>

          <label className="rate" title="Intervalo de refresco">
            <input
              type="number"
              min="1"
              max="300"
              value={intervalSec()}
              onChange={(e) => { intervalSec.set(Number(e.target.value)); onIntervalChange(); }}
            />
            <span>s</span>
          </label>

          {/* Horario de mercado editable: pisa el default de market-hours.config.ts,
              persiste en localStorage y aplica de inmediato (ver applyMarketHours en lib/store.ts). */}
          <div className="dropdown">
            <button
              type="button"
              className={`hours-trigger ${hoursMenuOpen() ? 'on' : ''}`}
              title="Horario de mercado"
              onClick={() => toggleHoursMenu()}
            >
              <span>{marketHoursOpenInput()}–{marketHoursCloseInput()}</span>
              <svg className={`chev ${hoursMenuOpen() ? 'up' : ''}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>

            {hoursMenuOpen() && (
              <div className="menu mh-menu">
                <div className="mh-row">
                  <label className="mh-field">
                    <span className="mi-label">Apertura</span>
                    <input
                      className={`mh-input ${marketHoursError() ? 'err' : ''}`}
                      type="time"
                      step="60"
                      value={marketHoursOpenInput()}
                      onChange={(e) => setMarketHoursOpen(e.target.value)}
                    />
                  </label>
                  <label className="mh-field">
                    <span className="mi-label">Cierre</span>
                    <input
                      className={`mh-input ${marketHoursError() ? 'err' : ''}`}
                      type="time"
                      step="60"
                      value={marketHoursCloseInput()}
                      onChange={(e) => setMarketHoursClose(e.target.value)}
                    />
                  </label>
                </div>
                {marketHoursError() && (
                  <div className="mh-error">Apertura tiene que ser antes que cierre.</div>
                )}
              </div>
            )}
          </div>

          {/* Toggle modo simple/avanzado — solo aplica a Cotizaciones. */}
          {view() === 'cotizaciones' && (
            <div className="seg seg-mode" title="Nivel de detalle de Cotizaciones">
              <button id="cot-mode-basico" className={`seg-btn ${uiMode() === 'basico' ? 'on' : ''}`} onClick={() => setUiMode('basico')}>Simple</button>
              <button id="cot-mode-avanzado" className={`seg-btn ${uiMode() === 'avanzado' ? 'on' : ''}`} onClick={() => setUiMode('avanzado')}>Avanzado</button>
            </div>
          )}

          <button className={`toggle ${effectivePaused ? 'paused' : ''}`} onClick={() => togglePause()}>
            <span className={`live-dot ${effectivePaused ? 'off' : ''}`}></span>
            {marketClosedAutoPause() ? (
              'Mercado cerrado'
            ) : (
              paused() ? 'Pausado' : 'En vivo'
            )}
          </button>

          <button className={`alert-toggle ${alertsEnabled() ? 'on' : ''}`} onClick={() => toggleAlerts()}
                  title={alertsEnabled() ? 'Avisos > 2% neto activados' : 'Avisos desactivados'}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            {!!activeAlerts().length && <span className="alert-badge">{activeAlerts().length}</span>}
          </button>

          {/* Embebidos, el tutorial lo maneja boston-ar con su propio botón "?": acá
              el botón quedaría sin efecto porque runTour() corta dentro del iframe. */}
          {view() !== 'operaciones' && !embedded && (
            <button className="help-btn" onClick={() => showHelp()} title="Ayuda / Tutorial">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/><circle cx="12" cy="12" r="10"/></svg>
            </button>
          )}

          <button className="export" onClick={() => void downloadXLSX()} title="Descargar snapshot XLSX">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            XLSX
          </button>
        </div>
      </header>

      {hoursMenuOpen() && (
        <div className="backdrop" onClick={() => closeHoursMenu()}></div>
      )}

      {!!activeAlerts().length && (
        <div className="alert-bar" role="status" aria-live="polite">
          <span className="ab-title">Oportunidades &gt; 2% neto</span>
          <div className="ab-items">
            {activeAlerts().map((a) => (
              <button key={a.tabId} className="alert-item" onClick={() => setActive(a.tabId)} title={`Ir a ${a.label}`}>
                <span className="ai-net">{fmt(a.netPct)}%</span>
                <span className="ai-tab">{a.label}</span>
                <span className="ai-trade">comprás <b>{a.buyBase}</b> · vendés <b>{a.sellBase}</b></span>
                <span className="ai-vol">USD {fmt(a.tradeableUsd)}</span>
                {a.ciEstimated && <span className="ai-est">estimado</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {(view() === 'arbitraje' || detailPanel()) && (
        <div className="subbar">
          <div className="crumb">
            {detailPanel() && (
              <button className="back-btn" onClick={() => closeDetail()}>← Cotizaciones</button>
            )}
            {/* En Arbitraje el título se omite: la categoría (dólar + plazo) ya la
                muestran los badges de arb-head dentro del componente, mostrarla acá
                arriba la duplicaba. Se mantiene para el detalle de Cotizaciones
                ("Ver todo" / Mapa de calor), que no tiene esos badges. */}
            {view() !== 'arbitraje' && (
              <strong>{subbarTitle}</strong>
            )}
            {/* En Arbitraje se oculta el "hace Xs": quedaba descolocado (sin título)
                y el estado de refresco ya lo da el intervalo (1 s) + "En vivo" del
                navbar. Se mantiene para el detalle de Cotizaciones. */}
            {view() !== 'arbitraje' && (
              <span className={`status-cap ${errors()[detailPanel() ?? activePanel()] ? 'err' : ''}`}>{subbarStatus}</span>
            )}
            {effectivePaused && (
              <span className="pill warn">{marketClosedAutoPause() ? 'Mercado cerrado' : 'Snapshot congelado'}</span>
            )}
          </div>

          {detailPanel() && detailPanel() !== 'mapa-cedears' && (
            <div className="subbar-tools">
              <input
                className="search"
                type="text"
                placeholder="Filtrar…"
                value={filter()}
                onChange={(e) => filter.set(e.target.value)}
              />
              <span className="count num">{detailRows.length}</span>
            </div>
          )}
        </div>
      )}

      <section className={`panel ${view() === 'arbitraje' ? 'arb-panel' : ''}`}>
        {view() === 'arbitraje' ? (
          <Arbitrage
            ref={arbRef}
            cedearRows={activeArbRows}
            dollarType={activeArbTab!.dollarType}
            settlement={activeArbTab!.settlement}
            ciIsReal={activeCiIsReal}
            paused={effectivePaused}
            onPausedChange={(v) => paused.set(v)}
            marketClosed={marketClosedAutoPause()}
          />
        ) : view() === 'operaciones' ? (
          // Ex <router-outlet />: en Angular /operar se pintaba DENTRO de este
          // shell. En Next /operar y /operar/[ticker] son páginas propias
          // (app/operar), así que acá no hay outlet que renderizar: la
          // navegación la dispara setView('operaciones', navigate) con
          // router.push('/operar'), igual que la red de seguridad del setView
          // de Angular. Esta rama sólo se ve el instante previo al push.
          null
        ) : detailPanel() === 'mapa-cedears' ? (
          errors()['cedears'] ? (
            <div className="error-box">No se pudo cargar: {errors()['cedears']}</div>
          ) : (
            <div className="heatmap-full">
              <CedearsHeatmap rows={data()['cedears']} full={true} />
            </div>
          )
        ) : detailId ? (
          <>
            {errors()[detailId] && (
              <div className="error-box">No se pudo cargar: {errors()[detailId]}</div>
            )}

            {detailRows.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {detailColumns.map((col) => (
                        <th key={col} className={isNumCol(col) ? 'num' : undefined}>{colLabel(col)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {detailRows.map((row, $index) => (
                      <tr key={$index}>
                        {detailColumns.map((col) => (
                          <td key={col} className={isNumCol(col) ? 'num' : undefined}>{fmt(row[col])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">Sin datos para mostrar.</div>
            )}
          </>
        ) : (
          <Cotizaciones
            data={data()}
            errors={errors()}
            status={panelStatus}
            opportunities={bestOpps()}
            mode={uiMode()}
            onOpenDetail={(id) => openDetail(id)}
            onOpenArb={(id) => setActive(id)}
          />
        )}
      </section>

      <footer className="foot">
        <p className="foot-legal">Boston Asset Manager S.A. es una Sociedad por Acciones Simplificada constituida bajo la ley de la República Argentina | CUIT 30-71652406-6 | IIBB CM902-30716524066 | DPPJ RL2019-22722943-GDEBA-DLYRMJGP | AAIP RL-2019-70261408-APN-DNPDP#AAIP | CNV Matrícula 1406 | RUMP RL-2023-96876697-APN-DNMGP#MDP | FINRA #310985</p>
        <p className="foot-legal">Av. Corrientes 800, Ciudad Autónoma de Buenos Aires, Argentina</p>
        <p className="foot-legal">Los accionistas limitan su responsabilidad a la integración del capital suscripto (Ley 19.550).</p>
      </footer>
    </>
  );
}

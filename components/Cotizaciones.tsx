'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { signal, useSignal } from '@/lib/signal';
import {
  PANEL_LIDER,
  bondType,
  noteType,
  BOND_TYPE_ORDER,
  NOTE_TYPE_ORDER,
  bondHistoryUrl,
  REGION_ORDER,
  dropUsdVariants,
} from '@/lib/market.config';
import CedearsHeatmap from '@/components/CedearsHeatmap';
import FlipNum from '@/components/FlipNum';
import type { ArbOpportunity } from '@/lib/arb-engine';
import './Cotizaciones.css';

interface TileGroup {
  label: string; // '' = casillero sin agrupación (una sola tabla corrida)
  rows: any[];
}

interface TableTile {
  kind: 'table';
  id: string;
  label: string;
  statusId: string;  // feed id para status()/errors()
  detailId: string;  // id que se emite en "Ver todo"
  groups: TileGroup[];
  count: number;     // filas totales (para el estado vacío)
  withHist: boolean; // muestra columnas % Sem. / % Año (bonos y letras)
  height: number;    // altura estimada en px, para el auto-balanceo de columnas
}

interface DolarTile {
  kind: 'dolar';
  id: 'dolar';
  label: string;
  height: number;
}

type AnyTile = TableTile | DolarTile;

interface DolarRow {
  casa: string;
  label: string;
  compra: number | null;
  venta: number | null;
  updated: string;
}

interface TileSpec {
  id: string;
  label: string;
  topN: number;
}

// Cierres de referencia para variación semanal/anual (histórico data912).
// null = sin dato (ticker sin histórico, o serie más corta que la ventana).
interface HistRefs {
  w: number | null;
  y: number | null;
}

const TOP_MD = 10;
const TOP_SM = 6;
const GROUP_TOP = 4; // filas por grupo en los casilleros agrupados (Bonos/Letras)

// Estimación de altura (px) para el auto-balanceo de columnas: cabecera fija +
// una fila por ítem. No necesita ser exacta — solo proporcional, para que el
// greedy reparta por peso visual real y no por cantidad nominal de filas.
const HEADER_H = 40;
const ROW_H = 30;
const DOLAR_ROW_H = 50; // filas de Dólar son más altas (dos líneas por casa).

// Resto de los casilleros de mini-tabla (Panel Líder/Panel General se arman
// aparte a partir del feed 'acciones'; Bonos/Letras se arman agrupados por
// tipo, ver `groupedTile`). Mismos ids que PANELS en app.ts. El orden acá es
// solo el desempate cuando dos casilleros dan la misma altura estimada —
// quien decide dónde va cada uno es el auto-balanceo de `columns`.
const OTHER_TILES: TileSpec[] = [
  { id: 'cedears',  label: 'CEDEARs',                  topN: TOP_MD },
  { id: 'ons',      label: 'Obligaciones Negociables', topN: TOP_SM },
  { id: 'opciones', label: 'Opciones',                 topN: TOP_SM },
];

// Orden y etiqueta de casas para el casillero Dólar (fuente: dolarapi.com).
const DOLAR_CASAS: { casa: string; label: string }[] = [
  { casa: 'oficial',         label: 'Oficial' },
  { casa: 'blue',            label: 'Blue' },
  { casa: 'bolsa',           label: 'MEP' },
  { casa: 'contadoconliqui', label: 'CCL' },
  { casa: 'mayorista',       label: 'Mayorista' },
  { casa: 'cripto',          label: 'Cripto' },
  { casa: 'tarjeta',         label: 'Tarjeta' },
];

function byVolumeDesc(rows: any[]): any[] {
  return [...rows].sort((a, b) => (+b?.v || 0) - (+a?.v || 0));
}

// Top N por volumen; si el feed no trae volumen útil (fuera de rueda, o
// símbolos de Opciones con book chato), cae a las primeras N sin ordenar.
function topN(rows: any[], n: number): any[] {
  const sorted = byVolumeDesc(rows);
  const hasVolume = sorted.some((r) => (+r?.v || 0) > 0);
  return (hasVolume ? sorted : rows).slice(0, n);
}

// Cierre más reciente cuya fecha sea <= hoy - daysBack (la serie viene
// ordenada ascendente por fecha).
function refClose(hist: { date: string; c: number }[], daysBack: number): number | null {
  const target = Date.now() - daysBack * 86_400_000;
  let ref: number | null = null;
  for (const h of hist) {
    if (new Date(`${h.date}T00:00:00`).getTime() > target) break;
    ref = +h.c;
  }
  return ref && ref > 0 ? ref : null;
}

function refsFromHistory(res: any): HistRefs {
  if (!Array.isArray(res) || !res.length) return { w: null, y: null };
  return { w: refClose(res, 7), y: refClose(res, 365) };
}

// Precio "Último": px_bid, con fallback a `last` (filas Yahoo: índices y
// ETFs) y al cierre anterior si viene en 0 (fuera de horario de rueda).
const lastPrice = (row: any): number => {
  const px = +row?.px_bid;
  if (px > 0) return px;
  const last = +row?.last;
  return last > 0 ? last : (+row?.c || 0);
};

const pctDay = (row: any): number => +row?.pct_change || 0;

const pctClass = (v: number | null): string => (v == null ? '' : v >= 0 ? 'pos' : 'neg');

function fmt(v: number | null | undefined, dec = 2): string {
  if (v == null || !isFinite(v)) return '–';
  return v.toLocaleString('es-AR', { maximumFractionDigits: dec, minimumFractionDigits: dec });
}

const fmtPct = (v: number | null): string => (v == null ? '—' : `${fmt(v)}%`);

export interface CotizacionesProps {
  data: Record<string, any[]>;
  errors: Record<string, string | null>;
  status: (id: string) => string;
  // Mejor round-trip por pestaña del arbitrador (para el modo simple).
  // Declarado por paridad con el input de Angular: hoy el template no lo usa
  // (la card "Mejores oportunidades" de .basic-side fue reemplazada por el
  // casillero Panel General, ver panelGeneralTile).
  opportunities: ArbOpportunity[];
  // Modo simple/avanzado (Ley de Hick) — lo maneja el shell desde la toolbar.
  mode: 'basico' | 'avanzado';
  onOpenDetail: (id: string) => void;
  // Ex output openArb — mismo caso que `opportunities`: declarado, sin uso en
  // el template actual.
  onOpenArb: (id: string) => void;
}

export default function Cotizaciones(props: CotizacionesProps) {
  const { data, errors, status, mode, onOpenDetail } = props;

  // Cierres de referencia por símbolo para % Sem. / % Año. Se piden una sola
  // vez por símbolo y sesión (el histórico es diario, no cambia intradía) y
  // solo para los símbolos visibles en los casilleros agrupados.
  const [histRefs] = useState(() => signal<Record<string, HistRefs>>({}));
  const histRequestedRef = useRef<Set<string>>(new Set<string>());
  useSignal(histRefs);

  const st = (id: string): string => status(id);

  // Variación % contra el cierre de hace ~7/~365 días; null = sin histórico.
  // Las filas Yahoo (índices/ETFs) ya vienen con pct_week/pct_year resueltos;
  // para bonos/letras se calcula acá contra el histórico data912.
  const pctWeek = (row: any): number | null =>
    row?.pct_week !== undefined ? row.pct_week : histPct(row, 'w');
  const pctYear = (row: any): number | null =>
    row?.pct_year !== undefined ? row.pct_year : histPct(row, 'y');

  function histPct(row: any, k: keyof HistRefs): number | null {
    const ref = histRefs()[String(row?.symbol ?? '')]?.[k];
    const last = lastPrice(row);
    if (!ref || !(last > 0)) return null;
    return (last / ref - 1) * 100;
  }

  // Casillero agrupado por tipo (Bonos / Letras): sin campo de categoría en
  // los feeds, se clasifica por patrón de ticker (ver market.config.ts) y se
  // muestran los GROUP_TOP más operados de cada grupo.
  function groupedTile(id: 'bonos' | 'letras', label: string): TableTile {
    const all = dropUsdVariants(data[id] ?? []);
    const classify = id === 'bonos' ? bondType : noteType;
    const order = id === 'bonos' ? BOND_TYPE_ORDER : NOTE_TYPE_ORDER;

    const byType = new Map<string, any[]>();
    for (const r of all) {
      const t = classify(String(r?.symbol ?? ''));
      const arr = byType.get(t);
      if (arr) arr.push(r); else byType.set(t, [r]);
    }
    const groups: TileGroup[] = order
      .filter((t) => byType.get(t)?.length)
      .map((t) => ({ label: t, rows: topN(byType.get(t)!, GROUP_TOP) }));
    const count = groups.reduce((n, g) => n + g.rows.length, 0);

    return {
      kind: 'table', id, label, statusId: id, detailId: id,
      groups, count, withHist: true,
      // +1 fila por subtítulo de grupo.
      height: HEADER_H + (count + groups.length) * ROW_H,
    };
  }

  // Casillero de Índices: grupos por región (EEUU/Europa/Asia), en el orden
  // y con las etiquetas de INDEX_SPECS — sin recorte por volumen (no aplica).
  function regionTile(id: string, label: string): TableTile {
    const rows = data[id] ?? [];
    const groups: TileGroup[] = REGION_ORDER
      .map((reg) => ({ label: reg, rows: rows.filter((r) => r?.region === reg) }))
      .filter((g) => g.rows.length);
    const count = groups.reduce((n, g) => n + g.rows.length, 0);
    return {
      kind: 'table', id, label, statusId: id, detailId: id,
      groups, count, withHist: true,
      height: HEADER_H + (count + groups.length) * ROW_H,
    };
  }

  // Un casillero de mini-tabla por id, con su altura estimada según la
  // cantidad REAL de filas que trajo el feed (nunca inventadas). Panel Líder
  // y Panel General se derivan del mismo feed 'acciones' (ver
  // market.config.ts): Líder = los 21 tickers oficiales de PANEL_LIDER, sin
  // recorte ni agregado; General = todo lo demás (incluye tickers no
  // listados en ninguna constante, como fallback), recortado a top N.
  const tableTilesValue = useMemo<TableTile[]>(() => {
    const acciones = dropUsdVariants(data['acciones'] ?? []);
    const liderSet = new Set(PANEL_LIDER);
    const liderRows = byVolumeDesc(acciones.filter((r) => liderSet.has(r?.symbol)));
    const generalRows = topN(acciones.filter((r) => !liderSet.has(r?.symbol)), TOP_MD);

    const flatTile = (id: string, label: string, statusId: string, detailId: string, rows: any[], withHist = false): TableTile => ({
      kind: 'table', id, label, statusId, detailId,
      groups: [{ label: '', rows }], count: rows.length, withHist,
      height: HEADER_H + rows.length * ROW_H,
    });

    const tiles: TableTile[] = [
      flatTile('panel-lider', 'Panel Líder', 'acciones', 'acciones', liderRows),
      flatTile('panel-general', 'Panel General', 'acciones', 'acciones', generalRows),
      groupedTile('bonos', 'Bonos'),
      groupedTile('letras', 'Letras'),
      regionTile('indices', 'Índices'),
      flatTile('etfs', 'ETFs', 'etfs', 'etfs', data['etfs'] ?? [], true),
    ];
    for (const t of OTHER_TILES) {
      const rows = topN(data[t.id] ?? [], t.topN);
      tiles.push(flatTile(t.id, t.label, t.id, t.id, rows));
    }
    return tiles;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const tableTiles = () => tableTilesValue;

  // Casillero Panel General para el modo simple (pedido de Elio: reemplaza a
  // "Mejores oportunidades" en .basic-side). Reusa el MISMO tile que arma
  // tableTiles() para el mosaico avanzado — misma fuente, mismo tileTpl, sin
  // lógica duplicada. Siempre existe (tableTiles lo incluye fijo), el "?? "
  // es sólo para tipar sin non-null assertion.
  const panelGeneralTile = () =>
    tableTiles().find((t) => t.id === 'panel-general') ?? null;

  // Símbolos visibles que necesitan histórico data912 (solo bonos/letras —
  // índices y ETFs ya traen sus % resueltos desde Yahoo).
  const histSymbolsValue = useMemo<string[]>(() => {
    const syms: string[] = [];
    for (const t of tableTilesValue) {
      if (!t.withHist || (t.id !== 'bonos' && t.id !== 'letras')) continue;
      for (const g of t.groups) for (const r of g.rows) syms.push(String(r?.symbol ?? ''));
    }
    return syms;
  }, [tableTilesValue]);

  // ex effect() del constructor: por cada símbolo nuevo visible se pide el
  // histórico una única vez (histRequested), y la respuesta se guarda como
  // cierres de referencia. `catchError(() => of(null))` → `.catch(() => null)`.
  useEffect(() => {
    const histRequested = histRequestedRef.current;
    for (const sym of histSymbolsValue) {
      if (!sym || histRequested.has(sym)) continue;
      histRequested.add(sym);
      fetch(bondHistoryUrl(sym), { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((res) => {
          histRefs.update((m) => ({ ...m, [sym]: refsFromHistory(res) }));
        });
    }
  }, [histSymbolsValue, histRefs]);

  const dolarRowsValue = useMemo<DolarRow[]>(() => {
    const rows = data['dolar'] ?? [];
    const byCasa = new Map(rows.map((r) => [String(r?.casa ?? '').toLowerCase(), r]));
    return DOLAR_CASAS.map(({ casa, label }) => {
      const r = byCasa.get(casa);
      const ts = r?.fechaActualizacion ? new Date(r.fechaActualizacion) : null;
      const updated = ts && !isNaN(ts.getTime())
        ? ts.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
        : '—';
      return {
        casa,
        label,
        compra: r?.compra != null ? +r.compra : null,
        venta: r?.venta != null ? +r.venta : null,
        updated,
      };
    });
  }, [data]);
  const dolarRows = () => dolarRowsValue;

  const dolarTile = (): DolarTile => ({
    kind: 'dolar',
    id: 'dolar',
    label: 'Dólar',
    height: HEADER_H + DOLAR_CASAS.length * DOLAR_ROW_H,
  });

  // ── Auto-balanceo de columnas (masonry, greedy) ───────────────────────────
  // Nada de posiciones fijas ("columna 1 = Panel Líder, columna 2 = [...]").
  // Se ordenan los casilleros por altura estimada (real, según filas que
  // trajo cada feed) de mayor a menor, y cada uno se asigna a la columna que
  // en ese momento acumula MENOS altura (long-processing-time / greedy bin
  // balancing). Así el reparto se recalcula solo con cualquier combinación
  // real de filas por categoría — no hay que retocarlo a mano.
  const columnsValue = useMemo<AnyTile[][]>(() => {
    const items: AnyTile[] = [...tableTilesValue, dolarTile()]
      .sort((a, b) => b.height - a.height);

    const cols: AnyTile[][] = [[], [], []];
    const colHeights = [0, 0, 0];
    for (const item of items) {
      let shortest = 0;
      for (let i = 1; i < cols.length; i++) {
        if (colHeights[i] < colHeights[shortest]) shortest = i;
      }
      cols[shortest].push(item);
      colHeights[shortest] += item.height;
    }
    return cols;
  }, [tableTilesValue]);
  const columns = () => columnsValue;

  // ex <ng-template #dolarTpl> — casillero Dólar, mismo markup para el modo
  // simple (.basic-side) y para el mosaico avanzado.
  const dolarTpl = () => (
    <div className="tile">
      <div className="tile-head">
        <span className="tile-name">Dólar</span>
        <span className={`tile-status${errors['dolar'] ? ' err' : ''}`}>{st('dolar')}</span>
        <button className="tile-more" onClick={() => onOpenDetail('dolar')}>Ver todo →</button>
      </div>

      {errors['dolar'] ? (
        <div className="tile-error">No se pudo cargar: {errors['dolar']}</div>
      ) : (
        <div className="dolar-rows">
          {dolarRows().map((d) => (
            <div className="dolar-row" key={d.casa}>
              <div className="dolar-info">
                <span className="dolar-casa">{d.label}</span>
                <span className="dolar-updated">actualizado {d.updated}</span>
              </div>
              <div className="dolar-vals">
                <span className="dolar-val">
                  <em>Compra</em>
                  <b className="num"><FlipNum v={d.compra != null ? fmt(d.compra) : '—'} /></b>
                </span>
                <span className="dolar-val">
                  <em>Venta</em>
                  <b className="num"><FlipNum v={d.venta != null ? fmt(d.venta) : '—'} /></b>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // ex <ng-template #tileTpl let-t> — casillero de mini-tabla genérico
  // (Panel Líder/General, Bonos, Letras, Índices, ETFs, CEDEARs, ONs, Opciones).
  const tileTpl = (t: TableTile) => (
    <div className="tile">
      <div className="tile-head">
        <span className="tile-name">{t.label}</span>
        <span className={`tile-status${errors[t.statusId] ? ' err' : ''}`}>{st(t.statusId)}</span>
        <button className="tile-more" onClick={() => onOpenDetail(t.detailId)}>Ver todo →</button>
      </div>

      {errors[t.statusId] ? (
        <div className="tile-error">No se pudo cargar: {errors[t.statusId]}</div>
      ) : t.count ? (
        <div className="tile-body">
          <table>
            <thead>
              <tr>
                <th>Símbolo</th>
                <th className="num">Último</th>
                <th className="num">% Día</th>
                {t.withHist && (
                  <>
                    <th className="num">% Sem.</th>
                    <th className="num">% Año</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {t.groups.map((g) => (
                <Fragment key={g.label}>
                  {g.label && (
                    <tr className="group-row"><td colSpan={t.withHist ? 5 : 3}>{g.label}</td></tr>
                  )}
                  {g.rows.map((row) => (
                    <tr key={row.symbol}>
                      <td>{row.symbol}</td>
                      <td className="num"><FlipNum v={fmt(lastPrice(row))} /></td>
                      <td className={`num pct${pctDay(row) >= 0 ? ' pos' : ''}${pctDay(row) < 0 ? ' neg' : ''}`}><FlipNum v={fmt(pctDay(row)) + '%'} /></td>
                      {t.withHist && (
                        <>
                          <td className={`num pct ${pctClass(pctWeek(row))}`.trimEnd()}><FlipNum v={fmtPct(pctWeek(row))} /></td>
                          <td className={`num pct ${pctClass(pctYear(row))}`.trimEnd()}><FlipNum v={fmtPct(pctYear(row))} /></td>
                        </>
                      )}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="tile-empty">Sin datos.</div>
      )}
    </div>
  );

  if (mode === 'basico') {
    const pg = panelGeneralTile();
    return (
      // ── Modo simple: Mercado hoy · Dólar · Panel General ───────────────────
      <div className="basic">
        <div className="tile basic-market">
          <div className="tile-head">
            <span className="tile-name">Mercado hoy</span>
            <span className={`tile-status${errors['cedears'] ? ' err' : ''}`}>{st('cedears')}</span>
            <button className="tile-more" onClick={() => onOpenDetail('mapa-cedears')}>Ver todo →</button>
          </div>
          {errors['cedears'] ? (
            <div className="tile-error">No se pudo cargar: {errors['cedears']}</div>
          ) : (
            <CedearsHeatmap rows={data['cedears']} fill={true} />
          )}
        </div>

        <div className="basic-side">
          {dolarTpl()}

          {/* Panel General (pedido de Elio): mismo casillero que el del mosaico
              avanzado, reusando tileTpl y panelGeneralTile() — antes acá vivía
              la card "Mejores oportunidades" del arbitrador. */}
          {pg && tileTpl(pg)}
        </div>
      </div>
    );
  }

  return (
    <>
      {/* ── Modo avanzado: mapa de calor + mosaico completo ───────────────────── */}
      {/* Mapa de calor de CEDEARs: sectores, área = capitalización, color = % día.
          "Ver todo" abre la versión grande con todas las empresas mapeadas. */}
      <div className="tile heat-tile">
        <div className="tile-head">
          <span className="tile-name">Mapa de calor</span>
          <span className={`tile-status${errors['cedears'] ? ' err' : ''}`}>{st('cedears')}</span>
          <button className="tile-more" onClick={() => onOpenDetail('mapa-cedears')}>Ver todo →</button>
        </div>
        {errors['cedears'] ? (
          <div className="tile-error">No se pudo cargar: {errors['cedears']}</div>
        ) : (
          <CedearsHeatmap rows={data['cedears']} />
        )}
      </div>

      <div className="mosaic">
        {columns().map((col, $index) => (
          <div className="col" key={$index}>
            {col.map((t) => (
              <Fragment key={t.id}>
                {t.kind === 'dolar' ? dolarTpl() : tileTpl(t)}
              </Fragment>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

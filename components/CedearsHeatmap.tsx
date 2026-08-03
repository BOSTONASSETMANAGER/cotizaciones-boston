'use client';

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

import { signal, useSignal } from '@/lib/signal';
import { cedearMeta } from '@/lib/cedears-meta';
import './CedearsHeatmap.css';

/**
 * Mapa de calor de CEDEARs (treemap anidado estilo finviz): contenedores por
 * SECTOR (con barra de título), celdas con área = CAPITALIZACIÓN BURSÁTIL
 * aproximada (ver cedears-meta.ts) y color = variación % diaria en una escala
 * DIVERGENTE binned (rojo → gris neutro → verde) derivada de los tokens
 * semánticos de la app y validada: luminancia monótona por brazo y contraste
 * de texto ≥ 5:1 en todos los bins (los bins pálidos quedan por debajo de 3:1
 * contra la superficie a propósito — el canal de lectura es el label directo
 * en la celda y la tabla CEDEARs, no el color).
 *
 * Dos modos: compacto (card del mosaico, top N por cap) y `full` (vista
 * "Ver todo": todos los CEDEARs mapeados, lienzo grande).
 */

const COMPACT_MAX = 55;
// Lienzos nominales para el squarify (solo definen proporciones; se proyecta
// a % del contenedor real).
const COMPACT_W = 1000, COMPACT_H = 430;
const FILL_H = 620; // modo fill: el contenedor real es más alto que la card compacta
const FULL_W = 1400, FULL_H = 780;
const SECTOR_HEAD = 15; // alto de la barra de título del sector (px nominales)

// Umbrales de % diario y color por bin: ≤-3, -3..-1, -1..-0,25, ±0,25,
// +0,25..+1, +1..+3, ≥+3.
const BIN_EDGES = [-3, -1, -0.25, 0.25, 1, 3];
const BIN_BG = ['#be1f1f', '#d96f6f', '#edb5b5', '#dedcd7', '#a8dabb', '#58b183', '#15803d'];
const BIN_FG = ['#ffffff', '#1a1a1d', '#1a1a1d', '#1a1a1d', '#1a1a1d', '#1a1a1d', '#ffffff'];
const BIN_LABELS = ['≤ −3', '−3…−1', '−1…−0,25', '±0,25', '+0,25…+1', '+1…+3', '≥ +3'];

function binFor(pct: number): number {
  let i = 0;
  while (i < BIN_EDGES.length && pct > BIN_EDGES[i]) i++;
  return i;
}

interface Rect { x: number; y: number; w: number; h: number; }

// Treemap squarified clásico: tiras a lo largo del lado corto del rectángulo
// libre, eligiendo cuántos ítems entran en cada tira para minimizar el peor
// aspect ratio. Espera áreas ordenadas de mayor a menor.
function squarify(areas: number[], x0: number, y0: number, w0: number, h0: number): Rect[] {
  const out: Rect[] = [];
  let x = x0, y = y0, w = w0, h = h0, i = 0;
  while (i < areas.length) {
    const column = w >= h; // columna vertical si el ancho libre domina
    const side = column ? h : w;
    let best = Infinity;
    let count = 1;
    let chosenSum = areas[i];
    let sum = 0;
    for (let j = i; j < areas.length; j++) {
      sum += areas[j];
      const thk = sum / side;
      let worst = 0;
      for (let k = i; k <= j; k++) {
        const len = areas[k] / thk;
        worst = Math.max(worst, len / thk, thk / len);
      }
      if (worst <= best) { best = worst; count = j - i + 1; chosenSum = sum; }
      else break;
    }
    const thk = chosenSum / side;
    let off = 0;
    for (let k = i; k < i + count; k++) {
      const len = areas[k] / thk;
      out.push(column ? { x, y: y + off, w: thk, h: len } : { x: x + off, y, w: len, h: thk });
      off += len;
    }
    if (column) { x += thk; w -= thk; } else { y += thk; h -= thk; }
    i += count;
  }
  return out;
}

interface HeatCell {
  symbol: string;
  sector: string;
  capBn: number;
  last: number;
  pct: number;
  vol: number;
  // posición/tamaño en % del área INTERNA del sector
  x: number; y: number; w: number; h: number;
  bg: string;
  fg: string;
  fsSym: number;
  showSym: boolean;
  showPct: boolean;
}

interface HeatSector {
  name: string;
  // posición/tamaño en % del lienzo del mapa
  x: number; y: number; w: number; h: number;
  headPct: number; // alto de la barra de título en % del alto del sector
  cells: HeatCell[];
}

const legend = BIN_BG.map((bg, i) => ({ bg, label: BIN_LABELS[i] }));

function fmt(v: number): string {
  if (!isFinite(v)) return '–';
  return v.toLocaleString('es-AR', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function fmtPct(v: number): string {
  const s = v > 0 ? '+' : '';
  return `${s}${v.toLocaleString('es-AR', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`;
}

function fmtCap(bn: number): string {
  if (bn >= 1000) return `USD ${(bn / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 })} T`;
  return `USD ${bn.toLocaleString('es-AR', { maximumFractionDigits: 0 })} B`;
}

function fmtVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toLocaleString('es-AR', { maximumFractionDigits: 1 })} MM M`;
  if (v >= 1e6) return `${(v / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 })} M`;
  return v.toLocaleString('es-AR', { maximumFractionDigits: 0 });
}

export interface CedearsHeatmapProps {
  rows: any[];
  full?: boolean;
  // fill: estira el mapa al alto disponible del contenedor flex (modo simple).
  fill?: boolean;
}

export default function CedearsHeatmap({ rows, full = false, fill = false }: CedearsHeatmapProps) {
  // ex `host: { '[class.full]': 'full()', '[class.fill]': 'fill()' }` — el host
  // element de Angular pasa a ser este div root; las clases full/fill son las
  // que engancha CedearsHeatmap.css.
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Signals internos POR INSTANCIA (§4 del contrato): se crean una sola vez con
  // el inicializador lazy de useState, nunca a nivel de módulo.
  const [hostWidth] = useState(() => signal(0));
  const [hovered] = useState(() => signal<HeatCell | null>(null));
  const [mouse] = useState(() => signal<{ x: number; y: number; maxX: number; maxY: number }>({ x: 0, y: 0, maxX: COMPACT_W, maxY: COMPACT_H }));

  // Suscripción: cualquier set() de estos signals re-renderiza el componente.
  const hostWidthValue = useSignal(hostWidth);
  useSignal(hovered);
  useSignal(mouse);

  const isMobile = () => hostWidth() > 0 && hostWidth() < 768;

  // ex afterNextRender(): la medición del DOM va en un efecto de montaje (§6 —
  // nada de ResizeObserver en el render, no existe en el server).
  useEffect(() => {
    const h = hostRef.current;
    if (!h) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentBoxSize?.[0]?.inlineSize ?? entries[0]?.contentRect.width ?? 0;
      if (w > 0) hostWidth.set(Math.round(w));
    });
    ro.observe(h);
    return () => ro.disconnect();
  }, [hostWidth]);

  // ex computed<HeatSector[]>: memoizado por las mismas entradas que tenía el
  // computed de Angular (rows / full / fill / ancho medido). Sin el useMemo el
  // treemap se recalcularía en cada mousemove del tooltip.
  const sectorsValue = useMemo<HeatSector[]>(() => {
    const actualW = hostWidthValue;
    const W = full ? FULL_W : (actualW > 0 ? actualW : COMPACT_W);
    const H = full
      ? FULL_H
      : (fill
        ? Math.round(W * (FILL_H / COMPACT_W))
        : Math.round(W * (COMPACT_H / COMPACT_W)));

    // Solo entran los tickers con sector/cap mapeados (excluye variantes USD
    // comprimidas y duplicados B3/ADR — ver cedears-meta.ts).
    let items = (rows ?? [])
      .map((r) => ({ r, meta: cedearMeta(String(r?.symbol ?? '')) }))
      .filter((x): x is { r: any; meta: NonNullable<ReturnType<typeof cedearMeta>> } => !!x.meta)
      .sort((a, b) => b.meta.capBn - a.meta.capBn);
    if (!full) items = items.slice(0, COMPACT_MAX);
    if (!items.length) return [];

    // Agrupar por sector, ordenados por cap total descendente.
    const bySector = new Map<string, typeof items>();
    for (const it of items) {
      const arr = bySector.get(it.meta.sector);
      if (arr) arr.push(it); else bySector.set(it.meta.sector, [it]);
    }
    const groups = [...bySector.entries()]
      .map(([name, list]) => ({ name, list, cap: list.reduce((a, x) => a + x.meta.capBn, 0) }))
      .sort((a, b) => b.cap - a.cap);

    // Nivel 1: treemap de sectores (peso = cap total del sector).
    const totalCap = groups.reduce((a, g) => a + g.cap, 0);
    const sectorRects = squarify(groups.map((g) => (g.cap / totalCap) * W * H), 0, 0, W, H);

    return groups.map((g, gi) => {
      const sr = sectorRects[gi];
      // Nivel 2: treemap de empresas dentro del área útil del sector (debajo
      // de la barra de título).
      const innerH = Math.max(sr.h - SECTOR_HEAD, 4);
      const capSum = g.cap;
      const cellRects = squarify(g.list.map((x) => (x.meta.capBn / capSum) * sr.w * innerH), 0, 0, sr.w, innerH);

      const cells: HeatCell[] = g.list.map((x, i) => {
        const rc = cellRects[i];
        const pct = +x.r?.pct_change || 0;
        const bin = binFor(pct);
        const px = +x.r?.px_bid;
        const last = px > 0 ? px : (+x.r?.c || 0);
        const fsSym = Math.max(9, Math.min(17, Math.sqrt(rc.w * rc.h) / 5.5));
        return {
          symbol: String(x.r?.symbol ?? ''),
          sector: g.name,
          capBn: x.meta.capBn,
          last,
          pct,
          vol: +x.r?.v || 0,
          x: (rc.x / sr.w) * 100, y: (rc.y / innerH) * 100,
          w: (rc.w / sr.w) * 100, h: (rc.h / innerH) * 100,
          bg: BIN_BG[bin],
          fg: BIN_FG[bin],
          fsSym,
          showSym: rc.w > 32 && rc.h > 14,
          showPct: rc.w > 32 && rc.h > 32,
        };
      });

      return {
        name: g.name,
        x: (sr.x / W) * 100, y: (sr.y / H) * 100,
        w: (sr.w / W) * 100, h: (sr.h / H) * 100,
        headPct: (SECTOR_HEAD / sr.h) * 100,
        cells,
      };
    });
  }, [rows, full, fill, hostWidthValue]);

  const sectors = () => sectorsValue;

  // Tooltip pegado al cursor, clampeado para no salirse del mapa.
  const tipX = () => Math.min(mouse().x + 14, mouse().maxX - 190);
  const tipY = () => Math.min(mouse().y + 14, mouse().maxY - 105);

  function onMove(e: ReactMouseEvent<HTMLDivElement>) {
    const el = e.currentTarget as HTMLElement;
    const b = el.getBoundingClientRect();
    mouse.set({ x: e.clientX - b.left, y: e.clientY - b.top, maxX: b.width, maxY: b.height });
  }

  const hc = hovered();

  return (
    <div ref={hostRef} className={`cedears-heatmap${full ? ' full' : ''}${fill ? ' fill' : ''}`}>
      {sectors().length ? (
        <>
          {isMobile() ? (
            <div className="mobile-cards">
              {sectors().map((s) => (
                <div className="sector-card" key={s.name}>
                  <div className="card-head">{s.name}</div>
                  <div className="card-body">
                    {s.cells.slice(0, 5).map((c) => (
                      <div className={`ticker-row${c.pct >= 0 ? ' pos' : ''}${c.pct < 0 ? ' neg' : ''}`} key={c.symbol}>
                        <span className="ticker-sym">{c.symbol}</span>
                        <span className="ticker-pct num">{fmtPct(c.pct)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="map" onMouseMove={onMove} onMouseLeave={() => hovered.set(null)}>
              {sectors().map((s) => (
                <div
                  className="sector"
                  key={s.name}
                  style={{ left: `${s.x}%`, top: `${s.y}%`, width: `${s.w}%`, height: `${s.h}%` }}
                >
                  <div className="sector-head" style={{ height: `${s.headPct}%` }}><span>{s.name}</span></div>
                  <div className="sector-body">
                    {s.cells.map((c) => (
                      <div
                        className={`cell${hovered()?.symbol === c.symbol ? ' hover' : ''}`}
                        key={c.symbol}
                        style={{
                          left: `${c.x}%`, top: `${c.y}%`,
                          width: `${c.w}%`, height: `${c.h}%`,
                          background: c.bg, color: c.fg,
                        }}
                        onMouseEnter={() => hovered.set(c)}
                      >
                        {c.showSym && (
                          <>
                            <span className="sym" style={{ fontSize: `${c.fsSym}px` }}>{c.symbol}</span>
                            {c.showPct && (
                              <span className="pct num" style={{ fontSize: `${c.fsSym - 2}px` }}>{fmtPct(c.pct)}</span>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {hc && (
                <div className="tip" style={{ left: `${tipX()}px`, top: `${tipY()}px` }}>
                  <b>{hc.symbol}</b>
                  <span className="sec">{hc.sector} · cap. {fmtCap(hc.capBn)}</span>
                  <span className="num">Último {fmt(hc.last)}</span>
                  <span className="num" style={{ color: hc.pct >= 0 ? '#7ee2a5' : '#f1a3a3' }}>{fmtPct(hc.pct)} hoy</span>
                  <span className="num vol">Vol. {fmtVol(hc.vol)}</span>
                </div>
              )}
            </div>
          )}

          <div className="legend">
            <span className="cap">% Día</span>
            {legend.map((l) => (
              <span className="key" key={l.label}><i style={{ background: l.bg }}></i>{l.label}</span>
            ))}
            {!isMobile() && (
              <span className="cap area">área = capitalización bursátil · agrupado por sector</span>
            )}
          </div>
        </>
      ) : (
        <div className="empty">Sin datos.</div>
      )}
    </div>
  );
}

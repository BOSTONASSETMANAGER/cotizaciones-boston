"use client";

import { memo, useMemo } from 'react';
import './FlipNum.css';

/**
 * flip-num — número con efecto "split-flap" (tablero Solari de aeropuerto).
 *
 * Recibe el string YA formateado y renderiza un span por carácter. Cuando un
 * carácter cambia, se bumpea su "generación": eso cambia la key del track del
 * @for, Angular recrea el span y la animación CSS de volteo corre sola en el
 * elemento nuevo — sin timers ni manejo manual de clases. Los caracteres se
 * alinean desde la DERECHA (en un número que crece o pierde un dígito, lo que
 * se corre es la izquierda), así solo aletean las fichas que realmente
 * cambian. El delay por posición da el efecto de onda del tablero real.
 *
 * PORTADO A NEXT: el mecanismo es idéntico, sólo cambia el vehículo. Donde
 * Angular recreaba el <span> porque cambiaba la key del `track` del @for, React
 * lo desmonta y remonta porque cambia la `key` del map — mismo efecto: elemento
 * nuevo ⇒ la animación CSS arranca de cero. Y el `:host` de Angular pasa a ser
 * un <span class="flip-num"> explícito (React no tiene host element).
 */

interface FlapChar {
  key: string;   // posición-desde-la-derecha : generación
  ch: string;
  delay: string; // stagger de la onda (izquierda → derecha)
}

export interface FlipNumProps {
  // String ya formateado (ej: "1.234,56", "+0,45%", "—").
  v: string;
}

function FlipNumImpl({ v }: FlipNumProps) {
  // Estado interno de generaciones por posición-desde-la-derecha. Mutarlo
  // dentro del computed es seguro: corre exactamente una vez por cambio de
  // input (memoizado) y no lee otras señales.
  //
  // El `computed()` de Angular pasa a `useMemo(fn, [v])`: misma memoización por
  // valor de input. El estado mutable (`prev`/`gens`) vive en la closure del
  // useMemo, que React conserva entre renders — y el cálculo es IDEMPOTENTE
  // para el mismo `v` (al terminar, `prev` ya es igual a `chs`, así que una
  // segunda corrida no bumpea ninguna generación). Por eso el doble invoke de
  // StrictMode en dev, o un descarte del memo por parte de React, no disparan
  // aleteos fantasma.
  const state = useMemo(() => ({ prev: [] as string[], gens: [] as number[] }), []);

  const chars = useMemo<FlapChar[]>(() => {
    const chs = [...(v ?? '')];
    const n = chs.length;
    const out: FlapChar[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const k = n - 1 - i; // posición desde la derecha
      if (state.prev[k] !== chs[i]) state.gens[k] = (state.gens[k] ?? 0) + 1;
      out[i] = {
        key: `${k}:${state.gens[k]}`,
        ch: chs[i],
        delay: `${i * 22}ms`,
      };
    }
    state.prev = chs.slice().reverse(); // indexado por posición-desde-la-derecha
    return out;
    // `state` es una referencia estable (useMemo con deps vacías): el único
    // disparador real del recálculo es `v`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);

  return (
    <span className="flip-num">
      {chars.map((c) => (
        <span key={c.key} className="ch" style={{ animationDelay: c.delay }}>{c.ch}</span>
      ))}
    </span>
  );
}

// ex `changeDetection: ChangeDetectionStrategy.OnPush`: sin esto, cada tick del
// feed (1 s) re-renderizaría las decenas de fichas de cada tabla aunque el
// string no se haya movido. Las keys son estables, así que no habría aleteo
// espurio — pero sí trabajo de reconciliación al vacío.
export const FlipNum = memo(FlipNumImpl);
export default FlipNum;

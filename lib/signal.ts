/**
 * signal.ts — Store mínimo que espeja `signal()` / `computed()` de Angular
 * sobre `useSyncExternalStore` de React 19, sin dependencias externas.
 *
 * Existe para que el código portado desde Angular se lea igual que el
 * original: `this.cedearsT0()` → `cedearsT0()`, `this.paused.set(true)` →
 * `paused.set(true)`. Los ~20 signals globales de `app.ts` viven a nivel de
 * módulo en `lib/store.ts` y los componentes los leen con `useSignal(...)`.
 *
 * Decisiones deliberadas (NO "mejorar" sin releer esto):
 *
 *  - NO hay grafo de dependencias ni tracking automático. `computed(fn)`
 *    re-evalúa `fn()` en cada lectura. Los signals son pocos y el costo de
 *    recalcular es trivial frente a los bugs de un scheduler propio.
 *  - `set()` / `update()` notifican SÓLO si el valor cambió por identidad
 *    (`Object.is`). Sin ese filtro, el polling de 1s del feed dispararía un
 *    re-render por tick incluso cuando la cotización no se movió.
 *  - `subscribe` es una referencia estable por signal (se crea una vez, en la
 *    closure de `signal()`), requisito de `useSyncExternalStore` para no
 *    re-suscribirse en cada render.
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';

/**
 * Un signal es un getter invocable con mutadores. La firma es contrato cerrado
 * del swarm de migración: cambiarla rompe a todos los consumidores.
 */
export interface Signal<T> {
  /** Lectura del valor actual. */
  (): T;
  /** Escribe un valor nuevo. No notifica si es idéntico (`Object.is`) al actual. */
  set(v: T): void;
  /** Escribe derivando del valor actual. Mismo filtro de identidad que `set`. */
  update(fn: (prev: T) => T): void;
  /** Registra un listener de cambios. Devuelve la función de baja. */
  subscribe(cb: () => void): () => void;
}

/**
 * Crea un signal con valor inicial `initial`.
 *
 * El valor vive en la closure; los suscriptores en un `Set` (baja O(1) y sin
 * duplicados). Se itera sobre una copia del `Set` al notificar: un listener que
 * se da de baja a sí mismo durante la notificación no debe alterar el recorrido.
 */
export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const subs = new Set<() => void>();

  const read = (() => value) as Signal<T>;

  read.set = (v: T): void => {
    if (Object.is(value, v)) return; // mismo valor: no re-renderizamos de gratis
    value = v;
    for (const cb of [...subs]) cb();
  };

  read.update = (fn: (prev: T) => T): void => {
    read.set(fn(value));
  };

  read.subscribe = (cb: () => void): (() => void) => {
    subs.add(cb);
    return () => {
      subs.delete(cb);
    };
  };

  return read;
}

/**
 * Equivalente a `computed()` de Angular: devuelve un getter que re-evalúa `fn()`
 * en cada lectura. No cachea y no rastrea dependencias (ver cabecera del
 * archivo). Útil para derivaciones puras que se leen dentro del render de un
 * componente que ya está suscripto a los signals de base.
 *
 * Ojo: un `computed` por sí solo NO dispara re-renders. Si el componente
 * depende de él para pintar, suscribite a los signals de base con `useSignal`
 * o usá `useComputed(fn, [a, b])`.
 */
export function computed<T>(fn: () => T): () => T {
  return () => fn();
}

/**
 * Hook: lee un signal y re-renderiza el componente cuando cambia.
 *
 * `getServerSnapshot` es el mismo getter que en cliente, así que el HTML del
 * server y el primer render del cliente coinciden — condición para no romper la
 * hidratación. Por eso los signals que dependen de `localStorage` se inicializan
 * con el DEFAULT del config y recién en un `useEffect` de montaje se les hace
 * `set()` con el valor persistido (ver §6 del contrato de migración).
 */
export function useSignal<T>(s: Signal<T>): T {
  return useSyncExternalStore(s.subscribe, s, s);
}

/**
 * Hook para los `computed()` de Angular que dependen de VARIOS signals: se
 * suscribe a todos los de `deps` y devuelve `fn()` recalculado en cada render
 * disparado por cualquiera de ellos.
 *
 * El snapshot que se le pasa a `useSyncExternalStore` es un contador de
 * versión (number), NO el resultado de `fn()`: si `fn` devuelve un array u
 * objeto nuevo en cada llamada — el caso normal acá (`bestOpps`, listas
 * filtradas) — React avisaría "The result of getSnapshot should be cached" y
 * entraría en un loop infinito de renders. El contador es primitivo y estable,
 * y el valor derivado se calcula durante el render.
 *
 * `deps` deben ser signals de módulo (referencias estables) y la lista debe
 * tener siempre el mismo largo, igual que cualquier lista de dependencias de
 * React.
 */
export function useComputed<T>(fn: () => T, deps: Signal<any>[]): T {
  const version = useRef(0);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const bajas = deps.map((s) =>
        s.subscribe(() => {
          version.current++;
          onStoreChange();
        }),
      );
      return () => {
        for (const baja of bajas) baja();
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps,
  );

  const getSnapshot = useCallback(() => version.current, []);

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return fn();
}

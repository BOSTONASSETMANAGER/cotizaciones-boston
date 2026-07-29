// Puente iframe ← parent para el tutorial de Boston.
//
// La app se embebe en https://www.bostonam.com/dashboard/arbitraje. El tour vive
// del lado del parent (no puede tocar este DOM: es cross-origin), así que en cada
// paso nos manda qué solapa abrir y qué módulo resaltar, y el resaltado lo
// hacemos acá.
//
// Contrato (espejo de boston-ar/app/dashboard/arbitraje/ArbitrajeTourBridge.tsx):
//   { source: "bam-tour", type: "focus", view: "arbitraje"|"cotizaciones", selector: string }
//   { source: "bam-tour", type: "clear" }

const MESSAGE_SOURCE = 'bam-tour';
const FOCUS_CLASS = 'bam-tour-focus';

/** Solo estos orígenes pueden dirigir el resaltado. */
const ALLOWED_ORIGINS = [
  'https://www.bostonam.com',
  'https://bostonam.com',
  'http://localhost:3000',
];

export type ParentTourView = 'arbitraje' | 'cotizaciones';

/**
 * ¿Estamos embebidos en otra página (el dashboard de boston-ar)?
 *
 * Cuando lo estamos, el tutorial lo maneja íntegramente el parent: nuestros
 * tours propios de driver.js no deben correr, porque sus popovers y su overlay
 * se superpondrían al del parent y quedarían dos tutoriales encima del otro.
 *
 * En acceso directo a la app (su URL es pública) esto da false y todo sigue
 * igual que antes: botón "Ayuda" y tours propios funcionando.
 *
 * El try/catch cubre navegadores que tiran SecurityError al comparar contra
 * window.top desde un frame cross-origin: si falla, asumimos que sí estamos
 * embebidos, que es el caso en el que ese error puede ocurrir.
 */
export function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export interface ParentTourFocus {
  view: ParentTourView;
  selector: string;
}

let highlighted: Element | null = null;

function clearHighlight() {
  if (highlighted) {
    highlighted.classList.remove(FOCUS_CLASS);
    highlighted = null;
  }
}

function applyHighlight(selector: string) {
  clearHighlight();
  const el = document.querySelector(selector);
  if (!el) return; // selector desactualizado: no resaltamos, pero no rompemos nada
  el.classList.add(FOCUS_CLASS);
  highlighted = el;
  try {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch {
    el.scrollIntoView();
  }
}

/**
 * Escucha los mensajes del parent. `onView` debe cambiar la solapa activa;
 * devolvemos la función de baja para llamarla desde ngOnDestroy.
 *
 * Cuando el paso pide otra solapa, primero se cambia y recién después se busca
 * el elemento: si no, el selector todavía no existe en el DOM.
 */
export function listenParentTour(
  getView: () => string,
  onView: (v: ParentTourView) => void,
): () => void {
  const handler = (ev: MessageEvent) => {
    if (!ALLOWED_ORIGINS.includes(ev.origin)) return;
    const data = ev.data as
      | { source?: string; type?: string; view?: ParentTourView; selector?: string }
      | null;
    if (!data || data.source !== MESSAGE_SOURCE) return;

    if (data.type === 'clear') {
      clearHighlight();
      return;
    }
    if (data.type !== 'focus' || !data.selector || !data.view) return;

    const selector = data.selector;
    if (getView() !== data.view) {
      onView(data.view);
      // Un tick para que Angular renderice la vista nueva antes de buscar.
      setTimeout(() => applyHighlight(selector), 120);
    } else {
      applyHighlight(selector);
    }
  };

  window.addEventListener('message', handler);
  return () => {
    window.removeEventListener('message', handler);
    clearHighlight();
  };
}

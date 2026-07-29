import { driver, type DriveStep } from 'driver.js';
import 'driver.js/dist/driver.css';
import { isEmbedded } from './parent-tour.util';

// Fábrica compartida de tours driver.js: mismo look (ver .driver-popover* en
// styles.css), mismos controles (Anterior/Siguiente/Hecho + "Omitir" +
// pausa/play de autoplay) y misma lógica de persistencia "visto" para
// cualquier tour de la app (arbitraje, cotizaciones, …). Cada llamado crea su
// propia instancia — nunca se comparte estado entre tours.
export function runTour(steps: DriveStep[], seenKey: string, opts?: { force?: boolean }) {
  // Embebidos en boston-ar el tutorial lo maneja el parent, que ya pone su
  // propio velo y su propia tarjeta y nos va pidiendo qué resaltar por
  // postMessage. Correr además el tour de driver.js apilaría dos overlays y dos
  // popovers. Se corta acá y no en cada llamador para que valga para todos los
  // tours (arbitraje, cotizaciones y los que se sumen).
  if (isEmbedded()) return;

  if (!opts?.force) {
    let seen = true;
    try { seen = localStorage.getItem(seenKey) === '1'; } catch {}
    if (seen) return;
  }

  window.scrollTo(0, 0);
  // allowClose:false bloquea el cierre por click en el overlay (y Escape),
  // pero en driver.js@1.8 esa misma flag también apaga el botón X y el
  // cierre por closeClick interno. Por eso proveemos onCloseClick propio
  // (bypassea el gate de allowClose) y forzamos la visibilidad del botón
  // X por CSS (ver .driver-popover-close-btn en styles.css).
  let tourDriver: ReturnType<typeof driver>;

  // --- Autoplay: avanza solo cada AUTOPLAY_MS, pausable a mano ---------
  // El timer vive en esta closure (no en el componente) porque es 1:1 con
  // esta instancia de tourDriver: cada runTour() arranca su propio
  // temporizador y debe limpiar el suyo, nunca el de una corrida anterior.
  const AUTOPLAY_MS = 4500;
  let autoplayTimerId: ReturnType<typeof setTimeout> | null = null;
  let autoplayEnabled = true;

  const clearAutoplayTimer = () => {
    if (autoplayTimerId !== null) {
      clearTimeout(autoplayTimerId);
      autoplayTimerId = null;
    }
  };

  // Se llama tras cada step mostrado (onHighlighted): si el autoplay sigue
  // activo, programa el próximo avance; si no, no hace nada (modo manual).
  const scheduleAutoplayStep = () => {
    clearAutoplayTimer();
    if (!autoplayEnabled) return;
    autoplayTimerId = setTimeout(() => {
      if (tourDriver.isLastStep()) return; // se queda abierto, no autocierra
      tourDriver.moveNext();
    }, AUTOPLAY_MS);
  };

  // Un click manual en Anterior/Siguiente pasa a modo manual: pausa el
  // autoplay antes de navegar, así el próximo onHighlighted no reprograma el timer.
  const pauseFromManualNav = () => {
    autoplayEnabled = false;
    clearAutoplayTimer();
  };

  tourDriver = driver({
    showProgress: true,
    allowClose: false,
    nextBtnText: 'Siguiente',
    prevBtnText: 'Anterior',
    doneBtnText: 'Hecho',
    progressText: '{{current}} de {{total}}',
    onCloseClick: () => { clearAutoplayTimer(); tourDriver.destroy(); },
    // Único punto de cierre común a los 3 caminos (X, Omitir, Hecho): todos
    // pasan por tourDriver.destroy(), así que acá se marca "visto" una sola
    // vez, recién cuando el usuario efectivamente cierra/termina el tour.
    onDestroyed: () => {
      clearAutoplayTimer();
      try { localStorage.setItem(seenKey, '1'); } catch {}
    },
    onHighlighted: () => scheduleAutoplayStep(),
    // driver.js no expone moveNext/movePrevious "puros": setear onNextClick/
    // onPrevClick a nivel global reemplaza la navegación por defecto de esos
    // botones, así que acá replicamos esa navegación a mano (isLastStep ⇒
    // cierra como el botón "Hecho"; si no, moveNext) después de pasar a modo manual.
    onNextClick: () => {
      pauseFromManualNav();
      if (tourDriver.isLastStep()) tourDriver.destroy();
      else tourDriver.moveNext();
    },
    onPrevClick: () => {
      pauseFromManualNav();
      tourDriver.movePrevious();
    },
    // Agrega botones "Omitir" y pausa/play junto a "Anterior"/"Siguiente" en
    // cada step. driver.js@1.8 no tiene una opción declarativa de botones
    // custom en el popover: el hook onPopoverRender da acceso al DOM ya
    // montado del popover para insertarlos a mano (se recrea en cada step).
    onPopoverRender: (popover) => {
      const skipBtn = document.createElement('button');
      skipBtn.innerText = 'Omitir';
      skipBtn.className = 'driver-popover-skip-btn';
      popover.footerButtons.insertBefore(skipBtn, popover.footerButtons.firstChild);
      skipBtn.addEventListener('click', () => tourDriver.destroy());

      const playPauseBtn = document.createElement('button');
      playPauseBtn.type = 'button';
      playPauseBtn.className = 'driver-popover-playpause-btn';
      const syncPlayPauseBtn = () => {
        playPauseBtn.innerHTML = autoplayEnabled ? '&#10073;&#10073;' : '&#9654;';
        playPauseBtn.title = autoplayEnabled ? 'Pausar avance automático' : 'Reanudar avance automático';
      };
      syncPlayPauseBtn();
      playPauseBtn.addEventListener('click', () => {
        autoplayEnabled = !autoplayEnabled;
        if (autoplayEnabled) scheduleAutoplayStep();
        else clearAutoplayTimer();
        syncPlayPauseBtn();
      });
      popover.footerButtons.insertBefore(playPauseBtn, popover.footerButtons.firstChild);
    },
    steps,
  });
  tourDriver.drive();
}

import { useCallback, useEffect, useRef, useState } from "react";
import { HolographicFrame } from "./HolographicFrame";

export function WindowChrome() {
  const [maximized, setMaximized] = useState(false);
  const [visible, setVisible] = useState(false);
  const chromeRef = useRef<HTMLDivElement>(null);
  const revealRef = useRef<HTMLButtonElement>(null);
  const hideTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  const cancelHide = useCallback(() => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const showChrome = useCallback(() => {
    cancelHide();
    setVisible(true);
  }, [cancelHide]);

  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => {
      const activeElement = document.activeElement;
      const revealHasKeyboardFocus = revealRef.current === activeElement
        && (revealRef.current?.matches(":focus-visible") ?? false);
      const keyboardFocusIsInChrome = chromeRef.current?.contains(activeElement) || revealHasKeyboardFocus;
      const pointerIsAtTopEdge = revealRef.current?.matches(":hover") ?? false;
      if (!keyboardFocusIsInChrome && !pointerIsAtTopEdge) setVisible(false);
      hideTimer.current = null;
    }, 220);
  }, [cancelHide]);

  useEffect(() => () => cancelHide(), [cancelHide]);

  async function toggleMaximize() {
    try {
      setMaximized(await window.nexaDesktop.toggleMaximizeWindow());
    } catch {
      // A failed window operation leaves the current visual state unchanged.
    }
  }

  return (
    <>
      <button
        ref={revealRef}
        type="button"
        className="window-chrome-reveal"
        aria-label="Mostrar controles de ventana"
        aria-controls="nexa-window-chrome"
        aria-expanded={visible}
        title="Mostrar controles de ventana"
        onPointerEnter={showChrome}
        onFocus={showChrome}
        onClick={showChrome}
      />
      <div
        ref={chromeRef}
        id="nexa-window-chrome"
        className={`window-chrome${visible ? " window-chrome--visible" : ""}`}
        data-visible={visible}
        aria-hidden={!visible}
        onPointerEnter={showChrome}
        onPointerLeave={(event) => {
          if (event.buttons === 0) scheduleHide();
        }}
        onFocusCapture={showChrome}
        onBlurCapture={scheduleHide}
      >
        <div className="window-drag-region" aria-hidden="true">
          <span className="window-chrome-title">NEXA <span>/</span> COMMAND CENTER</span>
        </div>
        <div className="window-controls" role="group" aria-label="Controles de ventana">
          <button type="button" className="window-control" aria-label="Minimizar ventana" title="Minimizar" onClick={() => window.nexaDesktop.minimizeWindow()}>
            <svg aria-hidden="true" viewBox="0 0 12 12"><path d="M2.5 8.5h7" /></svg>
            <HolographicFrame variant="control" />
          </button>
          <button
            type="button"
            className="window-control"
            aria-label={maximized ? "Restaurar ventana" : "Maximizar ventana"}
            title={maximized ? "Restaurar" : "Maximizar"}
            onClick={() => void toggleMaximize()}
          >
            <svg aria-hidden="true" viewBox="0 0 12 12">
              {maximized
                ? <><path d="M4 2.5h5.5V8" /><path d="M2.5 4h5.5v5.5H2.5z" /></>
                : <path d="M2.75 2.75h6.5v6.5h-6.5z" />}
            </svg>
            <HolographicFrame variant="control" />
          </button>
          <button type="button" className="window-control window-control--close" aria-label="Cerrar ventana" title="Cerrar" onClick={() => window.nexaDesktop.closeWindow()}>
            <svg aria-hidden="true" viewBox="0 0 12 12"><path d="m3 3 6 6M9 3 3 9" /></svg>
            <HolographicFrame variant="control" />
          </button>
        </div>
      </div>
      <div
        className={`window-chrome-dismiss${visible ? " window-chrome-dismiss--active" : ""}`}
        aria-hidden="true"
        onPointerEnter={(event) => {
          if (event.buttons === 0) scheduleHide();
        }}
        onPointerUp={scheduleHide}
        onPointerLeave={(event) => {
          if (event.clientY < 32) showChrome();
        }}
      />
    </>
  );
}

// ---- Viewport Lock (iOS Safari) ----

let viewportSyncQueued = false;

function syncViewportVars() {
  const viewport = window.visualViewport;
  const rawWidth = viewport ? viewport.width : window.innerWidth;
  const rawHeight = viewport ? viewport.height : window.innerHeight;
  const rawOffsetX = viewport ? viewport.offsetLeft : 0;
  const rawOffsetY = viewport ? viewport.offsetTop : 0;
  if (!rawWidth || !rawHeight) return;

  // Floor values to avoid fractional-pixel overflow causing right-edge drift.
  document.documentElement.style.setProperty("--app-width", `${Math.floor(rawWidth)}px`);
  document.documentElement.style.setProperty("--app-height", `${Math.floor(rawHeight)}px`);
  document.documentElement.style.setProperty("--app-offset-x", `${Math.max(0, Math.floor(rawOffsetX))}px`);
  document.documentElement.style.setProperty("--app-offset-y", `${Math.max(0, Math.floor(rawOffsetY))}px`);
}

export function queueViewportSync() {
  if (viewportSyncQueued) return;
  viewportSyncQueued = true;
  requestAnimationFrame(() => {
    viewportSyncQueued = false;
    syncViewportVars();
  });
}

export function initViewportLock() {
  const handleViewportGeometryChange = () => queueViewportSync();

  syncViewportVars();
  window.addEventListener("resize", handleViewportGeometryChange, { passive: true });
  window.addEventListener("orientationchange", handleViewportGeometryChange, { passive: true });
  document.addEventListener("focusin", handleViewportGeometryChange, { passive: true });
  document.addEventListener("focusout", handleViewportGeometryChange, { passive: true });

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", handleViewportGeometryChange, { passive: true });
    window.visualViewport.addEventListener("scroll", handleViewportGeometryChange, { passive: true });
  }

  // Safari can apply keyboard-related viewport shifts a tick later.
  setTimeout(handleViewportGeometryChange, 0);
  setTimeout(handleViewportGeometryChange, 120);
}

export function stabilizeKeyboardViewport() {
  const settle = () => queueViewportSync();

  setTimeout(settle, 0);
  setTimeout(settle, 120);
  setTimeout(settle, 260);
  setTimeout(settle, 500);
}

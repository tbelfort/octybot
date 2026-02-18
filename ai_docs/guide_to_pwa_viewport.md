# Comprehensive Guide: Stable iOS Safari Viewport for PWAs

This guide documents a **proven working pattern** for full-screen web apps/PWAs on iPhone Safari, including keyboard open/close and browser chrome changes.

It is framework-agnostic and intended for any project.

## What this solves

- Header/nav jumping off-screen when input gets focus.
- Bottom composer/input getting obscured during keyboard transitions.
- Horizontal swipe drift/right-edge gaps.
- Inconsistent layout during Safari toolbar and keyboard animation.

## Core fix (the pattern that worked)

1. Keep `body` non-fixed.
2. Use a dedicated fixed viewport wrapper (for example, `#app-viewport`).
3. Size it from `visualViewport.width/height`.
4. Position it with `visualViewport.offsetLeft/offsetTop` via CSS transform.
5. Allow scroll only in explicit internal regions.
6. Run queued viewport re-sync on viewport/focus events and short delayed ticks.
7. Do not rely on `autofocus` for the main composer input on iOS.

---

## 1) HTML blueprint

Use viewport metadata:

```html
<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content"
>
```

Use a dedicated app viewport root:

```html
<body>
  <div id="app-viewport">
    <div id="app-shell">
      <header class="app-header">...</header>
      <main class="app-main" data-scroll-region>...</main>
      <footer class="app-composer">
        <textarea data-composer-input rows="1" placeholder="Message..."></textarea>
      </footer>
    </div>
  </div>
  <script src="app.js"></script>
</body>
```

Notes:

- Avoid `autofocus` on `data-composer-input`.
- Keep one clear root wrapper that owns the visible app frame.

---

## 2) CSS blueprint

### 2.1 Root variables

```css
:root {
  --app-width: 100%;
  --app-height: 100vh;
  --app-offset-x: 0px;
  --app-offset-y: 0px;

  --safe-top: env(safe-area-inset-top, 0px);
  --safe-right: env(safe-area-inset-right, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --safe-left: env(safe-area-inset-left, 0px);
}

@supports (height: 100dvh) {
  :root {
    --app-height: 100dvh;
  }
}
```

### 2.2 Page lock and body

```css
html,
body {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  -webkit-text-size-adjust: 100%;
}

body {
  position: relative; /* important: not fixed */
}
```

### 2.3 Fixed viewport wrapper (critical)

```css
#app-viewport {
  position: fixed;
  top: 0;
  left: 0;
  width: var(--app-width);
  max-width: 100%;
  height: var(--app-height);
  min-height: var(--app-height);

  overflow: hidden;
  overscroll-behavior: none;
  touch-action: none;

  transform: translate3d(var(--app-offset-x), var(--app-offset-y), 0);
  will-change: transform, width, height;
}
```

### 2.4 Shell and scroll ownership

```css
#app-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}

[data-scroll-region] {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  touch-action: pan-y;
  overscroll-behavior: contain;
}
```

### 2.5 Header/composer safe-area + input zoom guard

```css
.app-header {
  flex-shrink: 0;
  padding-top: calc(12px + var(--safe-top));
  padding-left: calc(16px + var(--safe-left));
  padding-right: calc(16px + var(--safe-right));
  min-height: calc(52px + var(--safe-top));
}

.app-composer {
  flex-shrink: 0;
  padding-left: calc(16px + var(--safe-left));
  padding-right: calc(16px + var(--safe-right));
  padding-bottom: calc(12px + var(--safe-bottom));
}

textarea,
input,
select {
  font-size: 16px;
}
```

---

## 3) JavaScript blueprint (actual working behavior)

```js
let viewportSyncQueued = false;

function syncViewportVars() {
  const vv = window.visualViewport;
  const rawWidth = vv ? vv.width : window.innerWidth;
  const rawHeight = vv ? vv.height : window.innerHeight;
  const rawOffsetX = vv ? vv.offsetLeft : 0;
  const rawOffsetY = vv ? vv.offsetTop : 0;
  if (!rawWidth || !rawHeight) return;

  // Floor values to avoid fractional-pixel drift.
  document.documentElement.style.setProperty("--app-width", `${Math.floor(rawWidth)}px`);
  document.documentElement.style.setProperty("--app-height", `${Math.floor(rawHeight)}px`);
  document.documentElement.style.setProperty("--app-offset-x", `${Math.max(0, Math.floor(rawOffsetX))}px`);
  document.documentElement.style.setProperty("--app-offset-y", `${Math.max(0, Math.floor(rawOffsetY))}px`);
}

function queueViewportSync() {
  if (viewportSyncQueued) return;
  viewportSyncQueued = true;
  requestAnimationFrame(() => {
    viewportSyncQueued = false;
    syncViewportVars();
  });
}

function initViewportStability() {
  const onGeometryChange = () => queueViewportSync();

  syncViewportVars();
  window.addEventListener("resize", onGeometryChange, { passive: true });
  window.addEventListener("orientationchange", onGeometryChange, { passive: true });
  document.addEventListener("focusin", onGeometryChange, { passive: true });
  document.addEventListener("focusout", onGeometryChange, { passive: true });

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onGeometryChange, { passive: true });
    window.visualViewport.addEventListener("scroll", onGeometryChange, { passive: true });
  }

  // Safari often applies geometry in phases.
  setTimeout(onGeometryChange, 0);
  setTimeout(onGeometryChange, 120);
}

function stabilizeKeyboardViewport() {
  const settle = () => queueViewportSync();
  setTimeout(settle, 0);
  setTimeout(settle, 120);
  setTimeout(settle, 260);
  setTimeout(settle, 500);
}

const composerInput = document.querySelector("[data-composer-input]");
if (composerInput) {
  composerInput.addEventListener("focus", stabilizeKeyboardViewport);
  composerInput.addEventListener("blur", () => {
    setTimeout(queueViewportSync, 0);
    setTimeout(queueViewportSync, 120);
  });
}

initViewportStability();
```

Important detail:

- This pattern relies on **offset transform** (`--app-offset-x/y`) and **does not require forced `window.scrollTo(...)` loops**.

---

## 4) Why this works

- `visualViewport.width/height` tracks the visible area during keyboard/chrome changes.
- `visualViewport.offsetLeft/offsetTop` tracks the visual viewport shift relative to layout viewport.
- Applying both size and offset to a dedicated fixed wrapper keeps the app frame aligned with what users actually see.
- Keeping `body` non-fixed avoids a common Safari keyboard jump failure mode.

---

## 5) What to avoid

- Fixed `body` as the app root for this use case.
- `100vh`-only fullscreen logic.
- Depending only on safe-area insets for keyboard behavior.
- Page-level horizontal locking as the only anti-drift strategy.
- `autofocus` on chat/composer input for first paint on iOS Safari.

---

## 6) Symptom -> fix map

| Symptom | Likely issue | Fix |
|---|---|---|
| Header jumps upward on keyboard open | Root not aligned to visual viewport offset | Use `offsetLeft/offsetTop` -> CSS transform on fixed wrapper |
| Bottom composer clipped | Height tied to static viewport | Sync `--app-height` from `visualViewport.height` |
| Right-edge drift / side gap | Fractional viewport width | Floor width/height before writing CSS vars |
| Layout unstable during keyboard animation | Single-shot resize handling | Add delayed re-sync ticks (`0/120/260/500ms`) |
| Header too high under status/notch area | Missing top safe area | Add `padding-top`/`min-height` with `safe-area-inset-top` |

---

## 7) Framework integration

The same approach applies in React/Vue/Svelte:

1. Initialize viewport sync once on app mount.
2. Attach event listeners once.
3. Remove listeners on unmount (for route-level mounts).
4. Wire focus/blur stabilizer to your composer input.

Keep the CSS variable contract unchanged.

---

## 8) Debugging checklist (real device)

Always validate on physical iPhone Safari:

1. Open app in Safari browser mode.
2. Swipe horizontally: app frame should not drift.
3. Tap composer: header should remain visible.
4. Type and dismiss keyboard: app should settle without jump.
5. Rotate portrait/landscape and re-test.

If behavior differs between builds, verify service worker cache freshness.

---

## 9) Optional live viewport debug overlay

Use this temporarily:

```js
function mountViewportDebug() {
  const el = document.createElement("pre");
  el.style.cssText = [
    "position:fixed",
    "top:0",
    "right:0",
    "z-index:999999",
    "margin:0",
    "padding:6px 8px",
    "background:rgba(0,0,0,0.7)",
    "color:#0f0",
    "font:11px/1.3 monospace",
    "pointer-events:none",
  ].join(";");
  document.body.appendChild(el);

  const render = () => {
    const vv = window.visualViewport;
    el.textContent = vv
      ? [
          `inner: ${window.innerWidth}x${window.innerHeight}`,
          `vv: ${vv.width.toFixed(1)}x${vv.height.toFixed(1)}`,
          `off: ${vv.offsetLeft.toFixed(1)},${vv.offsetTop.toFixed(1)}`,
        ].join("\n")
      : "visualViewport: n/a";
  };

  const onChange = () => requestAnimationFrame(render);
  render();
  window.addEventListener("resize", onChange, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onChange, { passive: true });
    window.visualViewport.addEventListener("scroll", onChange, { passive: true });
  }

  return () => {
    window.removeEventListener("resize", onChange);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", onChange);
      window.visualViewport.removeEventListener("scroll", onChange);
    }
    el.remove();
  };
}
```

---

## 10) Release checklist

- `body` is non-fixed.
- Dedicated fixed wrapper exists.
- Width/height and offset CSS vars are synced from `visualViewport`.
- Header/composer include safe-area padding.
- Composer input is 16px+ and not auto-focused on load.
- Scroll ownership is explicit (`data-scroll-region` only).
- Keyboard transitions tested on physical iPhone Safari.
- Service worker cache/version bumped when viewport logic changed.


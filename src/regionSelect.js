// Region-selection overlay, injected into the page via chrome.scripting
// (func serialization) — so it must be fully self-contained: no imports, no
// closure references. Resolves {x, y, width, height, dpr} in CSS pixels, or
// null when cancelled (Esc or a sub-4px drag). Removes itself before
// resolving so the overlay never appears in the capture.
export function regionSelectOverlay() {
  return new Promise((resolve) => {
    const Z = 2147483647;
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: Z,
      cursor: "crosshair",
      background: "rgba(0, 0, 0, 0.25)",
    });
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      border: "2px solid #10b981",
      background: "rgba(16, 185, 129, 0.15)",
      display: "none",
      zIndex: Z,
      pointerEvents: "none",
    });
    overlay.appendChild(box);

    let sx = 0;
    let sy = 0;
    let dragging = false;

    const done = (rect) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(rect);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done(null);
      }
    };
    const update = (e) => {
      const x = Math.min(sx, e.clientX);
      const y = Math.min(sy, e.clientY);
      const w = Math.abs(e.clientX - sx);
      const h = Math.abs(e.clientY - sy);
      Object.assign(box.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
    };

    overlay.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      box.style.display = "block";
      update(e);
    });
    overlay.addEventListener("mousemove", (e) => dragging && update(e));
    overlay.addEventListener("mouseup", (e) => {
      if (!dragging) return;
      const x = Math.min(sx, e.clientX);
      const y = Math.min(sy, e.clientY);
      const w = Math.abs(e.clientX - sx);
      const h = Math.abs(e.clientY - sy);
      if (w < 4 || h < 4) return done(null);
      done({ x, y, width: w, height: h, dpr: window.devicePixelRatio || 1 });
    });

    document.addEventListener("keydown", onKey, true);
    document.documentElement.appendChild(overlay);
  });
}

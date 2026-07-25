// Selection helper content script (classic script — content scripts can't be
// ES modules). When the user selects text on a page, a small floating pill
// appears near the selection: H1 / H2 / list / paragraph. Clicking one sends
// ONLY the selected text to the background, which files it into the last-used
// Doc bucket with that format. Reads nothing else from the page; can be
// disabled via the popup's "Selection helper" toggle (chrome.storage
// `selectionHelper`).
(() => {
  if (window.top !== window) return; // main frame only
  // Injected on demand into the active tab (chrome.scripting) — guard against
  // running twice if the popup is opened again on the same page.
  if (window.__dumpsterSelInit) return;
  window.__dumpsterSelInit = true;

  let enabled = true; // master toggle; storage wiring set up at the bottom

  // Shadow DOM so page CSS can't restyle the pill (and vice versa).
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .launcher[hidden] { display: none !important; }
    .launcher {
      position: fixed;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px;
      background: #1f2430;
      border: 1px solid #343b4a;
      border-right: none;
      border-radius: 12px 0 0 12px;
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.32);
      font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      transition: transform 0.16s ease;
      transform-origin: right center;
    }
    .launcher .l-icon {
      width: 26px;
      height: 26px;
      border-radius: 7px;
      background: #10b981;
      box-shadow: inset 0 0 0 3px rgba(255, 255, 255, 0.25);
      flex: 0 0 auto;
      cursor: pointer;
    }
    .launcher .l-menu {
      display: none;
      flex-direction: column;
      gap: 4px;
    }
    .launcher:hover .l-menu,
    .launcher.open .l-menu {
      display: flex;
    }
    .launcher .l-menu button {
      border: none;
      background: none;
      color: #e5e9f0;
      font: inherit;
      font-weight: 600;
      text-align: left;
      white-space: nowrap;
      padding: 7px 10px;
      border-radius: 7px;
      cursor: pointer;
    }
    .launcher .l-menu button:hover {
      background: #10b981;
      color: #04150f;
    }
    .l-note {
      color: #e5e9f0;
      font-weight: 600;
      padding: 7px 4px;
      white-space: nowrap;
    }
    .pill[hidden] { display: none !important; }
    .pill {
      position: fixed;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 4px 6px;
      background: #1f2430;
      border: 1px solid #343b4a;
      border-radius: 10px;
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.35);
      font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .logo {
      width: 14px;
      height: 14px;
      border-radius: 4px;
      background: #10b981;
      margin-right: 4px;
      flex: 0 0 auto;
    }
    button {
      border: none;
      background: none;
      color: #e5e9f0;
      font: inherit;
      font-weight: 700;
      padding: 6px 8px;
      border-radius: 6px;
      cursor: pointer;
    }
    button:hover {
      background: #10b981;
      color: #04150f;
    }
    .note {
      color: #e5e9f0;
      font-weight: 600;
      padding: 6px 8px;
      white-space: nowrap;
    }
  `;
  const pill = document.createElement("div");
  pill.className = "pill";
  pill.hidden = true;
  root.append(style, pill);

  const BUTTONS = [
    { format: "h1", label: "H1", title: "Save to doc as Heading 1" },
    { format: "h2", label: "H2", title: "Save to doc as Heading 2" },
    { format: "list", label: "≔", title: "Save to doc as bullet list" },
    { format: "p", label: "¶", title: "Save to doc as paragraph" },
  ];

  function renderButtons() {
    pill.textContent = "";
    const logo = document.createElement("span");
    logo.className = "logo";
    pill.appendChild(logo);
    for (const b of BUTTONS) {
      const btn = document.createElement("button");
      btn.dataset.format = b.format;
      btn.textContent = b.label;
      btn.title = b.title;
      pill.appendChild(btn);
    }
  }
  renderButtons();

  let currentText = "";
  let noteTimer = null;

  const hide = () => {
    pill.hidden = true;
  };

  function maybeShow() {
    if (!enabled) return hide();
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? String(sel).trim() : "";
    if (!text) return hide();
    const anchor =
      sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    if (anchor?.closest?.("input, textarea, [contenteditable=''], [contenteditable=true]")) return hide();
    let rect;
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch {
      return hide();
    }
    if (!rect || (!rect.width && !rect.height)) return hide();

    currentText = text;
    renderButtons();
    pill.hidden = false;
    const pw = pill.offsetWidth || 150;
    const ph = pill.offsetHeight || 32;
    let x = rect.left + rect.width / 2 - pw / 2;
    let y = rect.top - ph - 8;
    if (y < 4) y = rect.bottom + 8;
    x = Math.max(4, Math.min(x, window.innerWidth - pw - 4));
    pill.style.left = x + "px";
    pill.style.top = y + "px";
  }

  function showNote(msg) {
    pill.textContent = "";
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = msg;
    pill.appendChild(note);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(hide, 1400);
  }

  pill.addEventListener("click", (e) => {
    const btn = e.target.closest?.("button[data-format]");
    if (!btn || !currentText) return;
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage(
      { type: "dumpster-selection-save", format: btn.dataset.format, text: currentText },
      (res) => {
        if (chrome.runtime.lastError) return showNote("Dumpster reloaded — try again");
        showNote(res?.ok ? `✓ Saved to ${res.bucketName}` : res?.error || "Failed");
      }
    );
  });

  // ---- Floating launcher (docked right edge; expands on hover) ----
  const launcher = document.createElement("div");
  launcher.className = "launcher";
  launcher.hidden = !enabled;
  function renderLauncher() {
    launcher.textContent = "";
    const icon = document.createElement("span");
    icon.className = "l-icon";
    icon.title = "Dumpster — screenshot to your Doc bucket";
    const menu = document.createElement("div");
    menu.className = "l-menu";
    for (const b of [
      { mode: "region", label: "⬚ Region" },
      { mode: "visible", label: "🖼 Visible" },
    ]) {
      const btn = document.createElement("button");
      btn.dataset.mode = b.mode;
      btn.textContent = b.label;
      menu.appendChild(btn);
    }
    launcher.append(menu, icon); // menu expands leftward; icon stays at the edge
  }
  renderLauncher();
  root.appendChild(launcher);

  let lNoteTimer = null;
  function launcherNote(msg) {
    launcher.textContent = "";
    const note = document.createElement("span");
    note.className = "l-note";
    note.textContent = msg;
    launcher.appendChild(note);
    clearTimeout(lNoteTimer);
    lNoteTimer = setTimeout(renderLauncher, 1600);
  }

  launcher.addEventListener("click", (e) => {
    const btn = e.target.closest?.("button[data-mode]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const mode = btn.dataset.mode;
    // Hide our whole UI so the launcher/pill aren't in the capture, then shoot.
    host.style.visibility = "hidden";
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: "dumpster-shot", mode }, (res) => {
        host.style.visibility = "";
        if (chrome.runtime.lastError) return launcherNote("Reloaded — try again");
        if (res?.cancelled) return; // region selection cancelled
        launcherNote(res?.ok ? `✓ Saved to ${res.bucketName}` : res?.error || "Failed");
      });
    }, 60);
  });

  document.addEventListener("mouseup", (e) => {
    if (e.composedPath().includes(host)) return;
    setTimeout(maybeShow, 10); // let the selection settle
  });
  document.addEventListener("mousedown", (e) => {
    if (!e.composedPath().includes(host)) hide();
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === "Escape") hide();
  });
  document.addEventListener("scroll", hide, true);

  // Master enable/disable (popup toggle) — governs both the pill and launcher.
  function applyEnabled() {
    launcher.hidden = !enabled;
    if (!enabled) hide();
  }
  chrome.storage.local.get("selectionHelper", (o) => {
    enabled = o.selectionHelper !== false;
    applyEnabled();
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.selectionHelper) {
      enabled = ch.selectionHelper.newValue !== false;
      applyEnabled();
    }
  });

  document.documentElement.appendChild(host);
})();

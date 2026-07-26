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
    }
    /* once dragged, an explicit top wins over the centered default */
    .launcher.pos { top: 0; transform: none; }
    .launcher .l-icon {
      width: 26px;
      height: 26px;
      border-radius: 7px;
      background: #10b981;
      box-shadow: inset 0 0 0 3px rgba(255, 255, 255, 0.25);
      flex: 0 0 auto;
      cursor: grab;
      touch-action: none;
    }
    .launcher .l-icon.dragging { cursor: grabbing; }
    .launcher .l-menu {
      display: none;
      flex-direction: column;
      gap: 2px;
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
      padding: 6px 10px;
      border-radius: 7px;
      cursor: pointer;
    }
    .launcher .l-menu button:hover {
      background: #10b981;
      color: #04150f;
    }
    .launcher .l-sep {
      height: 1px;
      background: #343b4a;
      margin: 2px 4px;
    }
    /* × close button — corner of the dock, revealed on hover/open */
    .l-close {
      position: absolute;
      top: -10px;
      left: -10px;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #fff;
      color: #1f2430;
      border: 1px solid #d0d5dd;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
      display: none;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      padding: 0;
    }
    .launcher:hover .l-close,
    .launcher.open .l-close {
      display: flex;
    }
    .l-close:hover { background: #f3f4f6; }
    /* light popover with the three hide options */
    .l-hide-menu {
      position: absolute;
      top: 0;
      right: calc(100% + 10px);
      background: #fff;
      color: #1f2430;
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22);
      padding: 6px;
      display: none;
      flex-direction: column;
      min-width: 190px;
    }
    .l-hide-menu.open { display: flex; }
    .l-hide-menu button {
      border: none;
      background: none;
      color: #1f2430;
      font: inherit;
      font-size: 14px;
      text-align: left;
      white-space: nowrap;
      padding: 11px 14px;
      border-radius: 8px;
      cursor: pointer;
    }
    .l-hide-menu button:hover { background: #f3f4f6; }
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

  // ---- Floating dock (right edge; drag up/down; expands on hover) ----
  // Hide states live in chrome.storage (domain list / all sites) or, for
  // "until next visit", sessionStorage (cleared when the tab session ends).
  const HIDE_ALL_KEY = "dumpsterDockHideAll";
  const HIDE_DOMAINS_KEY = "dumpsterDockHideDomains";
  const POS_KEY = "dumpsterDockTop";
  const SESSION_HIDE_KEY = "dumpsterDockHideSession";
  const thisDomain = location.hostname;

  let hideAll = false;
  let hideDomains = [];
  const sessionHidden = () => {
    try {
      return sessionStorage.getItem(SESSION_HIDE_KEY) === "1";
    } catch {
      return false;
    }
  };
  const dockVisible = () =>
    enabled && !hideAll && !hideDomains.includes(thisDomain) && !sessionHidden();

  // The dock's format buttons act on the live selection, falling back to the
  // text the pill last captured.
  function getSelText() {
    const sel = window.getSelection();
    const t = sel && !sel.isCollapsed ? String(sel).trim() : "";
    return t || currentText;
  }

  const launcher = document.createElement("div");
  launcher.className = "launcher";
  launcher.hidden = true; // corrected by applyEnabled() once storage loads

  function renderLauncher() {
    launcher.textContent = "";

    const close = document.createElement("button");
    close.className = "l-close";
    close.textContent = "×";
    close.title = "Hide the Dumpster dock";

    const hideMenu = document.createElement("div");
    hideMenu.className = "l-hide-menu";
    for (const h of [
      { act: "session", label: "Hide until next visit" },
      { act: "domain", label: "Hide on this domain" },
      { act: "all", label: "Hide on all websites" },
    ]) {
      const b = document.createElement("button");
      b.dataset.hide = h.act;
      b.textContent = h.label;
      hideMenu.appendChild(b);
    }

    const menu = document.createElement("div");
    menu.className = "l-menu";
    const items = [
      { kind: "fmt", format: "h1", label: "H1" },
      { kind: "fmt", format: "h2", label: "H2" },
      { kind: "fmt", format: "list", label: "≔ List" },
      { kind: "fmt", format: "p", label: "¶ Paragraph" },
      { kind: "sep" },
      { kind: "shot", mode: "region", label: "⬚ Screenshot region" },
      { kind: "shot", mode: "visible", label: "🖼 Screenshot page" },
    ];
    for (const it of items) {
      if (it.kind === "sep") {
        const s = document.createElement("div");
        s.className = "l-sep";
        menu.appendChild(s);
        continue;
      }
      const btn = document.createElement("button");
      if (it.kind === "fmt") btn.dataset.format = it.format;
      else btn.dataset.mode = it.mode;
      btn.textContent = it.label;
      menu.appendChild(btn);
    }

    const icon = document.createElement("span");
    icon.className = "l-icon";
    icon.title = "Dumpster — drag to move · hover for options";

    // close + hide popover, then menu (expands leftward), then edge icon
    launcher.append(close, hideMenu, menu, icon);
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

  function saveFormat(format) {
    const text = getSelText();
    if (!text) return launcherNote("Select text first");
    chrome.runtime.sendMessage(
      { type: "dumpster-selection-save", format, text },
      (res) => {
        if (chrome.runtime.lastError) return launcherNote("Reloaded — try again");
        launcherNote(res?.ok ? `✓ Saved to ${res.bucketName}` : res?.error || "Failed");
      }
    );
  }

  function takeShot(mode) {
    // Hide our whole UI so the dock/pill aren't in the capture, then shoot.
    host.style.visibility = "hidden";
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: "dumpster-shot", mode }, (res) => {
        host.style.visibility = "";
        if (chrome.runtime.lastError) return launcherNote("Reloaded — try again");
        if (res?.cancelled) return; // region selection cancelled
        launcherNote(res?.ok ? `✓ Saved to ${res.bucketName}` : res?.error || "Failed");
      });
    }, 60);
  }

  function applyHide(act) {
    if (act === "session") {
      try {
        sessionStorage.setItem(SESSION_HIDE_KEY, "1");
      } catch {}
    } else if (act === "domain") {
      if (!hideDomains.includes(thisDomain)) hideDomains.push(thisDomain);
      chrome.storage.local.set({ [HIDE_DOMAINS_KEY]: hideDomains });
    } else if (act === "all") {
      hideAll = true;
      chrome.storage.local.set({ [HIDE_ALL_KEY]: true });
    }
    applyEnabled();
  }

  launcher.addEventListener("click", (e) => {
    if (e.target.closest?.(".l-close")) {
      e.preventDefault();
      e.stopPropagation();
      root.querySelector(".l-hide-menu")?.classList.toggle("open");
      return;
    }
    const hideBtn = e.target.closest?.("button[data-hide]");
    if (hideBtn) {
      e.preventDefault();
      e.stopPropagation();
      applyHide(hideBtn.dataset.hide);
      return;
    }
    const fmtBtn = e.target.closest?.("button[data-format]");
    if (fmtBtn) {
      e.preventDefault();
      e.stopPropagation();
      saveFormat(fmtBtn.dataset.format);
      return;
    }
    const shotBtn = e.target.closest?.("button[data-mode]");
    if (shotBtn) {
      e.preventDefault();
      e.stopPropagation();
      takeShot(shotBtn.dataset.mode);
    }
  });

  // ---- Drag the dock up/down along the right edge ----
  let dockTop = null; // px from top once the user has positioned it
  function applyPos() {
    if (dockTop == null) {
      launcher.classList.remove("pos");
      launcher.style.top = "";
      return;
    }
    const h = launcher.offsetHeight || 60;
    const max = Math.max(0, window.innerHeight - h);
    launcher.classList.add("pos");
    launcher.style.top = Math.min(Math.max(0, dockTop), max) + "px";
  }

  launcher.addEventListener("mousedown", (e) => {
    const icon = e.target.closest?.(".l-icon");
    if (!icon) return;
    e.preventDefault();
    const startY = e.clientY;
    const startTop = launcher.getBoundingClientRect().top;
    let moved = false;
    icon.classList.add("dragging");
    const onMove = (ev) => {
      const dy = ev.clientY - startY;
      if (Math.abs(dy) > 3) moved = true;
      dockTop = startTop + dy;
      applyPos();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      icon.classList.remove("dragging");
      if (moved && dockTop != null) chrome.storage.local.set({ [POS_KEY]: dockTop });
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
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

  // Master enable/disable (popup toggle) plus the dock's own hide states.
  function applyEnabled() {
    launcher.hidden = !dockVisible();
    if (!enabled) hide();
  }
  chrome.storage.local.get(
    ["selectionHelper", HIDE_ALL_KEY, HIDE_DOMAINS_KEY, POS_KEY],
    (o) => {
      enabled = o.selectionHelper !== false;
      hideAll = o[HIDE_ALL_KEY] === true;
      hideDomains = Array.isArray(o[HIDE_DOMAINS_KEY]) ? o[HIDE_DOMAINS_KEY] : [];
      if (typeof o[POS_KEY] === "number") {
        dockTop = o[POS_KEY];
        applyPos();
      }
      applyEnabled();
    }
  );
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.selectionHelper) {
      enabled = ch.selectionHelper.newValue !== false;
      // Re-enabling from the popup fully restores the dock on this tab too.
      if (enabled) {
        try {
          sessionStorage.removeItem(SESSION_HIDE_KEY);
        } catch {}
      }
    }
    if (ch[HIDE_ALL_KEY]) hideAll = ch[HIDE_ALL_KEY].newValue === true;
    if (ch[HIDE_DOMAINS_KEY])
      hideDomains = Array.isArray(ch[HIDE_DOMAINS_KEY].newValue) ? ch[HIDE_DOMAINS_KEY].newValue : [];
    if (ch[POS_KEY] && typeof ch[POS_KEY].newValue === "number") {
      dockTop = ch[POS_KEY].newValue;
      applyPos();
    }
    applyEnabled();
  });

  document.documentElement.appendChild(host);
})();

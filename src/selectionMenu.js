// Selection helper content script (classic script — content scripts can't be
// ES modules). When the user selects text on a page, a small floating pill
// appears near the selection: H1 / H2 / list / paragraph. Clicking one sends
// ONLY the selected text to the background, which files it into the last-used
// Doc bucket with that format. Reads nothing else from the page; can be
// disabled via the popup's "Selection helper" toggle (chrome.storage
// `selectionHelper`).
(() => {
  if (window.top !== window) return; // main frame only

  let enabled = true;
  chrome.storage.local.get("selectionHelper", (o) => {
    enabled = o.selectionHelper !== false;
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.selectionHelper) enabled = ch.selectionHelper.newValue !== false;
  });

  // Shadow DOM so page CSS can't restyle the pill (and vice versa).
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
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

  document.documentElement.appendChild(host);
})();

// Tiny dependency-free markdown renderer for the doc editor's live preview.
// Supports: # ## ### headings, **bold**, *em*, `code`, ``` fences, - / 1. lists,
// > quotes, [text](url), ![alt](src), --- rules, paragraphs. All text is
// HTML-escaped first, so page content can't inject markup. Image sources are
// restricted to safe schemes; `dumpster:img:<entryId>` is resolved through the
// caller-supplied resolver (object URLs from IndexedDB blobs).

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const SAFE_HREF = /^(https?:|mailto:)/i;
const SAFE_SRC = /^(https?:|data:image\/|blob:)/i;

// Inline spans: code first — stashed behind sentinel placeholders so the later
// bold/em passes can't restyle code contents — then images, links, bold, em,
// and finally the stashed code spans are restored.
const SENT = String.fromCharCode(1); // control char: can't survive esc() input
function inline(text, imageUrl) {
  let out = esc(text);
  const stash = [];
  out = out.replace(/`([^`]+)`/g, (_, c) => {
    stash.push(`<code>${c}</code>`);
    return `${SENT}${stash.length - 1}${SENT}`;
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
    const m = /^dumpster:img:(.+)$/.exec(src);
    const url = m ? imageUrl?.(m[1]) : src;
    if (!url || !SAFE_SRC.test(url)) return esc(alt);
    return `<img src="${esc(url)}" alt="${alt}" data-entry="${m ? esc(m[1]) : ""}">`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) =>
    SAFE_HREF.test(href)
      ? `<a href="${esc(href)}" target="_blank" rel="noreferrer">${label}</a>`
      : label
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<em>$2</em>");
  out = out.replace(new RegExp(`${SENT}(\\d+)${SENT}`, "g"), (_, i) => stash[+i]);
  return out;
}

// Render a markdown string to HTML. `imageUrl(entryId)` resolves screenshot ids.
export function renderMarkdown(md, { imageUrl } = {}) {
  const lines = String(md || "").split(/\r?\n/);
  const out = [];
  let para = [];
  let list = null; // { ordered, items }
  let quote = [];
  let fence = null; // array of raw lines inside ```

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "), imageUrl)}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      out.push(`<${tag}>${list.items.map((i) => `<li>${inline(i, imageUrl)}</li>`).join("")}</${tag}>`);
    }
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${inline(quote.join(" "), imageUrl)}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const raw of lines) {
    if (fence) {
      if (/^```/.test(raw)) {
        out.push(`<pre><code>${esc(fence.join("\n"))}</code></pre>`);
        fence = null;
      } else fence.push(raw);
      continue;
    }
    const line = raw.trimEnd();
    if (/^```/.test(line)) {
      flushAll();
      fence = [];
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushAll();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2], imageUrl)}</h${lvl}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushAll();
      out.push("<hr>");
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      flushQuote();
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((ul || ol)[1]);
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      flushList();
      quote.push(q[1]);
      continue;
    }
    flushList();
    flushQuote();
    para.push(line.trim());
  }
  if (fence) out.push(`<pre><code>${esc(fence.join("\n"))}</code></pre>`);
  flushAll();
  return out.join("\n");
}

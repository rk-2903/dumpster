// YouTube transcript grabber for chrome.scripting.executeScript (same pattern
// as regionSelectOverlay): the whole function is serialized into the page, so
// it must stay fully self-contained — no imports, no outer references. It
// mirrors the dock's in-page scraper in src/selectionMenu.js (which is a
// classic content script and can't import this module).
//
// YouTube's caption endpoints (timedtext / get_transcript) demand a bot-guard
// "pot" token only the page's own player can mint, so the transcript is read
// the way a user would: open the "Show transcript" panel, scrape its segments,
// and close it again if we were the ones to open it.
//
// windowSec = 0 → full transcript; otherwise the last windowSec seconds up to
// the player's current time. Returns
//   { ok: true, text, sourceUrl, sourceTitle }  — text is "[m:ss] …" lines
//   { ok: false, error }
export async function ytGrabTranscript(windowSec) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let videoId = null;
    try {
      const u = new URL(location.href);
      videoId = u.searchParams.get("v");
      if (!videoId) {
        const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{6,})/);
        videoId = m ? m[1] : null;
      }
    } catch {}
    if (!videoId) return { ok: false, error: "Open a YouTube video first" };

    const PANEL = 'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]';
    // New UI renders transcript-segment-view-model; older UI used
    // ytd-transcript-segment-renderer — support both.
    const segEls = () =>
      document.querySelectorAll("transcript-segment-view-model, ytd-transcript-segment-renderer");

    const panel = document.querySelector(PANEL);
    const panelHidden =
      !panel || panel.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN";
    let opened = false;
    if (panelHidden || !segEls().length) {
      const btn =
        document.querySelector("ytd-video-description-transcript-section-renderer button") ||
        [...document.querySelectorAll("button")].find((b) =>
          /transcript/i.test(b.getAttribute("aria-label") || "")
        );
      if (!btn) return { ok: false, error: "No transcript on this video" };
      btn.click();
      opened = true;
      for (let i = 0; i < 40 && !segEls().length; i++) await sleep(150);
    }

    const toSec = (s) => {
      const p = String(s).split(":").map(Number);
      if (p.some(Number.isNaN)) return null;
      return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    };
    const cues = [];
    for (const el of segEls()) {
      const tEl = el.querySelector(
        '[class*="Timestamp"]:not([class*="A11y" i]), .segment-timestamp'
      );
      const xEl = el.querySelector('[role="text"], .segment-text');
      const t = tEl ? toSec(tEl.textContent.trim()) : null;
      const text = xEl ? xEl.textContent.replace(/\s+/g, " ").trim() : "";
      if (t != null && text) cues.push({ t, text });
    }
    if (opened) document.querySelector(PANEL + " #visibility-button button")?.click();
    if (!cues.length) return { ok: false, error: "No transcript on this video" };

    let picked = cues;
    let startSec = 0;
    if (windowSec) {
      const video = document.querySelector("video");
      const now = video ? video.currentTime : 0;
      picked = cues.filter((c) => c.t >= now - windowSec && c.t <= now);
      if (!picked.length) return { ok: false, error: `Nothing said in the last ${windowSec}s` };
      startSec = Math.floor(picked[0].t);
    }

    const fmtTime = (sec) => {
      sec = Math.max(0, Math.floor(sec));
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = String(sec % 60).padStart(2, "0");
      return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
    };
    // Merge consecutive cues into readable [m:ss]-stamped lines; one line
    // becomes one bullet in the doc.
    const blocks = [];
    let cur = null;
    for (const c of picked) {
      if (!cur || c.t - cur.start >= 12 || cur.text.length + c.text.length > 280) {
        cur = { start: c.t, text: c.text };
        blocks.push(cur);
      } else {
        cur.text += " " + c.text;
      }
    }
    return {
      ok: true,
      text: blocks.map((b) => `[${fmtTime(b.start)}] ${b.text}`).join("\n"),
      sourceUrl:
        "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId) + "&t=" + startSec + "s",
      sourceTitle: document.title.replace(/ - YouTube$/, ""),
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

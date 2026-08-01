// Anonymous, opt-out usage telemetry.
//
// Design goals:
// - Off the critical path: track() only touches chrome.storage and never
//   throws into callers; flush() swallows network errors. A capture/dump never
//   waits on telemetry.
// - Durable: events are queued in chrome.storage and flushed in batches, so a
//   sleeping service worker or an offline moment doesn't lose them (the
//   periodic sync alarm also calls flush()).
// - Anonymous: a random client id, event name, a few whitelisted props, the
//   extension version and locale. Never dump content, URLs, or Google data.
//
// Opt-out: on by default; disabled when `telemetryEnabled` is set to false.

const INGEST_URL = "https://znerazqhztkqperaqgaw.supabase.co/functions/v1/ingest";
const UNINSTALL_URL = "https://znerazqhztkqperaqgaw.supabase.co/functions/v1/uninstall";
// Publishable anon key (ships in the extension, like the OAuth client id). The
// events table is RLS-locked, so this key can't read or write it directly.
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpuZXJhenFoenRrcXBlcmFxZ2F3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwMjY0MzksImV4cCI6MjEwMDYwMjQzOX0.rUEVL1yeqUmBR2armVKRVusuipkB5uyW4y8F2WAVQfA";

const ALLOWED = new Set(["install", "update", "uninstall", "active", "feature", "error"]);
const ALLOWED_PROP_KEYS = new Set(["name", "code", "from", "to"]);

const CLIENT_KEY = "telemetryClientId";
const ENABLED_KEY = "telemetryEnabled";
const QUEUE_KEY = "telemetryQueue";
const LAST_ACTIVE_KEY = "telemetryLastActive";

const MAX_QUEUE = 200; // cap so a long offline stretch can't grow unbounded
const BATCH_TRIGGER = 10; // flush eagerly once this many are queued
const BATCH_SIZE = 50; // max events per POST (matches the edge function cap)
const DEBOUNCE_MS = 4000;

// Injectable seams so tests can stub storage/fetch without a real browser.
let store = chromeStore();
let fetchImpl = (...a) => globalThis.fetch(...a);

function chromeStore() {
  return {
    get: (keys) => new Promise((r) => chrome.storage.local.get(keys, r)),
    set: (obj) => new Promise((r) => chrome.storage.local.set(obj, r)),
  };
}

// Test hook.
export function __setDeps({ store: s, fetch: f } = {}) {
  if (s) store = s;
  if (f) fetchImpl = f;
}

function manifestVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "";
  }
}

function uiLocale() {
  try {
    return (chrome.i18n?.getUILanguage?.() || "").slice(0, 10);
  } catch {
    return "";
  }
}

async function clientId() {
  const o = await store.get(CLIENT_KEY);
  let id = o[CLIENT_KEY];
  if (!id) {
    id = crypto.randomUUID();
    await store.set({ [CLIENT_KEY]: id });
  }
  return id;
}

async function enabled() {
  const o = await store.get(ENABLED_KEY);
  return o[ENABLED_KEY] !== false; // default on (opt-out)
}

function cleanProps(props) {
  const out = {};
  if (props && typeof props === "object") {
    for (const k of Object.keys(props)) {
      if (!ALLOWED_PROP_KEYS.has(k)) continue;
      const v = props[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = String(v);
      else if (typeof v === "string" && v) out[k] = v.slice(0, 64);
    }
  }
  return out;
}

// Record an event. Safe to call and forget — never throws.
export async function track(event, props) {
  try {
    if (!ALLOWED.has(event)) return;
    if (!(await enabled())) return;
    const o = await store.get(QUEUE_KEY);
    const q = Array.isArray(o[QUEUE_KEY]) ? o[QUEUE_KEY] : [];
    q.push({ event, props: cleanProps(props) });
    while (q.length > MAX_QUEUE) q.shift(); // drop oldest on overflow
    await store.set({ [QUEUE_KEY]: q });
    if (q.length >= BATCH_TRIGGER) flush();
    else scheduleFlush();
  } catch {
    /* telemetry must never break the app */
  }
}

let debounceTimer = null;
function scheduleFlush() {
  try {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => flush(), DEBOUNCE_MS);
  } catch {
    /* setTimeout unavailable — the sync alarm will flush */
  }
}

let flushing = false;
// Send queued events. Keeps the queue on any failure so the next trigger (or
// the periodic alarm) retries. Never throws.
export async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    if (!(await enabled())) {
      await store.set({ [QUEUE_KEY]: [] }); // opted out — discard anything queued
      return;
    }
    const o = await store.get(QUEUE_KEY);
    const q = Array.isArray(o[QUEUE_KEY]) ? o[QUEUE_KEY] : [];
    if (!q.length) return;
    const batch = q.slice(0, BATCH_SIZE);
    const body = {
      client_id: await clientId(),
      ext_version: manifestVersion(),
      locale: uiLocale(),
      events: batch.map((e) => ({ event: e.event, props: e.props || {} })),
    };
    const res = await fetchImpl(INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!res || !res.ok) return; // keep the queue; retry later
    const rest = q.slice(batch.length);
    await store.set({ [QUEUE_KEY]: rest });
    if (rest.length) scheduleFlush(); // more to send
  } catch {
    /* offline / transient — keep the queue for the next attempt */
  } finally {
    flushing = false;
  }
}

// At most one `active` event per calendar day, for weekly-active + retention.
export async function pingActive() {
  try {
    if (!(await enabled())) return;
    const today = new Date().toISOString().slice(0, 10);
    const o = await store.get(LAST_ACTIVE_KEY);
    if (o[LAST_ACTIVE_KEY] === today) return;
    await store.set({ [LAST_ACTIVE_KEY]: today });
    await track("active");
  } catch {
    /* ignore */
  }
}

// Point chrome's uninstall URL at the uninstall function (with the anonymous
// client id), or clear it when the user has opted out.
export async function initUninstallUrl() {
  try {
    if (!chrome.runtime.setUninstallURL) return;
    if (!(await enabled())) {
      chrome.runtime.setUninstallURL("");
      return;
    }
    const id = await clientId();
    const v = encodeURIComponent(manifestVersion());
    chrome.runtime.setUninstallURL(`${UNINSTALL_URL}?c=${id}&v=${v}`);
  } catch {
    /* ignore */
  }
}

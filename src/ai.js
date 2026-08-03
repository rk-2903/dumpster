// Bring-your-own AI provider layer. Two ways to connect, chosen by the user:
//
//   • Google Gemini — students commonly have a free API key
//     (https://aistudio.google.com/apikey). Calls go DIRECTLY from the
//     extension to Google's API with the user's own key; nothing passes
//     through any developer server.
//   • Ollama — a local model on the user's machine (https://ollama.com).
//     Fully offline/private. Note: Ollama validates the Origin header, so
//     extension calls need `OLLAMA_ORIGINS=chrome-extension://*` (surfaced in
//     the settings UI and connection errors).
//
// Keys/URLs live in chrome.storage.local only. Deps are injected for tests.

const SETTINGS_KEY = "aiSettings";

export const AI_DEFAULTS = {
  provider: "", // "" (not set up) | "gemini" | "ollama" | "openai" | "anthropic"
  geminiKey: "",
  geminiModel: "gemini-2.5-flash",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "",
  openaiKey: "",
  openaiModel: "gpt-4o-mini",
  anthropicKey: "",
  anthropicModel: "claude-sonnet-5",
};

const chromeStore = {
  get: (key) => new Promise((r) => chrome.storage.local.get(key, (o) => r(o[key]))),
  set: (key, value) => new Promise((r) => chrome.storage.local.set({ [key]: value }, r)),
};

let deps = { fetchImpl: (...a) => globalThis.fetch(...a), store: chromeStore };
export function __setDeps(d) {
  deps = { ...deps, ...d };
}

export async function getAi() {
  const saved = (await deps.store.get(SETTINGS_KEY)) || {};
  return { ...AI_DEFAULTS, ...saved };
}

export async function setAi(patch) {
  const next = { ...(await getAi()), ...patch };
  await deps.store.set(SETTINGS_KEY, next);
  return next;
}

export function aiReady(s) {
  if (s.provider === "gemini") return Boolean(s.geminiKey && s.geminiModel);
  if (s.provider === "ollama") return Boolean(s.ollamaUrl && s.ollamaModel);
  if (s.provider === "openai") return Boolean(s.openaiKey && s.openaiModel);
  if (s.provider === "anthropic") return Boolean(s.anthropicKey && s.anthropicModel);
  return false;
}

const trimSlash = (u) => String(u || "").replace(/\/+$/, "");
// Gemini ids are sometimes written "models/gemini-2.5-flash"; the REST path
// already includes /models/, so normalise at the boundary.
const modelId = (m) => String(m || "").trim().replace(/^models\//, "");

// Ollama is meant to be YOUR machine. Anything else would ship note text to a
// third party under a "nothing leaves your computer" promise, so the settings
// UI refuses non-local hosts.
const LOCAL_HOST = /^(localhost|127(\.\d+){3}|\[?::1\]?|0\.0\.0\.0|.+\.local|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2})$/i;
export function checkOllamaUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return { ok: false, error: "That doesn't look like a URL — try http://localhost:11434" };
  }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: "Ollama URL must start with http:// or https://" };
  if (!u.hostname || u.hostname.includes("*")) return { ok: false, error: "Enter a real host, e.g. http://localhost:11434" };
  if (!LOCAL_HOST.test(u.hostname)) {
    return {
      ok: false,
      error: `"${u.hostname}" isn't on your machine or local network — your notes would be sent there. Use localhost or a private address.`,
    };
  }
  return { ok: true, url: `${u.protocol}//${u.host}`, originPattern: `${u.protocol}//${u.hostname}/*` };
}

// Friendly connection check. For Ollama also returns the locally available
// models so the settings UI can offer a picker.
export async function testAi(s) {
  try {
    if (s.provider === "gemini") {
      if (!s.geminiKey) return { ok: false, error: "Enter your Gemini API key" };
      // Validate the model too, so Test can't say "Connected" and then have
      // every action 404 on a mistyped model name.
      const res = await deps.fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          modelId(s.geminiModel) || "gemini-2.5-flash"
        )}?key=${encodeURIComponent(s.geminiKey)}`
      );
      if (!res.ok) return { ok: false, error: await geminiError(res) };
      return { ok: true };
    }
    if (s.provider === "ollama") {
      const check = checkOllamaUrl(s.ollamaUrl);
      if (!check.ok) return check;
      const base = trimSlash(s.ollamaUrl);
      const res = await deps.fetchImpl(`${base}/api/tags`);
      if (res.status === 403) return { ok: false, error: OLLAMA_UNREACHABLE };
      if (!res.ok) return { ok: false, error: `Ollama answered ${res.status} — check the URL` };
      const data = await res.json();
      const models = (data.models || []).map((m) => m.name);
      if (!models.length) return { ok: false, error: "Ollama is running but has no models — try `ollama pull llama3.2`" };
      // A plain GET can sail past Ollama's origin check (Chrome omits Origin on
      // simple requests), so /api/tags alone would report "Connected" while
      // every real action still 403s. Probe the same shape the actions use — a
      // JSON POST, which does carry Origin — before claiming success.
      const probe = await deps.fetchImpl(`${base}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: s.ollamaModel || models[0] }),
      });
      if (probe.status === 403) return { ok: false, error: OLLAMA_UNREACHABLE, models };
      if (!probe.ok && probe.status !== 404) {
        return { ok: false, error: `Ollama answered ${probe.status} — check the server`, models };
      }
      return { ok: true, models };
    }
    if (s.provider === "openai") {
      if (!s.openaiKey) return { ok: false, error: "Enter your OpenAI API key" };
      const res = await deps.fetchImpl("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${s.openaiKey}` },
      });
      if (!res.ok) return { ok: false, error: await keyApiError(res, "OpenAI", "platform.openai.com/api-keys") };
      return { ok: true };
    }
    if (s.provider === "anthropic") {
      if (!s.anthropicKey) return { ok: false, error: "Enter your Anthropic API key" };
      const res = await deps.fetchImpl("https://api.anthropic.com/v1/models", {
        headers: anthropicHeaders(s.anthropicKey),
      });
      if (!res.ok) return { ok: false, error: await keyApiError(res, "Anthropic", "console.anthropic.com/settings/keys") };
      return { ok: true };
    }
    return { ok: false, error: "Pick a provider first" };
  } catch {
    return { ok: false, error: unreachable(s.provider) };
  }
}

const PROVIDER_LABEL = { gemini: "Gemini", ollama: "Ollama", openai: "OpenAI", anthropic: "Anthropic" };
const unreachable = (p) =>
  p === "ollama" ? OLLAMA_UNREACHABLE : `Couldn't reach the ${PROVIDER_LABEL[p] || "AI"} API — check your connection`;

// Anthropic blocks browser-origin calls unless this opt-in header is sent.
const anthropicHeaders = (key) => ({
  "x-api-key": key,
  "anthropic-version": "2023-06-01",
  "anthropic-dangerous-direct-browser-access": "true",
  "Content-Type": "application/json",
});

const OLLAMA_UNREACHABLE =
  "Ollama is blocking this extension. Quit it, then run: OLLAMA_ORIGINS='chrome-extension://*' ollama serve — " +
  "a server that's already running won't pick the setting up until it restarts.";

// Shared mapping for the two bearer/key API providers.
async function keyApiError(res, label, keyUrl) {
  const body = await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403)
    return `${label} rejected that API key — paste it again from ${keyUrl}`;
  if (res.status === 429) return `${label} rate limit or credit limit hit — wait a moment, or check your billing`;
  if (res.status === 404 || /model/i.test(body.slice(0, 200)))
    return `${label} doesn't recognise that model name — check it on ${keyUrl}`;
  if (res.status >= 500) return `${label} is having trouble (${res.status}) — try again shortly`;
  return `${label} error ${res.status}: ${body.slice(0, 140)}`;
}

async function geminiError(res) {
  const body = await res.text().catch(() => "");
  if (res.status === 429) return "Gemini quota hit (free tier) — wait a minute and try again";
  if (res.status === 400 || res.status === 403) {
    if (/API_KEY_INVALID|API key not valid/i.test(body)) return "That Gemini API key isn't valid — paste it again from aistudio.google.com/apikey";
    return `Gemini rejected the request (${res.status}): ${body.slice(0, 140)}`;
  }
  if (res.status === 404) return "That Gemini model name wasn't found — try gemini-2.5-flash";
  return `Gemini error ${res.status}: ${body.slice(0, 140)}`;
}

// Pull a JSON payload out of a model reply that may be fenced or chatty.
export function extractJson(text) {
  const t = String(text || "").trim();
  const unfenced = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {}
  const start = unfenced.search(/[[{]/);
  if (start === -1) throw new Error("The model didn't return JSON");
  const open = unfenced[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < unfenced.length; i++) {
    const c = unfenced[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (!depth) return JSON.parse(unfenced.slice(start, i + 1));
    }
  }
  throw new Error("The model didn't return JSON");
}

// One completion. json=true asks the provider for strict JSON output and
// parses it (with a lenient fallback). Throws Error with a user-facing message.
export async function aiComplete({ system = "", prompt, json = false }) {
  const s = await getAi();
  if (!aiReady(s)) throw new Error("Set up AI first — pick a provider in AI settings");

  if (s.provider === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      modelId(s.geminiModel)
    )}:generateContent?key=${encodeURIComponent(s.geminiKey)}`;
    let res;
    try {
      res = await deps.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(system ? { system_instruction: { parts: [{ text: system }] } } : {}),
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            ...(json ? { response_mime_type: "application/json" } : {}),
          },
        }),
      });
    } catch {
      throw new Error("Couldn't reach the Gemini API — check your connection");
    }
    if (!res.ok) throw new Error(await geminiError(res));
    const data = await res.json();
    // A blocked prompt or a truncated/filtered candidate comes back 200 with
    // no text — say which it was instead of a generic "empty reply".
    const blocked = data.promptFeedback?.blockReason;
    if (blocked) throw new Error(`Gemini blocked this request (${blocked}) — try trimming the notes`);
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
    if (!text) {
      const fin = cand?.finishReason;
      if (fin === "MAX_TOKENS") throw new Error("Gemini hit its output limit — summarize a shorter section");
      if (fin === "SAFETY" || fin === "PROHIBITED_CONTENT")
        throw new Error("Gemini's safety filter blocked this reply — try rephrasing or a different section");
      if (fin === "RECITATION") throw new Error("Gemini stopped (recitation filter) — try rephrasing");
      throw new Error("Gemini returned an empty reply — try again");
    }
    return json ? extractJson(text) : text.trim();
  }

  if (s.provider === "ollama") {
    let res;
    try {
      res = await deps.fetchImpl(`${trimSlash(s.ollamaUrl)}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: s.ollamaModel,
          stream: false,
          ...(json ? { format: "json" } : {}),
          options: { temperature: 0.3 },
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: prompt },
          ],
        }),
      });
    } catch {
      throw new Error(OLLAMA_UNREACHABLE);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 403) throw new Error(OLLAMA_UNREACHABLE);
      if (res.status === 404 && /model/i.test(body)) throw new Error(`Ollama doesn't have "${s.ollamaModel}" — run \`ollama pull ${s.ollamaModel}\``);
      throw new Error(`Ollama error ${res.status}: ${body.slice(0, 140)}`);
    }
    const data = await res.json();
    const text = data.message?.content || "";
    if (!text) throw new Error("Ollama returned an empty reply — try again");
    return json ? extractJson(text) : text.trim();
  }

  if (s.provider === "openai") {
    let res;
    try {
      res = await deps.fetchImpl("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${s.openaiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: String(s.openaiModel).trim(),
          temperature: 0.3,
          ...(json ? { response_format: { type: "json_object" } } : {}),
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: prompt },
          ],
        }),
      });
    } catch {
      throw new Error(unreachable("openai"));
    }
    if (!res.ok) throw new Error(await keyApiError(res, "OpenAI", "platform.openai.com/api-keys"));
    const data = await res.json();
    const choice = data.choices?.[0];
    const text = choice?.message?.content || "";
    if (!text) {
      if (choice?.finish_reason === "length")
        throw new Error("OpenAI hit its output limit — summarize a shorter section");
      if (choice?.finish_reason === "content_filter")
        throw new Error("OpenAI's content filter blocked this reply — try rephrasing");
      throw new Error("OpenAI returned an empty reply — try again");
    }
    return json ? extractJson(text) : text.trim();
  }

  if (s.provider === "anthropic") {
    let res;
    try {
      res = await deps.fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: anthropicHeaders(s.anthropicKey),
        body: JSON.stringify({
          model: String(s.anthropicModel).trim(),
          max_tokens: 4096, // required by the API
          temperature: 0.3,
          ...(system ? { system } : {}),
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch {
      throw new Error(unreachable("anthropic"));
    }
    if (!res.ok) throw new Error(await keyApiError(res, "Anthropic", "console.anthropic.com/settings/keys"));
    const data = await res.json();
    const text = (data.content || [])
      .filter((p) => p.type === "text")
      .map((p) => p.text || "")
      .join("");
    if (!text) {
      if (data.stop_reason === "max_tokens")
        throw new Error("Anthropic hit its output limit — summarize a shorter section");
      throw new Error("Anthropic returned an empty reply — try again");
    }
    return json ? extractJson(text) : text.trim();
  }

  throw new Error("Set up AI first — pick a provider in AI settings");
}

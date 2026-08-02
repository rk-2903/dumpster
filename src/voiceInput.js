// Voice input via the browser's built-in Web Speech API — free, no keys, and
// ~100 languages through BCP-47 `lang` tags. Chrome performs the recognition
// on Google's speech servers, so it needs network; nothing is recorded or
// stored by the extension (disclosed in docs/PRIVACY.md).
//
// createVoiceInput returns { start, stop, active }. Recognition runs
// continuously with interim results: onInterim gets the in-flight guess for
// live display, onFinal gets each finished phrase for insertion. Chrome ends
// continuous sessions on silence — while the user hasn't pressed stop, onend
// restarts the recognizer so dictation survives pauses.

const ERRORS = {
  "not-allowed": "needs-grant",
  "service-not-allowed": "needs-grant",
  "audio-capture": "No microphone found",
  network: "Speech service unreachable — check your connection",
  "language-not-supported": "That language isn't supported for dictation",
};

export function voiceSupported() {
  return Boolean(globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition);
}

export function createVoiceInput({ getLang, onFinal, onInterim, onState, onError }) {
  let rec = null;
  let running = false; // user intent: mic button is on

  function build() {
    const Ctor = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = getLang();
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = (res[0]?.transcript || "").trim();
        if (!text) continue;
        if (res.isFinal) onFinal?.(text);
        else interim += (interim ? " " : "") + text;
      }
      onInterim?.(interim);
    };
    r.onerror = (e) => {
      // no-speech just means a quiet stretch; onend will restart us.
      if (e.error === "no-speech" || e.error === "aborted") return;
      running = false;
      onError?.(ERRORS[e.error] || `Dictation failed (${e.error})`, e.error);
    };
    r.onend = () => {
      if (!running) {
        onState?.(false);
        onInterim?.("");
        return;
      }
      // Chrome times continuous sessions out on silence — resume quietly.
      try {
        r.lang = getLang();
        r.start();
      } catch {
        running = false;
        onState?.(false);
      }
    };
    return r;
  }

  return {
    start() {
      if (running) return;
      running = true;
      rec = build();
      try {
        rec.start();
        onState?.(true);
      } catch (err) {
        running = false;
        onError?.(String(err?.message || err));
      }
    },
    stop() {
      running = false;
      try {
        rec?.stop();
      } catch {}
      onState?.(false);
      onInterim?.("");
    },
    get active() {
      return running;
    },
  };
}

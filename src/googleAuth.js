// Thin wrapper around chrome.identity.getAuthToken. Chrome caches and refreshes the
// token against the signed-in profile, so callers just ask for a token each time.
// Scope + client_id come from manifest.json's "oauth2" block.

// Get a token. interactive:true shows the consent/account picker (use on Connect);
// interactive:false returns a cached token silently or fails (use for background sync).
export function getToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "no token"));
      } else {
        resolve(token);
      }
    });
  });
}

export async function connect() {
  const token = await getToken(true);
  const email = await fetchEmail(token);
  await setConnection({ connected: true, email });
  return { email };
}

export async function disconnect() {
  try {
    const token = await getToken(false).catch(() => null);
    if (token) {
      // Drop Chrome's cache and revoke server-side so re-connect re-prompts cleanly.
      await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
      await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: "POST" }).catch(() => {});
    }
  } finally {
    await setConnection({ connected: false, email: "" });
  }
}

async function fetchEmail(token) {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return (await res.json()).email || "";
  } catch {
    /* non-fatal */
  }
  return "";
}

// Connection state (not the token — Chrome owns that) lives in chrome.storage so
// every context can show connected status.
export function getConnection() {
  return new Promise((r) =>
    chrome.storage.local.get("gconnection", (o) => r(o.gconnection || { connected: false, email: "" }))
  );
}
function setConnection(v) {
  return new Promise((r) => chrome.storage.local.set({ gconnection: v }, r));
}

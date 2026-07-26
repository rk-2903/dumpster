// Dumpster telemetry — uninstall Edge Function.
//
// Target of chrome.runtime.setUninstallURL: Chrome opens this URL in a tab when
// the user removes the extension. We log one anonymous `uninstall` row and show
// a small thank-you page. The browser can't send an auth header here, so deploy
// this function with verify_jwt = false (see supabase/config.toml).
//
// Deploy: supabase functions deploy uninstall --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dumpster — uninstalled</title>
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:#0f1420;color:#e5e9f0}
  .card{max-width:420px;padding:32px;text-align:center}
  .mark{width:44px;height:44px;border-radius:12px;background:#10b981;margin:0 auto 18px;
    box-shadow:inset 0 0 0 4px rgba(255,255,255,.25)}
  a{color:#10b981}
</style></head>
<body><div class="card">
  <div class="mark"></div>
  <h1>Dumpster is uninstalled</h1>
  <p>Thanks for trying it. If something didn't work for you, we'd genuinely like
     to know — feedback goes a long way.</p>
  <p><a href="https://github.com/rk-2903/dumpster/issues">Leave feedback ↗</a></p>
</div></body></html>`;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const clientId = url.searchParams.get("c") || "";
  const version = (url.searchParams.get("v") || "").slice(0, 32);

  if (UUID_RE.test(clientId)) {
    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      await supabase.from("events").insert({
        client_id: clientId,
        event: "uninstall",
        props: {},
        ext_version: version || null,
      });
    } catch (e) {
      console.error("uninstall log failed:", (e as Error).message);
    }
  }

  return new Response(PAGE, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});

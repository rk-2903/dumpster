// Dumpster telemetry — ingest Edge Function.
//
// Accepts a small anonymous batch from the extension and inserts it into
// `public.events` using the service role (bypassing RLS). Every field is
// validated and whitelisted here; anything unexpected is dropped, so a caller
// holding the public anon key still can't write arbitrary data.
//
// Deploy: supabase functions deploy ingest
// (verify_jwt stays true — the extension sends the anon key as a bearer token.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_EVENTS = new Set([
  "install",
  "update",
  "uninstall",
  "active",
  "feature",
  "error",
]);
// Only these prop keys are stored, each coerced to a short string.
const ALLOWED_PROP_KEYS = new Set(["name", "code", "from", "to"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function short(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : undefined;
  if (typeof v === "string") return v.slice(0, 64);
  return undefined;
}

function cleanProps(props: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (props && typeof props === "object") {
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      if (!ALLOWED_PROP_KEYS.has(k)) continue;
      const s = short(v);
      if (s !== undefined) out[k] = s;
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: CORS });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400, headers: CORS });
  }

  const clientId = String(body?.client_id || "");
  if (!UUID_RE.test(clientId)) {
    return new Response("Bad client_id", { status: 400, headers: CORS });
  }
  const extVersion = short(body?.ext_version) ?? null;
  const locale = short(body?.locale) ?? null;

  const rawEvents = Array.isArray(body?.events) ? body.events.slice(0, 50) : [];
  const rows = rawEvents
    .filter((e: any) => e && ALLOWED_EVENTS.has(e.event))
    .map((e: any) => ({
      client_id: clientId,
      event: e.event as string,
      props: cleanProps(e.props),
      ext_version: extVersion,
      locale,
    }));

  if (!rows.length) return new Response(null, { status: 204, headers: CORS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { error } = await supabase.from("events").insert(rows);
  if (error) {
    console.error("insert failed:", error.message);
    return new Response("insert failed", { status: 500, headers: CORS });
  }
  return new Response(null, { status: 204, headers: CORS });
});

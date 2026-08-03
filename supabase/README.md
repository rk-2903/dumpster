# IvyNotes telemetry backend (Supabase)

Anonymous, opt-out usage telemetry for the extension. You deploy this once to
your own Supabase project (`znerazqhztkqperaqgaw`); the extension then posts
tiny event batches to the `ingest` Edge Function.

**What's collected:** a random client id (a UUID, not tied to any account), an
event name, a few whitelisted props, the extension version, and the browser
locale. Never the content of your dumps, page URLs, or any Google data.

## Files

| Path | Role |
|------|------|
| `migrations/0001_events.sql` | `events` table (RLS locked, no anon access) + read views |
| `functions/ingest/` | Validates + inserts event batches (service role) |
| `functions/uninstall/` | Logs an uninstall + shows a thank-you page |
| `config.toml` | Marks both functions as `verify_jwt = false` (browser CORS) |

## Deploy (manual)

You need the [Supabase CLI](https://supabase.com/docs/guides/cli) and to be
logged in (`supabase login`).

```bash
# from the repo root
supabase link --project-ref znerazqhztkqperaqgaw

# 1) schema — run the migration (or paste it into the SQL editor)
supabase db push          # applies supabase/migrations/*.sql
# ...or: copy migrations/0001_events.sql into Dashboard → SQL editor → Run

# 2) edge functions — BOTH must skip JWT verification (see note below)
supabase functions deploy ingest --no-verify-jwt
supabase functions deploy uninstall --no-verify-jwt
```

> **Why `--no-verify-jwt`?** Both functions are called from a browser. With JWT
> verification on (the default), Supabase's gateway rejects the CORS **preflight
> `OPTIONS`** request — which carries no `Authorization` header — with a `401`,
> so the browser blocks the call with *"preflight … does not have HTTP ok
> status."* The anon key is public anyway; the real guards are the payload
> validation in `ingest` and the RLS-locked `events` table. (`config.toml` sets
> `verify_jwt = false` for both, so a CLI deploy picks it up even without the
> flag — but pass it explicitly to be safe.)

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into functions
automatically — you don't set any secrets.

## Smoke-test `ingest` before touching the extension

```bash
ANON="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpuZXJhenFoenRrcXBlcmFxZ2F3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwMjY0MzksImV4cCI6MjEwMDYwMjQzOX0.rUEVL1yeqUmBR2armVKRVusuipkB5uyW4y8F2WAVQfA"

curl -i -X POST \
  https://znerazqhztkqperaqgaw.supabase.co/functions/v1/ingest \
  -H "Content-Type: application/json" \
  -H "apikey: $ANON" \
  -H "Authorization: Bearer $ANON" \
  -d '{
    "client_id": "00000000-0000-4000-8000-000000000001",
    "ext_version": "0.2.0",
    "locale": "en-US",
    "events": [{ "event": "install" }, { "event": "feature", "props": { "name": "screenshot" } }]
  }'
# expect: HTTP/2 204
```

Then check it landed:

```sql
select event, props, ext_version, created_at from public.events order by id desc limit 5;
```

## Reading the numbers

```sql
select * from public.weekly_active;   -- distinct active clients, last 7 days
select * from public.active_by_week;  -- active clients per ISO week
select * from public.retention;       -- week-over-week retention %
select * from public.feature_usage;   -- which features get used
```

## Notes

- The **anon key is publishable** (it ships inside the extension, like the OAuth
  client id). The `events` table has RLS on with no policies and no anon grants,
  so that key can't read or write the table directly — only the `ingest`
  function (service role) can, and only validated rows.
- To wipe test data: `delete from public.events where ext_version = '0.2.0';`

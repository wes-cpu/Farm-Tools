# Commodity Futures Carry Monitor

Tracks the **percent of full carry** in corn (ZC), soybeans (ZS), and Chicago
wheat (ZW) futures — automatically, once a day.

## What it does

- Every day at **3:00 pm Central** (after grain settlement) a Supabase Edge
  Function fetches settlement prices for every listed contract month from
  Yahoo Finance.
- It computes the spread between each **consecutive pair** of contract months
  (Dec→Mar, Mar→May, May→Jul, …) and expresses it as a % of full carry:

  ```
  full carry (¢/bu) = days × ( storage ¢/day  +  front price × interest rate ÷ 365 )
  % of full carry   = spread ÷ full carry × 100
  ```

  where `days` = days between the two contracts' **first notice days**, and
  storage/interest are editable on the Settings screen.
- Each day's spread is saved to Postgres, so the web page charts history over
  time.
- A pair **stops being tracked when the front contract reaches first notice
  day** (last business day before the delivery month).
- You set **alert targets** per spread (e.g. "email me when Jul→Sep corn hits
  80% of full carry"). When one is hit you get an email with an urgent
  subject line (🚨). Frequency is per-alert: *once on hit* (re-arms if it
  falls back below) or *every day while above*. An optional daily/weekly
  digest emails all tracked spreads.

## Files

| File | Purpose |
|---|---|
| `../commodity-carry-monitor.html` | The mobile web app (dashboard, charts, alerts, settings) |
| `supabase/migrations/001_carry_schema.sql` | Database schema + RLS + seed data |
| `supabase/functions/carry-daily-update/index.ts` | Daily engine (fetch → calc → store → alert) |
| `supabase/schedule.sql` | pg_cron schedule (run once after deploy) |
| `deploy.sh` | CLI deploy script (`./deploy.sh <project-ref>`) |

## Deploy (one time, ~5 minutes)

Works in any existing Supabase project — every object is prefixed `carry_`.

**Dashboard route (no CLI needed):**

1. supabase.com → your project → **SQL Editor** → paste & run
   `supabase/migrations/001_carry_schema.sql`.
2. **Edge Functions** → *Deploy a new function* → name it
   `carry-daily-update` → paste `supabase/functions/carry-daily-update/index.ts`.
3. **SQL Editor** → paste `supabase/schedule.sql`, fill in your project ref and
   anon key, run it. (This schedules the daily 3 pm CT run.)
4. Open `commodity-carry-monitor.html` and replace the two placeholders at the
   top of the `<script>` block with your project URL and anon key
   (Settings → API in the Supabase dashboard).
5. Open the page → Settings → **Fetch prices & recalculate now** to load the
   first day of data.

**CLI route:** `./deploy.sh <project-ref>` then steps 3–4 above.

## Email alerts (Resend, ~2 minutes)

The tool sends email through [Resend](https://resend.com) (free tier: 100
emails/day — plenty).

1. Sign up at **resend.com** using **wes@seifert.farm** (alerts are sent from
   Resend's shared `onboarding@resend.dev` sender, which may only deliver to
   the account owner's own address — so sign up with the address you want
   alerts at).
2. Dashboard → **API Keys** → *Create API key* → copy the `re_…` value.
3. Open the Carry Monitor page → **Settings** → paste the key into *Resend API
   key* → **Save settings** → **Send test email**.

The key is stored **write-only**: the browser can set it but can never read it
back (`carry_secrets` has no anon read policy; only the edge function's
service role can read it).

If you later verify your own domain (seifert.farm) in Resend, change the
`from:` address in the edge function to remove the onboarding-sender
restriction.

## Notes & judgment calls

- **Data source** is Yahoo Finance's unofficial API (free, ~10-min delayed —
  irrelevant for end-of-day settlements). If Yahoo ever breaks, the run log
  shows the failure on the dashboard and you get a ⚠️ email.
- **First notice day** is computed as the last *weekday* of the month before
  delivery; exchange holidays aren't modeled, which can shift the cutoff by
  one day in rare cases.
- **Wheat storage**: CBOT wheat uses CME's seasonal **Variable Storage Rate**.
  The tool uses a flat ¢/bu/month you set per commodity — check the current
  VSR and update wheat's rate on the Settings screen when CME changes it.
- **Security model**: single-user tool. Market data is world-readable;
  settings/watches are writable by anyone holding the page's anon key (same
  model as the other Farm-Tools pages — don't share the page URL broadly).
  The Resend key is the only secret and is never exposed to the browser.
- Weekend/holiday runs are harmless: prices upsert on their trade date, so
  no duplicate history rows are created.

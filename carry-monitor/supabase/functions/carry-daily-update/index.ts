// ============================================================
// carry-daily-update — Commodity Futures Carry Monitor engine
//
// Runs once per day (pg_cron) and on demand from the web page.
//   1. Fetches settlement prices for every listed ZC/ZS/ZW
//      contract month from Yahoo Finance
//   2. Computes spread + % of full carry between consecutive
//      contract months (stops at the front month's first notice day)
//   3. Stores daily history
//   4. Evaluates user watch targets and sends urgent Resend emails
//   5. Optionally sends a daily/weekly digest
//
// Actions (POST or GET):
//   ?action=run         full daily run (default)
//   ?action=test-email  send a test email to the configured address
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MONTH_NUM: Record<string, number> = {
  F: 1, G: 2, H: 3, J: 4, K: 5, M: 6, N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12,
};
const MONTH_NAME: Record<string, string> = {
  F: "Jan", G: "Feb", H: "Mar", J: "Apr", K: "May", M: "Jun",
  N: "Jul", Q: "Aug", U: "Sep", V: "Oct", X: "Nov", Z: "Dec",
};

// ---------- tiny PostgREST helper (service role) ----------
async function db(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DB ${init.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
  }
  return res;
}
const dbGet = async <T>(path: string): Promise<T> => (await db(path)).json();
const dbWrite = (path: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
  db(path, { method, body: JSON.stringify(body), headers: { Prefer: "return=minimal", ...headers } });

// ---------- date helpers (all UTC-date based) ----------
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** First notice day: last business day of the month before the
 *  delivery month. (Exchange holidays are not modeled; if the last
 *  business day is a holiday the true FND is 1 day earlier, which
 *  only shifts the tracking cutoff by a day.) */
function firstNoticeDay(year: number, monthNum: number): Date {
  // day 0 of the delivery month = last calendar day of prior month
  const d = new Date(Date.UTC(year, monthNum - 1, 0));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d;
}

function contractLabel(commodityName: string, monthCode: string, year: number): string {
  return `${commodityName} ${MONTH_NAME[monthCode]} ${year}`;
}

// ---------- Yahoo Finance ----------
async function fetchYahooPrice(
  symbol: string,
): Promise<{ price: number; quoteDate: string } | null> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.CBT?interval=1d&range=5d`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Accept: "application/json",
        },
      });
      if (res.status === 404) return null; // contract not listed
      if (!res.ok) {
        if (attempt === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
        return null;
      }
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      const t = meta?.regularMarketTime;
      if (typeof price !== "number" || !t) return null;
      // regularMarketTime is unix seconds; grains settle during the
      // Chicago day, so the UTC date of the timestamp is the trade date.
      const quoteDate = isoDate(new Date(t * 1000));
      return { price, quoteDate };
    } catch (_e) {
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      return null;
    }
  }
  return null;
}

// ---------- NY Fed SOFR (market interest benchmark) ----------
/** Returns the 90-day average SOFR in percent from the NY Fed public
 *  API, or null on failure. CME's financial-full-carry convention is
 *  3-month SOFR + 200 bps on a 360-day count. */
async function fetchSofr90(): Promise<{ pct: number; date: string } | null> {
  try {
    const res = await fetch(
      "https://markets.newyorkfed.org/api/rates/secured/sofrai/last/1.json",
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const row = json?.refRates?.[0];
    const pct = Number(row?.average90day);
    if (!isFinite(pct) || pct <= 0) return null;
    return { pct, date: String(row?.effectiveDate ?? "") };
  } catch (_e) {
    return null;
  }
}

// ---------- Resend ----------
async function sendEmail(
  apiKey: string,
  to: string,
  subject: string,
  html: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Farm Tools Carry Monitor <onboarding@resend.dev>",
        to: [to],
        subject,
        html,
      }),
    });
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${await res.text()}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function emailShell(title: string, inner: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto">
  <div style="background:#1e5a3c;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0">
    <strong>🌾 Farm Tools — Carry Monitor</strong>
  </div>
  <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;padding:18px">
    <h2 style="margin:0 0 12px;font-size:17px;color:#1e293b">${title}</h2>
    ${inner}
    <p style="color:#94a3b8;font-size:12px;margin-top:18px">
      Sent automatically by your Commodity Carry Monitor. Adjust targets and
      email frequency on the tool's Alerts &amp; Settings screens.
    </p>
  </div></div>`;
}

function spreadTable(rows: SpreadRow[], watchMap?: Map<string, WatchRow>): string {
  const tr = rows.map((s) => {
    const w = watchMap?.get(s.front_symbol + "|" + s.back_symbol);
    const pct = s.pct_of_full_carry == null ? "—" : `${s.pct_of_full_carry.toFixed(1)}%`;
    return `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eef2f7">${s.label}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eef2f7;text-align:right">${s.spread_cents.toFixed(2)}¢</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eef2f7;text-align:right"><strong>${pct}</strong></td>
      <td style="padding:6px 8px;border-bottom:1px solid #eef2f7;text-align:right;color:#64748b">${w ? w.target_pct + "%" : ""}</td>
    </tr>`;
  }).join("");
  return `<table style="border-collapse:collapse;width:100%;font-size:13px">
    <tr style="color:#64748b;text-align:left">
      <th style="padding:6px 8px">Spread</th>
      <th style="padding:6px 8px;text-align:right">Value</th>
      <th style="padding:6px 8px;text-align:right">% Full Carry</th>
      <th style="padding:6px 8px;text-align:right">Target</th>
    </tr>${tr}</table>`;
}

// ---------- types ----------
interface Commodity {
  code: string;
  name: string;
  month_codes: string[];
  storage_cents_per_bu_month: number;      // legacy
  storage_cents_per_bu_day: number | null; // exchange premium charge
}
interface Settings {
  alert_email: string;
  interest_rate_pct: number;               // legacy fallback
  digest_frequency: "off" | "daily" | "weekly";
  interest_spread_bps: number;
  sofr_90d_pct: number | null;
  sofr_fetched_on: string | null;
}
interface WatchRow {
  id: number;
  commodity: string;
  front_symbol: string;
  back_symbol: string;
  target_pct: number;
  frequency: "once" | "daily";
  enabled: boolean;
  state: "below" | "above";
  last_alert_date: string | null;
}
interface ContractQuote {
  symbol: string;
  commodity: string;
  monthCode: string;
  year: number;
  fnd: Date;
  price: number;
  quoteDate: string;
}
interface SpreadRow {
  quote_date: string;
  commodity: string;
  front_symbol: string;
  back_symbol: string;
  front_price_cents: number;
  back_price_cents: number;
  spread_cents: number;
  days_between: number;
  storage_cents_month: number;   // legacy display (day rate × 365/12)
  storage_cents_day: number;     // exchange premium charge used
  interest_rate_pct: number;     // combined rate used (SOFR90 + spread)
  rate_note: string;
  full_carry_cents: number;
  pct_of_full_carry: number | null;
  front_fnd: string;
  label: string; // not stored — used for emails
}

// ---------- main run ----------
async function runDaily(): Promise<Record<string, unknown>> {
  const today = new Date();
  const todayIso = isoDate(today);

  const [commodities, settingsRows, secretRows] = await Promise.all([
    dbGet<Commodity[]>("carry_commodities?select=*"),
    dbGet<Settings[]>("carry_settings?select=*&id=eq.1"),
    dbGet<{ resend_api_key: string | null }[]>("carry_secrets?select=resend_api_key&id=eq.1"),
  ]);
  const settings = settingsRows[0];
  const resendKey = secretRows[0]?.resend_api_key ?? null;

  // ---- 0. market interest rate: 3-month SOFR (NY Fed) + 200 bps, act/360
  const sofr = await fetchSofr90();
  let sofrPct: number | null = sofr?.pct ?? settings.sofr_90d_pct;
  let rateNote: string;
  if (sofr) {
    rateNote = `SOFR90 ${sofr.pct.toFixed(2)}% + ${settings.interest_spread_bps}bp (NY Fed ${sofr.date})`;
    await dbWrite("carry_settings?id=eq.1", "PATCH", {
      sofr_90d_pct: sofr.pct, sofr_fetched_on: sofr.date,
    });
  } else if (sofrPct != null) {
    rateNote = `SOFR90 ${Number(sofrPct).toFixed(2)}% + ${settings.interest_spread_bps}bp (NY Fed fetch failed — using last known ${settings.sofr_fetched_on ?? "value"})`;
  } else {
    sofrPct = settings.interest_rate_pct - 2; // legacy fallback, first run only
    rateNote = `fallback rate ${settings.interest_rate_pct}% (SOFR unavailable)`;
  }
  const marketRatePct = Number(sofrPct) + settings.interest_spread_bps / 100;

  // ---- 1. enumerate + fetch contracts (FND in the future, ~3 yrs out)
  const horizon = new Date(today);
  horizon.setUTCFullYear(horizon.getUTCFullYear() + 3);

  const wanted: { symbol: string; commodity: Commodity; monthCode: string; year: number; fnd: Date }[] = [];
  for (const c of commodities) {
    for (let year = today.getUTCFullYear(); year <= horizon.getUTCFullYear(); year++) {
      for (const mc of c.month_codes) {
        const fnd = firstNoticeDay(year, MONTH_NUM[mc]);
        if (fnd <= today || fnd > horizon) continue;
        wanted.push({
          symbol: `${c.code}${mc}${String(year % 100).padStart(2, "0")}`,
          commodity: c, monthCode: mc, year, fnd,
        });
      }
    }
  }

  const quotes: ContractQuote[] = [];
  const missing: string[] = [];
  const BATCH = 6;
  for (let i = 0; i < wanted.length; i += BATCH) {
    const batch = wanted.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((w) => fetchYahooPrice(w.symbol)));
    results.forEach((r, j) => {
      const w = batch[j];
      if (r) {
        quotes.push({
          symbol: w.symbol, commodity: w.commodity.code, monthCode: w.monthCode,
          year: w.year, fnd: w.fnd, price: r.price, quoteDate: r.quoteDate,
        });
      } else missing.push(w.symbol);
    });
    if (i + BATCH < wanted.length) await new Promise((r) => setTimeout(r, 400));
  }

  if (quotes.length === 0) {
    const msg = `Fetched 0 of ${wanted.length} contracts from Yahoo Finance — source may be down or symbols changed.`;
    await dbWrite("carry_run_log", "POST", {
      ok: false, contracts_fetched: 0, spreads_computed: 0, alerts_sent: 0, message: msg,
    });
    if (resendKey && settings) {
      const r = await sendEmail(resendKey, settings.alert_email,
        "⚠️ Carry Monitor: data fetch failed",
        emailShell("Data fetch failed", `<p>${msg}</p>`));
      await dbWrite("carry_alert_log", "POST", {
        kind: "error", recipient: settings.alert_email,
        subject: "⚠️ Carry Monitor: data fetch failed",
        body_preview: msg, success: r.ok, error: r.error ?? null,
      });
    }
    return { ok: false, message: msg, missing };
  }

  // ---- 2. store prices (idempotent per quote_date+symbol)
  await dbWrite(
    "carry_prices?on_conflict=quote_date,symbol",
    "POST",
    quotes.map((q) => ({
      quote_date: q.quoteDate, symbol: q.symbol, commodity: q.commodity,
      month_code: q.monthCode, year: q.year, price_cents: q.price,
    })),
    { Prefer: "return=minimal,resolution=merge-duplicates" },
  );

  // ---- 3. spreads between consecutive months (per commodity)
  const spreads: SpreadRow[] = [];
  for (const c of commodities) {
    const list = quotes
      .filter((q) => q.commodity === c.code)
      .sort((a, b) => a.fnd.getTime() - b.fnd.getTime());
    for (let i = 0; i + 1 < list.length; i++) {
      const f = list[i], b = list[i + 1];
      if (f.quoteDate !== b.quoteDate) continue; // stale leg — skip pair
      const days = Math.round((b.fnd.getTime() - f.fnd.getTime()) / 86400000);
      if (days <= 0) continue;
      // CME convention: exchange premium charge ¢/day + price × (SOFR90+200bp)/360
      const storagePerDay = c.storage_cents_per_bu_day ?? (c.storage_cents_per_bu_month * 12 / 365);
      const interestPerDay = f.price * (marketRatePct / 100) / 360;
      const fullCarry = days * (storagePerDay + interestPerDay);
      const spread = b.price - f.price;
      spreads.push({
        quote_date: f.quoteDate,
        commodity: c.code,
        front_symbol: f.symbol,
        back_symbol: b.symbol,
        front_price_cents: f.price,
        back_price_cents: b.price,
        spread_cents: spread,
        days_between: days,
        storage_cents_month: storagePerDay * 365 / 12,
        storage_cents_day: storagePerDay,
        interest_rate_pct: marketRatePct,
        rate_note: rateNote,
        full_carry_cents: fullCarry,
        pct_of_full_carry: fullCarry > 0 ? (spread / fullCarry) * 100 : null,
        front_fnd: isoDate(f.fnd),
        label: `${c.name} ${MONTH_NAME[f.monthCode]} ${f.year} → ${MONTH_NAME[b.monthCode]} ${b.year}`,
      });
    }
  }

  if (spreads.length > 0) {
    await dbWrite(
      "carry_spreads?on_conflict=quote_date,front_symbol,back_symbol",
      "POST",
      spreads.map(({ label: _label, ...row }) => row),
      { Prefer: "return=minimal,resolution=merge-duplicates" },
    );
  }

  // ---- 4. evaluate watches
  let alertsSent = 0;
  const watches = await dbGet<WatchRow[]>("carry_watches?select=*&enabled=eq.true");
  const spreadByPair = new Map(spreads.map((s) => [s.front_symbol + "|" + s.back_symbol, s]));

  for (const w of watches) {
    const s = spreadByPair.get(w.front_symbol + "|" + w.back_symbol);

    if (!s) {
      // Front month reached first notice day (or pair vanished):
      // stop tracking this watch, per the delivery-cutoff rule.
      const fndPassed = quotes.every((q) => q.symbol !== w.front_symbol);
      if (fndPassed) {
        await dbWrite(`carry_watches?id=eq.${w.id}`, "PATCH", { enabled: false });
      }
      continue;
    }
    if (s.pct_of_full_carry == null) continue;

    const above = s.pct_of_full_carry >= w.target_pct;
    const shouldAlert = above && (
      (w.frequency === "once" && w.state === "below") ||
      (w.frequency === "daily" && w.last_alert_date !== s.quote_date)
    );

    if (shouldAlert) {
      const subject =
        `🚨 CARRY TARGET HIT: ${s.label} at ${s.pct_of_full_carry.toFixed(1)}% of full carry (target ${w.target_pct}%)`;
      const html = emailShell(
        `${s.label} reached ${s.pct_of_full_carry.toFixed(1)}% of full carry`,
        `<p style="font-size:14px;color:#1e293b">Your target of <strong>${w.target_pct}%</strong> was reached at the ${s.quote_date} close.</p>
         <table style="font-size:13px;border-collapse:collapse;width:100%">
           <tr><td style="padding:4px 8px;color:#64748b">Spread (back − front)</td><td style="padding:4px 8px;text-align:right"><strong>${s.spread_cents.toFixed(2)}¢/bu</strong></td></tr>
           <tr><td style="padding:4px 8px;color:#64748b">Full carry (${s.days_between} days)</td><td style="padding:4px 8px;text-align:right">${s.full_carry_cents.toFixed(2)}¢/bu</td></tr>
           <tr><td style="padding:4px 8px;color:#64748b">Front (${s.front_symbol})</td><td style="padding:4px 8px;text-align:right">${s.front_price_cents.toFixed(2)}¢</td></tr>
           <tr><td style="padding:4px 8px;color:#64748b">Back (${s.back_symbol})</td><td style="padding:4px 8px;text-align:right">${s.back_price_cents.toFixed(2)}¢</td></tr>
           <tr><td style="padding:4px 8px;color:#64748b">Market inputs (CME convention)</td><td style="padding:4px 8px;text-align:right">${s.storage_cents_day.toFixed(3)}¢/bu/day exchange storage · ${s.interest_rate_pct.toFixed(2)}% (${s.rate_note})</td></tr>
           <tr><td style="padding:4px 8px;color:#64748b">Tracking stops (front FND)</td><td style="padding:4px 8px;text-align:right">${s.front_fnd}</td></tr>
         </table>`,
      );
      let ok = false, err: string | undefined;
      if (resendKey) {
        const r = await sendEmail(resendKey, settings.alert_email, subject, html);
        ok = r.ok; err = r.error;
      } else {
        err = "No Resend API key configured — set it on the Settings screen.";
      }
      await dbWrite("carry_alert_log", "POST", {
        watch_id: w.id, kind: "target", recipient: settings.alert_email,
        subject, body_preview: `${s.label} ${s.pct_of_full_carry.toFixed(1)}% >= ${w.target_pct}%`,
        success: ok, error: err ?? null,
      });
      if (ok) alertsSent++;
    }

    await dbWrite(`carry_watches?id=eq.${w.id}`, "PATCH", {
      state: above ? "above" : "below",
      ...(shouldAlert ? { last_alert_date: s.quote_date } : {}),
    });
  }

  // ---- 5. digest
  if (settings.digest_frequency !== "off" && resendKey && spreads.length > 0) {
    const isMonday = today.getUTCDay() === 1;
    const due = settings.digest_frequency === "daily" || (settings.digest_frequency === "weekly" && isMonday);
    if (due) {
      const sentToday = await dbGet<{ id: number }[]>(
        `carry_alert_log?select=id&kind=eq.digest&success=eq.true&sent_at=gte.${todayIso}T00:00:00Z&limit=1`,
      );
      if (sentToday.length === 0) {
        const watchMap = new Map(watches.map((w) => [w.front_symbol + "|" + w.back_symbol, w]));
        const subject = `🌾 Carry digest ${spreads[0].quote_date}: ${spreads.length} spreads tracked`;
        const r = await sendEmail(resendKey, settings.alert_email, subject,
          emailShell(`Market carry — ${spreads[0].quote_date} close`, spreadTable(spreads, watchMap)));
        await dbWrite("carry_alert_log", "POST", {
          kind: "digest", recipient: settings.alert_email, subject,
          body_preview: `${spreads.length} spreads`, success: r.ok, error: r.error ?? null,
        });
        if (r.ok) alertsSent++;
      }
    }
  }

  const message =
    `Fetched ${quotes.length}/${wanted.length} contracts, ${spreads.length} spreads, ${alertsSent} emails.` +
    (missing.length ? ` Not listed on Yahoo: ${missing.join(", ")}` : "");
  await dbWrite("carry_run_log", "POST", {
    ok: true, contracts_fetched: quotes.length, spreads_computed: spreads.length,
    alerts_sent: alertsSent, message,
  });
  return { ok: true, contracts: quotes.length, spreads: spreads.length, alerts: alertsSent, missing };
}

// ---------- test email ----------
async function testEmail(): Promise<Record<string, unknown>> {
  const [settingsRows, secretRows] = await Promise.all([
    dbGet<Settings[]>("carry_settings?select=*&id=eq.1"),
    dbGet<{ resend_api_key: string | null }[]>("carry_secrets?select=resend_api_key&id=eq.1"),
  ]);
  const settings = settingsRows[0];
  const key = secretRows[0]?.resend_api_key;
  if (!key) return { ok: false, error: "No Resend API key configured yet." };
  const r = await sendEmail(key, settings.alert_email,
    "✅ Carry Monitor test email",
    emailShell("Email delivery works!",
      `<p>Alerts will be sent to <strong>${settings.alert_email}</strong> when a watched spread hits its % of full carry target.</p>`));
  await dbWrite("carry_alert_log", "POST", {
    kind: "test", recipient: settings.alert_email, subject: "✅ Carry Monitor test email",
    body_preview: "test", success: r.ok, error: r.error ?? null,
  });
  return { ok: r.ok, error: r.error };
}

// ---------- HTTP entry ----------
Deno.serve(async (req: Request) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const action = new URL(req.url).searchParams.get("action") ?? "run";
  try {
    const result = action === "test-email" ? await testEmail() : await runDaily();
    return new Response(JSON.stringify(result), { headers: cors });
  } catch (e) {
    try {
      await dbWrite("carry_run_log", "POST", {
        ok: false, message: `Unhandled error: ${String(e)}`,
      });
    } catch (_) { /* ignore */ }
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: cors,
    });
  }
});

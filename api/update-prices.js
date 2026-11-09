// Vercel serverless function: refreshes stock prices from a market-data provider.
//  - The app calls it every 60s while someone is logged in and Price source = Live (throttled here).
//  - An admin can force a refresh with the "Refresh prices now" button (?force=1).
//  - An external scheduler can call it with  Authorization: Bearer <CRON_SECRET>.
//
// Server-only env vars (Vercel -> Settings -> Environment Variables, NO "VITE_" prefix):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   PRICE_PROVIDER = yahoo (default, no key) | indianapi | finnhub | twelvedata
//   INDIANAPI_KEY / FINNHUB_API_KEY / TWELVEDATA_API_KEY  (only for those providers)
//   PRICE_REFRESH_SECONDS (default depends on provider: yahoo 60, indianapi 3600), CRON_SECRET (optional)
import { createClient } from "@supabase/supabase-js";
import { PROVIDERS, DEFAULT_REFRESH } from "./_providers.js";

const BATCH = 5; // stocks fetched at the same time

export default async function handler(req, res) {
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // who is calling: the scheduler (secret), or a logged-in user
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    const isCron = !!process.env.CRON_SECRET && token === process.env.CRON_SECRET;
    let isAdmin = false;
    if (!isCron) {
      const { data, error } = await db.auth.getUser(token);
      if (error || !data?.user) return res.status(401).json({ error: "Not logged in" });
      const { data: prof } = await db.from("profiles").select("role").eq("id", data.user.id).single();
      isAdmin = prof?.role === "admin";
    }
    const force = (isCron || isAdmin) && req.query?.force === "1";

    const providerName = process.env.PRICE_PROVIDER || "yahoo";
    const quote = PROVIDERS[providerName];
    if (!quote) return res.status(500).json({ error: `Unknown PRICE_PROVIDER "${providerName}"` });
    const REFRESH = Number(process.env.PRICE_REFRESH_SECONDS || DEFAULT_REFRESH[providerName] || 60);

    if (!force) {
      const { data: set } = await db.from("settings").select("price_source").eq("id", 1).single();
      if (!set || set.price_source !== "live") return res.json({ skipped: "live mode is off" });

      // claim the refresh slot so many open tabs do not all call the provider
      const cutoff = new Date(Date.now() - REFRESH * 1000).toISOString();
      const { data: claimed } = await db.from("settings")
        .update({ last_fetch: new Date().toISOString() })
        .eq("id", 1)
        .or(`last_fetch.is.null,last_fetch.lte.${cutoff}`)
        .select("id");
      if (!claimed || claimed.length === 0) return res.json({ skipped: "prices are fresh" });
    } else {
      await db.from("settings").update({ last_fetch: new Date().toISOString() }).eq("id", 1);
    }

    const { data: stocks } = await db.from("stocks").select("*").eq("active", true).not("api_symbol", "is", null);
    let updated = 0;
    const errors = [];
    const matches = [];

    for (let i = 0; i < (stocks || []).length; i += BATCH) {
      const chunk = stocks.slice(i, i + BATCH);
      await Promise.all(chunk.map(async (s) => {
        try {
          const q = await quote(s);
          if (!q || !(q.price > 0)) { errors.push(`${s.symbol}: no data (check the API symbol and exchange)`); return; }
          const patch = { price: q.price, updated_at: new Date().toISOString() };
          if (q.prevClose > 0) patch.prev_close = q.prevClose;
          const { error } = await db.from("stocks").update(patch).eq("symbol", s.symbol);
          if (error) errors.push(`${s.symbol}: ${error.message}`);
          else { updated++; if (q.label) matches.push(`${s.symbol} = ${q.label}`); }
        } catch (e) {
          errors.push(`${s.symbol}: ${e.message}`);
        }
      }));
    }
    return res.json({ provider: providerName, updated, errors, matches });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// Vercel serverless function: refreshes stock prices from a market-data API.
// Called by the app every 60s while someone is logged in (throttled here),
// or by an external scheduler using CRON_SECRET.
//
// Server-only env vars (Vercel -> Settings -> Environment Variables):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (the secret key, never expose it in the browser)
//   PRICE_PROVIDER = finnhub | twelvedata
//   FINNHUB_API_KEY or TWELVEDATA_API_KEY
//   PRICE_REFRESH_SECONDS (default 60)
//   CRON_SECRET (optional, for an external scheduler)
import { createClient } from "@supabase/supabase-js";

const REFRESH = Number(process.env.PRICE_REFRESH_SECONDS || 60);

// ---- provider adapters: return { price, prevClose } or null ----
async function finnhubQuote(stock) {
  const key = process.env.FINNHUB_API_KEY;
  const sym = stock.api_exchange ? `${stock.api_symbol}.${stock.api_exchange}` : stock.api_symbol;
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${key}`);
  if (!r.ok) throw new Error(`finnhub ${r.status}`);
  const j = await r.json();
  if (!j || !j.c) return null; // c = current price, pc = previous close
  return { price: Number(j.c), prevClose: j.pc ? Number(j.pc) : null };
}

async function twelveDataQuote(stock) {
  const key = process.env.TWELVEDATA_API_KEY;
  const ex = stock.api_exchange ? `&exchange=${encodeURIComponent(stock.api_exchange)}` : "";
  const r = await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(stock.api_symbol)}${ex}&apikey=${key}`);
  if (!r.ok) throw new Error(`twelvedata ${r.status}`);
  const j = await r.json();
  if (!j || j.status === "error" || !j.close) return null;
  return { price: Number(j.close), prevClose: j.previous_close ? Number(j.previous_close) : null };
}

const PROVIDERS = { finnhub: finnhubQuote, twelvedata: twelveDataQuote };

export default async function handler(req, res) {
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // who is calling: a logged-in user, or the scheduler with CRON_SECRET
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    const isCron = process.env.CRON_SECRET && token === process.env.CRON_SECRET;
    if (!isCron) {
      const { data, error } = await db.auth.getUser(token);
      if (error || !data?.user) return res.status(401).json({ error: "Not logged in" });
    }

    const { data: set } = await db.from("settings").select("price_source,last_fetch").eq("id", 1).single();
    if (!set || set.price_source !== "live") return res.json({ skipped: "live mode is off" });

    // claim the refresh slot so many open tabs do not all call the API
    const cutoff = new Date(Date.now() - REFRESH * 1000).toISOString();
    const { data: claimed } = await db.from("settings")
      .update({ last_fetch: new Date().toISOString() })
      .eq("id", 1)
      .or(`last_fetch.is.null,last_fetch.lte.${cutoff}`)
      .select("id");
    if (!claimed || claimed.length === 0) return res.json({ skipped: "prices are fresh" });

    const quote = PROVIDERS[process.env.PRICE_PROVIDER || "finnhub"];
    if (!quote) return res.status(500).json({ error: "Unknown PRICE_PROVIDER" });

    const { data: stocks } = await db.from("stocks").select("*").eq("active", true).not("api_symbol", "is", null);
    let updated = 0;
    const errors = [];
    for (const s of stocks || []) {
      try {
        const q = await quote(s);
        if (!q || !(q.price > 0)) { errors.push(`${s.symbol}: no data`); continue; }
        const patch = { price: q.price, updated_at: new Date().toISOString() };
        if (q.prevClose > 0) patch.prev_close = q.prevClose;
        const { error } = await db.from("stocks").update(patch).eq("symbol", s.symbol);
        if (error) errors.push(`${s.symbol}: ${error.message}`); else updated++;
      } catch (e) {
        errors.push(`${s.symbol}: ${e.message}`);
      }
    }
    return res.json({ updated, errors });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

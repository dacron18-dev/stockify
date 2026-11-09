// Price providers. Each returns { price, prevClose } or null when there is no data.
// (Files starting with "_" inside /api are NOT exposed as web routes by Vercel.)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function getJson(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { ...options, signal: ctrl.signal });
    if (!r.ok) {
      const hint = r.status === 429 ? " (rate limit or quota used up)" : r.status === 401 || r.status === 403 ? " (API key rejected)" : "";
      throw new Error(`HTTP ${r.status}${hint}`);
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Yahoo Finance (no API key) ----------
// RELIANCE + exchange NSE -> RELIANCE.NS    RELIANCE + BSE -> RELIANCE.BO
// A symbol that already has a dot (TCS.NS) or starts with ^ (^NSEI) is used as it is.
export function yahooSymbol(stock) {
  const s = String(stock.api_symbol || stock.symbol).trim().toUpperCase();
  if (s.includes(".") || s.startsWith("^")) return s;
  const ex = String(stock.api_exchange || "").trim().toUpperCase();
  if (ex === "NSE") return s + ".NS";
  if (ex === "BSE" || ex === "BOM") return s + ".BO";
  return s; // no exchange given: treated as a US ticker
}

export async function yahooQuote(stock) {
  const sym = yahooSymbol(stock);
  const j = await getJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
    { headers: { "User-Agent": UA, Accept: "application/json" } }
  );
  const meta = j?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!(price > 0)) return null;
  const prev = Number(meta.previousClose ?? meta.chartPreviousClose);
  return { price, prevClose: prev > 0 ? prev : null };
}

// ---------- Finnhub (API key) ----------
export async function finnhubQuote(stock) {
  const sym = stock.api_exchange ? `${stock.api_symbol}.${stock.api_exchange}` : stock.api_symbol;
  const j = await getJson(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${process.env.FINNHUB_API_KEY}`
  );
  if (!j || !j.c) return null; // c = current price, pc = previous close
  return { price: Number(j.c), prevClose: j.pc ? Number(j.pc) : null };
}

// ---------- Twelve Data (API key) ----------
export async function twelveDataQuote(stock) {
  const ex = stock.api_exchange ? `&exchange=${encodeURIComponent(stock.api_exchange)}` : "";
  const j = await getJson(
    `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(stock.api_symbol)}${ex}&apikey=${process.env.TWELVEDATA_API_KEY}`
  );
  if (!j || j.status === "error" || !j.close) return null;
  return { price: Number(j.close), prevClose: j.previous_close ? Number(j.previous_close) : null };
}

// ---------- IndianAPI.in (API key, Indian stocks) ----------
// Docs: GET /stock?name=Reliance  with header X-Api-Key. One request per stock.
// Free and Hobby plans use https://stock.indianapi.in ; paid plans use another host (set INDIANAPI_BASE_URL).
// "name" is a search term (company name, short name or ticker), so set each stock's "API symbol" in the
// admin screen to something that finds the right company, e.g. "Reliance" or "TCS".
export async function indianApiQuote(stock) {
  const base = (process.env.INDIANAPI_BASE_URL || "https://stock.indianapi.in").replace(/\/+$/, "");
  const term = stock.api_symbol || stock.name;
  const j = await getJson(`${base}/stock?name=${encodeURIComponent(term)}`, {
    headers: { "X-Api-Key": process.env.INDIANAPI_KEY || "", Accept: "application/json" },
  });
  const cp = j?.currentPrice || {};
  const wantBse = String(stock.api_exchange || "NSE").toUpperCase() === "BSE";
  const price = Number(wantBse ? cp.BSE ?? cp.NSE : cp.NSE ?? cp.BSE);
  if (!(price > 0)) return null;
  // the API gives today's % change, so previous close = price / (1 + change%)
  const pc = Number(j.percentChange);
  const prevClose = Number.isFinite(pc) && pc > -99 ? Math.round((price / (1 + pc / 100)) * 100) / 100 : null;
  return { price, prevClose, label: j.companyName || j.tickerId || null };
}

export const PROVIDERS = {
  yahoo: yahooQuote,
  indianapi: indianApiQuote,
  finnhub: finnhubQuote,
  twelvedata: twelveDataQuote,
};

// how often each provider may be called by default (seconds); IndianAPI's free plan is tiny
export const DEFAULT_REFRESH = { yahoo: 60, finnhub: 60, twelvedata: 300, indianapi: 3600 };

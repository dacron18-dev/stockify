# Stockify: stock market paper-trading app

React + Vite + Supabase, deployed on Vercel. Two kinds of users:
- **Customer**: signs up, gets virtual cash, buys and sells at the current price, sees portfolio, order history and a leaderboard.
- **Admin**: controls stock prices (manual, simulator or live API), adds stocks, opens/closes the market, manages users.

## Setup (about 15 minutes)

1. **Supabase**: create a free project. SQL Editor -> New query -> paste all of `supabase/schema.sql` -> Run.
2. **Authentication -> Providers -> Email**: switch OFF "Confirm email" so students can sign up and log in straight away.
3. **Run locally** (optional): copy `.env.example` to `.env`, fill the two `VITE_` lines, then `npm install && npm run dev`.
4. **Sign up** in the app with your own email, then make yourself admin (SQL Editor):
   `update profiles set role = 'admin' where email = 'YOUR-EMAIL';`  then refresh.
5. **Deploy**: push this folder to GitHub, import it in Vercel, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, Deploy.
6. In the admin screen, set real starting prices (Market control tab) or press **Start simulator**.

## How trading is kept honest
Customers cannot edit cash, holdings, orders or prices. Every order goes through the database function `place_order`, which reads the price on the server, checks cash/holdings, and updates everything in one step.

## Connecting a live price API
See `api/update-prices.js`. In short:
1. Pick a provider: **yahoo** (no key, unofficial, Indian stocks like RELIANCE.NS), or Finnhub / Twelve Data (free API key).
2. In Vercel add (server-only, no VITE_ prefix): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PRICE_PROVIDER` (yahoo needs no key), the provider key if any, optional `PRICE_REFRESH_SECONDS` and `CRON_SECRET`. Redeploy.
3. In Admin -> Market control, check each stock's "API symbol" and "Exch." columns match the provider's format.
4. In Admin -> Settings set Price source to **Live API**.
5. While anyone is logged in, the app asks the server for fresh prices every 60 seconds (the server throttles so your API quota is safe).

## One codebase, two ways to get prices
The code is identical; the Vercel environment variable `PRICE_PROVIDER` picks the source:
- `yahoo`: no key, unofficial, any NSE/BSE stock (RELIANCE + NSE -> RELIANCE.NS). Refreshes every 60 s in Live mode.
- `indianapi`: official Indian API (indianapi.in), needs `INDIANAPI_KEY`. One request per stock; the free plan has only
  500 requests a month, so use the **Refresh prices now** button once or twice a day.
To run both at once, deploy the same GitHub repo as two Vercel projects, each with its own env vars (and its own Supabase project).

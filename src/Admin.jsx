import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import { Header, fetchAll, fmt, pct, signed, useMarket } from "./lib.jsx";

export default function Admin({ session, profile, onLogout }) {
  const market = useMarket();
  const { stocks, settings } = market;
  const [tab, setTab] = useState("market");
  const [msg, setMsg] = useState(null);

  const [users, setUsers] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [orders, setOrders] = useState([]);

  // price simulator (runs in this browser while this page is open)
  const [sim, setSim] = useState(false);
  const [simSecs, setSimSecs] = useState("5");
  const [simVol, setSimVol] = useState("0.5");
  const stocksRef = useRef([]);
  stocksRef.current = stocks;

  // add-stock form
  const [ns, setNs] = useState({ symbol: "", name: "", price: "", api_symbol: "", api_exchange: "" });

  const ok = (text) => setMsg({ ok: true, text });
  const bad = (text) => setMsg({ ok: false, text });
  const live = settings?.price_source === "live";

  async function updateStock(symbol, patch) {
    const { error } = await supabase.from("stocks").update({ ...patch, updated_at: new Date().toISOString() }).eq("symbol", symbol);
    if (error) bad(error.message); else market.reload();
  }

  async function addStock() {
    const price = Number(ns.price);
    if (!ns.symbol.trim() || !ns.name.trim() || !(price > 0)) return bad("Enter symbol, name and a price above 0");
    const sym = ns.symbol.trim().toUpperCase();
    const { error } = await supabase.from("stocks").insert({
      symbol: sym, name: ns.name.trim(), price, prev_close: price,
      api_symbol: ns.api_symbol.trim() || sym, api_exchange: ns.api_exchange.trim() || null,
    });
    if (error) return bad(error.message);
    setNs({ symbol: "", name: "", price: "", api_symbol: "", api_exchange: "" });
    ok(`Added ${sym}`);
    market.reload();
  }

  async function refreshNow() {
    setMsg(null);
    try {
      const { data } = await supabase.auth.getSession();
      const r = await fetch("/api/update-prices?force=1", { headers: { Authorization: "Bearer " + data.session.access_token } });
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); } catch { return bad("The price function was not found. It only exists on the deployed Vercel site, not in npm run dev."); }
      if (!r.ok) return bad(j.error || "Refresh failed");
      if (j.errors && j.errors.length) bad(`Updated ${j.updated} stock(s). Problems: ${j.errors.join("; ")}`);
      else ok(`Updated ${j.updated} stock(s) from ${j.provider}` + (j.matches && j.matches.length ? `. Matched: ${j.matches.join("; ")}` : ""));
      market.reload();
    } catch (e) { bad(e.message); }
  }

  async function saveSetting(patch) {
    const { error } = await supabase.from("settings").update(patch).eq("id", 1);
    if (error) bad(error.message); else market.reload();
  }

  async function rpc(name, args, done) {
    const { error } = await supabase.rpc(name, args);
    if (error) return bad(error.message);
    ok(done);
    market.reload();
    loadPeople();
  }

  const loadPeople = useCallback(async () => {
    try {
      const [u, h] = await Promise.all([fetchAll("profiles", "created_at"), fetchAll("holdings", "user_id")]);
      setUsers(u); setHoldings(h);
    } catch (e) { bad(e.message); }
  }, []);

  const loadOrders = useCallback(async () => {
    const { data, error } = await supabase.from("trades")
      .select("*, profiles(name,email)").order("created_at", { ascending: false }).limit(200);
    if (error) bad(error.message); else setOrders(data);
  }, []);

  useEffect(() => { if (tab === "users") loadPeople(); if (tab === "orders") loadOrders(); }, [tab, loadPeople, loadOrders]);

  // simulator loop
  useEffect(() => {
    if (!sim || live) return;
    const secs = Math.max(2, Number(simSecs) || 5);
    const vol = Math.min(10, Math.max(0.05, Number(simVol) || 0.5));
    const id = setInterval(async () => {
      await Promise.all(stocksRef.current.filter((s) => s.active).map((s) => {
        const drift = (Math.random() - 0.5) * 2 * (vol / 100);
        const np = Math.max(1, Math.round(Number(s.price) * (1 + drift) * 100) / 100);
        return supabase.from("stocks").update({ price: np, updated_at: new Date().toISOString() }).eq("symbol", s.symbol);
      }));
    }, secs * 1000);
    return () => clearInterval(id);
  }, [sim, simSecs, simVol, live]);

  const priceOf = useMemo(() => Object.fromEntries(stocks.map((s) => [s.symbol, Number(s.price)])), [stocks]);
  const holdValue = useMemo(() => {
    const m = {};
    for (const h of holdings) m[h.user_id] = (m[h.user_id] || 0) + h.qty * (priceOf[h.symbol] || Number(h.avg_price));
    return m;
  }, [holdings, priceOf]);
  const startCash = Number(settings?.start_cash || 0);

  return (
    <div className="app">
      <Header profile={profile} onLogout={onLogout} market={market} />
      {market.err && <div className="msg err">Connection problem: {market.err}</div>}
      {msg && <div className={"msg " + (msg.ok ? "ok" : "err")} onClick={() => setMsg(null)}>{msg.text}</div>}

      <nav className="tabs">
        {[["market", "Market control"], ["users", "Users"], ["orders", "All orders"], ["settings", "Settings"]].map(([k, l]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>

      {tab === "market" && (
        <>
          <section className="card">
            <div className="head">
              <h2>Stocks &amp; prices</h2>
              <button className="ghost" onClick={() => window.confirm("Set every stock's previous close to its current price (start a new trading day)?") && rpc("admin_new_day", {}, "New trading day started")}>
                Start new trading day
              </button>
            </div>
            {live && <div className="msg warn">Live mode is ON: prices come from the API. Manual edits and the simulator are paused.</div>}
            <div className="scroll">
              <table>
                <thead><tr><th>Symbol</th><th>Name</th><th className="r">Price</th><th className="r">Prev close</th><th className="r">Change</th><th>API symbol</th><th>Exch.</th><th>Active</th></tr></thead>
                <tbody>
                  {stocks.map((s) => (
                    <tr key={s.symbol + s.price + s.prev_close}>
                      <td><b>{s.symbol}</b></td>
                      <td>{s.name}</td>
                      <td className="r"><input className="num" defaultValue={s.price} disabled={live}
                        onBlur={(e) => Number(e.target.value) > 0 && Number(e.target.value) !== Number(s.price) && updateStock(s.symbol, { price: Number(e.target.value) })} /></td>
                      <td className="r"><input className="num" defaultValue={s.prev_close}
                        onBlur={(e) => Number(e.target.value) > 0 && Number(e.target.value) !== Number(s.prev_close) && updateStock(s.symbol, { prev_close: Number(e.target.value) })} /></td>
                      <td className={"r " + (pct(Number(s.price), Number(s.prev_close)) >= 0 ? "up" : "down")}>{signed(pct(Number(s.price), Number(s.prev_close)))}%</td>
                      <td><input className="mid" defaultValue={s.api_symbol || ""} onBlur={(e) => e.target.value !== (s.api_symbol || "") && updateStock(s.symbol, { api_symbol: e.target.value || null })} /></td>
                      <td><input className="mini" defaultValue={s.api_exchange || ""} onBlur={(e) => e.target.value !== (s.api_exchange || "") && updateStock(s.symbol, { api_exchange: e.target.value || null })} /></td>
                      <td><input type="checkbox" checked={s.active} onChange={(e) => updateStock(s.symbol, { active: e.target.checked })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">Edit a price and click outside the box to save. Untick Active to hide a stock from traders (nothing is deleted).</p>
          </section>

          <section className="card">
            <h3>Add a stock</h3>
            <div className="row">
              <input placeholder="Symbol e.g. ZOMATO" value={ns.symbol} onChange={(e) => setNs({ ...ns, symbol: e.target.value })} />
              <input placeholder="Company name" value={ns.name} onChange={(e) => setNs({ ...ns, name: e.target.value })} />
              <input placeholder="Price" inputMode="decimal" value={ns.price} onChange={(e) => setNs({ ...ns, price: e.target.value })} />
              <input placeholder="API symbol (optional)" value={ns.api_symbol} onChange={(e) => setNs({ ...ns, api_symbol: e.target.value })} />
              <input placeholder="Exchange (optional)" value={ns.api_exchange} onChange={(e) => setNs({ ...ns, api_exchange: e.target.value })} />
              <button className="primary" onClick={addStock}>Add</button>
            </div>
          </section>

          <section className="card">
            <h3>Price simulator (for demos, no API needed)</h3>
            <p className="muted small">Moves every active stock randomly. It runs in this browser, so keep this tab open. Turned off automatically when Live mode is on.</p>
            <div className="row">
              <label className="inline">Every <input className="mini" value={simSecs} onChange={(e) => setSimSecs(e.target.value)} /> seconds</label>
              <label className="inline">Max move <input className="mini" value={simVol} onChange={(e) => setSimVol(e.target.value)} /> %</label>
              <button className={sim ? "danger" : "primary"} onClick={() => setSim(!sim)} disabled={live}>{sim ? "Stop simulator" : "Start simulator"}</button>
              {sim && !live && <span className="pill up">Running</span>}
            </div>
          </section>
        </>
      )}

      {tab === "users" && (
        <section className="card">
          <div className="head">
            <h2>Users ({users.length})</h2>
            <button className="danger" onClick={() => window.confirm("Reset EVERY trader: delete all orders and holdings and restore starting cash?") && rpc("admin_reset_all", {}, "All traders reset")}>
              Reset all traders
            </button>
          </div>
          <div className="scroll">
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th className="r">Cash</th><th className="r">Total value</th><th className="r">Return</th><th></th></tr></thead>
              <tbody>
                {users.map((u) => {
                  const total = Number(u.cash) + (holdValue[u.id] || 0);
                  return (
                    <tr key={u.id}>
                      <td><b>{u.name}</b></td>
                      <td className="small">{u.email}</td>
                      <td>{u.role}</td>
                      <td className="r">{fmt(u.cash)}</td>
                      <td className="r">{fmt(total)}</td>
                      <td className={"r " + (total >= startCash ? "up" : "down")}>{signed(pct(total, startCash))}%</td>
                      <td className="actions">
                        <button className="ghost" onClick={() => {
                          const v = window.prompt(`Set cash for ${u.name} (₹):`, u.cash);
                          if (v !== null && Number(v) >= 0 && v.trim() !== "") rpc("admin_set_cash", { p_user: u.id, p_cash: Number(v) }, `Cash updated for ${u.name}`);
                        }}>Set cash</button>
                        <button className="ghost" onClick={() => window.confirm(`Reset ${u.name}? Orders and holdings are deleted.`) && rpc("admin_reset_user", { p_user: u.id }, `${u.name} reset`)}>Reset</button>
                        {u.id !== session.user.id && (
                          <button className="ghost" onClick={() => rpc("admin_set_role", { p_user: u.id, p_role: u.role === "admin" ? "customer" : "admin" }, `${u.name} is now ${u.role === "admin" ? "a customer" : "an admin"}`)}>
                            {u.role === "admin" ? "Make customer" : "Make admin"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "orders" && (
        <section className="card">
          <div className="head"><h2>Latest 200 orders</h2><button className="ghost" onClick={loadOrders}>Refresh</button></div>
          <div className="scroll">
            <table>
              <thead><tr><th>Time</th><th>Trader</th><th>Stock</th><th>Side</th><th className="r">Qty</th><th className="r">Price</th><th className="r">Amount</th></tr></thead>
              <tbody>
                {orders.map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.created_at).toLocaleString()}</td>
                    <td>{t.profiles?.name || "—"}</td>
                    <td><b>{t.symbol}</b></td>
                    <td className={t.side === "BUY" ? "up" : "down"}>{t.side}</td>
                    <td className="r">{t.qty}</td>
                    <td className="r">{fmt(t.price)}</td>
                    <td className="r">{fmt(t.qty * t.price)}</td>
                  </tr>
                ))}
                {!orders.length && <tr><td colSpan="7" className="muted">No orders yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "settings" && (
        <section className="card">
          <h2>Settings</h2>
          <label>Starting cash for new traders and resets (₹)</label>
          <input key={"sc" + startCash} className="mid" defaultValue={startCash}
            onBlur={(e) => Number(e.target.value) > 0 && Number(e.target.value) !== startCash && saveSetting({ start_cash: Number(e.target.value) })} />
          <p className="muted small">Existing traders keep their current cash. Use "Reset all traders" to give everyone the new amount.</p>

          <label>Market</label>
          <div className="seg">
            <button className={settings?.market_open ? "on" : ""} onClick={() => saveSetting({ market_open: true })}>Open</button>
            <button className={settings && !settings.market_open ? "on" : ""} onClick={() => saveSetting({ market_open: false })}>Closed</button>
          </div>
          <p className="muted small">When closed, nobody can place orders (prices can still be edited).</p>

          <label>Price source</label>
          <div className="seg">
            <button className={settings?.price_source === "manual" ? "on" : ""} onClick={() => saveSetting({ price_source: "manual" })}>Manual / simulator</button>
            <button className={live ? "on" : ""} onClick={() => saveSetting({ price_source: "live" })}>Live API</button>
          </div>
          <p className="muted small">Live API needs the server function configured (see README). While someone is using the app, prices refresh from your provider automatically.</p>
          <div className="row">
            <button className="primary" onClick={refreshNow}>Refresh prices now</button>
            <span className="muted small">Fetches real prices once and shows the result, handy for testing. Works in any price mode.</span>
          </div>
        </section>
      )}
    </div>
  );
}

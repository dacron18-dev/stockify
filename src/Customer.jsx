import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import { Header, Spark, fmt, pct, signed, useMarket } from "./lib.jsx";

function PriceChart({ symbol, price }) {
  const [vals, setVals] = useState([]);
  useEffect(() => {
    let live = true;
    supabase.from("price_history").select("price").eq("symbol", symbol)
      .order("ts", { ascending: false }).limit(120)
      .then(({ data }) => { if (live && data) setVals(data.map((r) => Number(r.price)).reverse()); });
    return () => { live = false; };
  }, [symbol, price]);
  return <Spark values={vals} />;
}

export default function Customer({ session, profile: p0, onLogout }) {
  const market = useMarket();
  const { stocks, settings } = market;
  const uid = session.user.id;

  const [profile, setProfile] = useState(p0);
  const [holdings, setHoldings] = useState([]);
  const [trades, setTrades] = useState([]);
  const [board, setBoard] = useState([]);
  const [tab, setTab] = useState("market");
  const [sel, setSel] = useState("");
  const [side, setSide] = useState("BUY");
  const [qty, setQty] = useState("1");
  const [search, setSearch] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadMine = useCallback(async () => {
    const [pr, h, t] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", uid).single(),
      supabase.from("holdings").select("*").eq("user_id", uid),
      supabase.from("trades").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(300),
    ]);
    if (pr.data) setProfile(pr.data);
    if (h.data) setHoldings(h.data);
    if (t.data) setTrades(t.data);
  }, [uid]);

  useEffect(() => { loadMine(); }, [loadMine]);

  useEffect(() => {
    if (tab !== "board") return;
    supabase.rpc("leaderboard").then(({ data }) => data && setBoard(data));
  }, [tab, stocks]);

  const px = useMemo(() => Object.fromEntries(stocks.map((s) => [s.symbol, s])), [stocks]);
  const startCash = Number(settings?.start_cash || 0);

  const rows = holdings.map((h) => {
    const price = Number(px[h.symbol]?.price || h.avg_price);
    const value = h.qty * price;
    const cost = h.qty * Number(h.avg_price);
    return { ...h, price, value, cost, pnl: value - cost, pnlPct: pct(value, cost) };
  });
  const holdingsValue = rows.reduce((a, r) => a + r.value, 0);
  const total = Number(profile.cash) + holdingsValue;
  const overall = total - startCash;

  const stock = px[sel];
  const held = holdings.find((h) => h.symbol === sel)?.qty || 0;
  const est = (stock ? Number(stock.price) : 0) * (Number(qty) || 0);

  const list = stocks
    .filter((s) => s.active)
    .filter((s) => (s.symbol + " " + s.name).toLowerCase().includes(search.toLowerCase()));

  function pick(symbol, s = "BUY") {
    setSel(symbol); setSide(s); setTab("market"); setMsg(null);
  }

  async function submit() {
    const n = Number(qty);
    if (!sel) return setMsg({ ok: false, text: "Pick a stock first" });
    if (!Number.isInteger(n) || n < 1) return setMsg({ ok: false, text: "Quantity must be a whole number, 1 or more" });
    setBusy(true);
    const { data, error } = await supabase.rpc("place_order", { p_symbol: sel, p_side: side, p_qty: n });
    setBusy(false);
    if (error) return setMsg({ ok: false, text: error.message });
    setMsg({ ok: true, text: `${side === "BUY" ? "Bought" : "Sold"} ${n} ${sel} at ${fmt(data.price)}` });
    setQty("1");
    loadMine();
  }

  return (
    <div className="app">
      <Header profile={profile} onLogout={onLogout} market={market} />
      {market.err && <div className="msg err">Connection problem: {market.err}</div>}

      <div className="summary">
        <div><span>Cash</span><b>{fmt(profile.cash)}</b></div>
        <div><span>Holdings</span><b>{fmt(holdingsValue)}</b></div>
        <div className="big"><span>Total value</span><b>{fmt(total)}</b></div>
        <div><span>Overall P&L</span><b className={overall >= 0 ? "up" : "down"}>{fmt(overall)} ({signed(pct(total, startCash))}%)</b></div>
      </div>

      <nav className="tabs">
        {[["market", "Market"], ["portfolio", "Portfolio"], ["orders", "Orders"], ["board", "Leaderboard"]].map(([k, l]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>

      {tab === "market" && (
        <div className="cols">
          <section className="card">
            <input className="search" placeholder="Search stocks…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <table>
              <thead><tr><th>Stock</th><th className="r">Price</th><th className="r">Change</th></tr></thead>
              <tbody>
                {list.map((s) => {
                  const ch = pct(Number(s.price), Number(s.prev_close));
                  return (
                    <tr key={s.symbol} className={"click" + (sel === s.symbol ? " sel" : "")} onClick={() => pick(s.symbol, side)}>
                      <td><b>{s.symbol}</b><div className="muted small">{s.name}</div></td>
                      <td className="r">{fmt(s.price)}</td>
                      <td className={"r " + (ch >= 0 ? "up" : "down")}>{signed(ch)}%</td>
                    </tr>
                  );
                })}
                {!list.length && <tr><td colSpan="3" className="muted">No stocks found.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="card">
            {!stock ? (
              <p className="muted">Pick a stock from the list to see its chart and place an order.</p>
            ) : (
              <>
                <div className="head">
                  <div>
                    <h2>{stock.symbol}</h2>
                    <div className="muted small">{stock.name}</div>
                  </div>
                  <div className="r">
                    <div className="price">{fmt(stock.price)}</div>
                    <div className={pct(Number(stock.price), Number(stock.prev_close)) >= 0 ? "up" : "down"}>
                      {signed(pct(Number(stock.price), Number(stock.prev_close)))}% today
                    </div>
                  </div>
                </div>
                <PriceChart symbol={stock.symbol} price={stock.price} />

                <div className="seg">
                  <button className={"buy" + (side === "BUY" ? " on" : "")} onClick={() => setSide("BUY")}>BUY</button>
                  <button className={"sell" + (side === "SELL" ? " on" : "")} onClick={() => setSide("SELL")}>SELL</button>
                </div>
                <label>Quantity</label>
                <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric"
                  onKeyDown={(e) => e.key === "Enter" && submit()} />
                <div className="kv"><span>Estimated {side === "BUY" ? "cost" : "proceeds"}</span><b>{fmt(est)}</b></div>
                <div className="kv"><span>Cash available</span><b>{fmt(profile.cash)}</b></div>
                <div className="kv"><span>You hold</span><b>{held} shares</b></div>
                <button className={"primary wide " + (side === "BUY" ? "buybtn" : "sellbtn")} onClick={submit} disabled={busy}>
                  {busy ? "Placing order…" : `${side} ${stock.symbol}`}
                </button>
                <p className="muted small">Orders execute at the current market price shown by the server.</p>
              </>
            )}
            {msg && <div className={"msg " + (msg.ok ? "ok" : "err")}>{msg.text}</div>}
          </section>
        </div>
      )}

      {tab === "portfolio" && (
        <section className="card">
          <h2>Your holdings</h2>
          <div className="scroll">
            <table>
              <thead><tr><th>Stock</th><th className="r">Qty</th><th className="r">Avg price</th><th className="r">Price</th><th className="r">Value</th><th className="r">P&L</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.symbol}>
                    <td><b>{r.symbol}</b></td>
                    <td className="r">{r.qty}</td>
                    <td className="r">{fmt(r.avg_price)}</td>
                    <td className="r">{fmt(r.price)}</td>
                    <td className="r">{fmt(r.value)}</td>
                    <td className={"r " + (r.pnl >= 0 ? "up" : "down")}>{fmt(r.pnl)}<div className="small">{signed(r.pnlPct)}%</div></td>
                    <td className="r"><button className="ghost" onClick={() => pick(r.symbol, "SELL")}>Sell</button></td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan="7" className="muted">No holdings yet. Go to Market and buy your first stock.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "orders" && (
        <section className="card">
          <h2>Order history</h2>
          <div className="scroll">
            <table>
              <thead><tr><th>Time</th><th>Stock</th><th>Side</th><th className="r">Qty</th><th className="r">Price</th><th className="r">Amount</th></tr></thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.created_at).toLocaleString()}</td>
                    <td><b>{t.symbol}</b></td>
                    <td className={t.side === "BUY" ? "up" : "down"}>{t.side}</td>
                    <td className="r">{t.qty}</td>
                    <td className="r">{fmt(t.price)}</td>
                    <td className="r">{fmt(t.qty * t.price)}</td>
                  </tr>
                ))}
                {!trades.length && <tr><td colSpan="6" className="muted">No orders yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "board" && (
        <section className="card">
          <h2>Leaderboard</h2>
          <table>
            <thead><tr><th>#</th><th>Trader</th><th className="r">Total value</th><th className="r">Return</th></tr></thead>
            <tbody>
              {board.map((b, i) => (
                <tr key={i} className={b.is_me ? "sel" : ""}>
                  <td>{i + 1}</td>
                  <td>{b.name}{b.is_me ? " (you)" : ""}</td>
                  <td className="r">{fmt(b.total)}</td>
                  <td className={"r " + (b.ret_pct >= 0 ? "up" : "down")}>{signed(Number(b.ret_pct))}%</td>
                </tr>
              ))}
              {!board.length && <tr><td colSpan="4" className="muted">No traders yet.</td></tr>}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

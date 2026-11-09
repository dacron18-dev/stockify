import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";

export const fmt = (n) =>
  "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const pct = (now, base) => (base ? ((now - base) / base) * 100 : 0);
export const signed = (n) => (n >= 0 ? "+" : "") + n.toFixed(2);

// Supabase returns at most 1000 rows per request, so page through
export async function fetchAll(table, orderCol, ascending = true) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(table).select("*").order(orderCol, { ascending }).range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// Small line chart from a list of prices
export function Spark({ values, height = 120 }) {
  if (!values || values.length < 2) return <div className="muted chartempty">Chart appears after the first price change.</div>;
  const w = 520, h = height, pad = 6;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const up = values[values.length - 1] >= values[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="spark" preserveAspectRatio="none">
      <polyline points={pts.join(" ")} fill="none" stroke={up ? "var(--up)" : "var(--down)"} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// Live market data (stocks + settings), refreshed in real time
export function useMarket() {
  const [stocks, setStocks] = useState([]);
  const [settings, setSettings] = useState(null);
  const [err, setErr] = useState("");
  const timer = useRef(null);

  const load = useCallback(async () => {
    const [s, st] = await Promise.all([
      supabase.from("stocks").select("*").order("symbol"),
      supabase.from("settings").select("*").eq("id", 1).single(),
    ]);
    if (s.error) setErr(s.error.message); else { setStocks(s.data); setErr(""); }
    if (!st.error) setSettings(st.data);
  }, []);

  useEffect(() => {
    load();
    const ch = supabase
      .channel("market")
      .on("postgres_changes", { event: "*", schema: "public", table: "stocks" }, () => {
        clearTimeout(timer.current); timer.current = setTimeout(load, 300);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "settings" }, () => {
        clearTimeout(timer.current); timer.current = setTimeout(load, 300);
      })
      .subscribe();
    const poll = setInterval(load, 30000); // safety net if realtime drops
    return () => { supabase.removeChannel(ch); clearInterval(poll); clearTimeout(timer.current); };
  }, [load]);

  // Live mode: ask the server to refresh prices from the API (the server throttles this)
  const live = settings?.price_source === "live";
  useEffect(() => {
    if (!live) return;
    const ping = async () => {
      if (document.hidden) return;
      const { data } = await supabase.auth.getSession();
      if (!data.session) return;
      fetch("/api/update-prices", { headers: { Authorization: "Bearer " + data.session.access_token } }).catch(() => {});
    };
    ping();
    const t = setInterval(ping, 60000);
    return () => clearInterval(t);
  }, [live]);

  return { stocks, settings, err, reload: load };
}

export function Header({ profile, onLogout, market }) {
  const open = market?.settings?.market_open;
  return (
    <header className="top">
      <div className="brand">📈 Stockify</div>
      <div className="topright">
        {market?.settings && (
          <span className={"pill " + (open ? "up" : "down")}>{open ? "Market open" : "Market closed"}</span>
        )}
        {market?.settings?.price_source === "live" && <span className="pill">Live prices</span>}
        <span className="who">{profile.name}{profile.role === "admin" ? " (admin)" : ""}</span>
        <button className="ghost" onClick={onLogout}>Logout</button>
      </div>
    </header>
  );
}

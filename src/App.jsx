import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import Customer from "./Customer.jsx";
import Admin from "./Admin.jsx";
import "./App.css";

function Auth() {
  const [mode, setMode] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setMsg(null);
    if (mode === "login") {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) setMsg({ ok: false, text: error.message });
    } else {
      if (!name.trim()) { setBusy(false); return setMsg({ ok: false, text: "Enter your name" }); }
      if (password.length < 6) { setBusy(false); return setMsg({ ok: false, text: "Password must be at least 6 characters" }); }
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(), password, options: { data: { name: name.trim() } },
      });
      if (error) setMsg({ ok: false, text: error.message });
      else if (!data.session) setMsg({ ok: true, text: "Account created. Check your email to confirm it, then log in." });
    }
    setBusy(false);
  }

  const onEnter = (e) => e.key === "Enter" && submit();

  return (
    <div className="authwrap">
      <div className="card authcard">
        <h1>📈 Stockify</h1>
        <p className="muted">Learn to trade with virtual money. No risk, real practice.</p>
        <div className="seg">
          <button className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>Login</button>
          <button className={mode === "signup" ? "on" : ""} onClick={() => setMode("signup")}>Sign up</button>
        </div>
        {mode === "signup" && (
          <>
            <label>Your name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onEnter} />
          </>
        )}
        <label>Email</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={onEnter} />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={onEnter} />
        <button className="primary wide" onClick={submit} disabled={busy}>
          {busy ? "Please wait…" : mode === "login" ? "Login" : "Create account"}
        </button>
        {msg && <div className={"msg " + (msg.ok ? "ok" : "err")}>{msg.text}</div>}
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined);
  const [profile, setProfile] = useState(null);
  const [profErr, setProfErr] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { setSession(s); if (!s) setProfile(null); });
    return () => sub.subscription.unsubscribe();
  }, []);

  const loadProfile = useCallback(async () => {
    if (!session) return;
    const { data, error } = await supabase.from("profiles").select("*").eq("id", session.user.id).single();
    if (error) setProfErr(error.message); else { setProfile(data); setProfErr(""); }
  }, [session]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  const logout = () => supabase.auth.signOut();

  if (session === undefined) return <div className="center muted">Loading…</div>;
  if (!session) return <Auth />;
  if (profErr) return (
    <div className="center">
      <div className="msg err">Could not load your profile: {profErr}</div>
      <button className="ghost" onClick={logout}>Logout</button>
    </div>
  );
  if (!profile) return <div className="center muted">Loading your account…</div>;

  return profile.role === "admin"
    ? <Admin session={session} profile={profile} onLogout={logout} />
    : <Customer session={session} profile={profile} onLogout={logout} />;
}

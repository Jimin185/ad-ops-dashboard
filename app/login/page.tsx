"use client";
import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    setBusy(false);
    if (res.ok) window.location.href = "/";
    else setError((await res.json().catch(() => ({})) as { error?: string }).error || "로그인 실패");
  }

  return (
    <main style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", background: "#f6f7f5" }}>
      <form onSubmit={submit} style={{ background: "#fff", padding: "36px 32px", borderRadius: 14, boxShadow: "0 4px 24px rgba(0,0,0,.06)", width: 320 }}>
        <h1 style={{ fontSize: 18, margin: "0 0 6px" }}>광고 운영 대시보드</h1>
        <p style={{ fontSize: 13, color: "#777", margin: "0 0 18px" }}>비밀번호를 입력하세요</p>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus
          style={{ width: "100%", padding: "10px 12px", fontSize: 15, border: "1px solid #ddd", borderRadius: 8, boxSizing: "border-box" }} />
        {error && <p style={{ color: "#c0392b", fontSize: 13, margin: "10px 0 0" }}>{error}</p>}
        <button type="submit" disabled={busy || !password}
          style={{ width: "100%", marginTop: 14, padding: "10px 0", fontSize: 15, border: 0, borderRadius: 8, background: "#2d6a4f", color: "#fff", cursor: "pointer", opacity: busy || !password ? 0.6 : 1 }}>
          {busy ? "확인 중…" : "들어가기"}
        </button>
      </form>
    </main>
  );
}

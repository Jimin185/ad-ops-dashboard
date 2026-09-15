"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Campaign, ChangeOperation, PendingAction } from "@/lib/types";

type ChatMessage = { role: "user" | "assistant"; content: string; pendingActions?: PendingAction[] };

const won = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
const channelLabel = { naver_sa: "네이버 SA", naver_gfa: "네이버 GFA", meta: "Meta", google_ads: "Google Ads" } as const;

function MarkdownLite({ value }: { value: string }) {
  const lines = value.split("\n");
  const tableStart = lines.findIndex((line, index) => line.includes("|") && lines[index + 1]?.includes("---"));
  if (tableStart < 0) return <div className="message-text">{value}</div>;
  const before = lines.slice(0, tableStart).join("\n");
  const tableLines = lines.slice(tableStart).filter((line) => line.includes("|"));
  const rows = tableLines.filter((_, index) => index !== 1).map((line) => line.split("|").map((cell) => cell.trim()).filter(Boolean));
  return (
    <div className="message-text">
      {before && <div>{before}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr>{rows[0]?.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
          <tbody>{rows.slice(1).map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function ConfirmCard({ action, onDone }: { action: PendingAction; onDone: (message: string) => void }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "cancelled">("idle");

  async function apply() {
    setState("loading");
    const response = await fetch("/api/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: action.token }) });
    const data = await response.json();
    if (!response.ok) {
      setState("idle");
      onDone(data.error || "변경에 실패했습니다.");
      return;
    }
    setState("done");
    onDone(data.message);
  }

  return (
    <div className="confirm-card">
      <strong>{action.title}</strong>
      {action.items.map((item) => (
        <div className="change-row" key={`${item.targetId}-${item.field}`}>
          <span>{item.targetName}</span>
          <span>{item.field}: <del>{String(item.before ?? "없음")}</del> → <b>{String(item.after)}</b></span>
        </div>
      ))}
      <div className="confirm-actions">
        <button className="secondary" disabled={state !== "idle"} onClick={() => setState("cancelled")}>{state === "cancelled" ? "취소됨" : "취소"}</button>
        <button className="primary" disabled={state !== "idle"} onClick={apply}>{state === "loading" ? "적용 중…" : state === "done" ? "적용 완료" : "적용"}</button>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [mode, setMode] = useState("mock");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [chatOpen, setChatOpen] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: "안녕하세요. 캠페인 조회, 성과 요약, 예산·상태 변경을 도와드릴게요. 변경은 확인 후에만 적용됩니다." },
  ]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const response = await fetch("/api/campaigns", { cache: "no-store" });
    const data = await response.json();
    if (data.mode) setMode(data.mode);
    if (response.ok) {
      setCampaigns(data.campaigns);
    } else {
      setCampaigns([]);
      setLoadError(data.error || "실계정 캠페인을 불러오지 못했습니다.");
    }
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const totals = useMemo(() => ({
    spend: campaigns.reduce((sum, row) => sum + row.spend, 0),
    conversions: campaigns.reduce((sum, row) => sum + row.conversions, 0),
    active: campaigns.filter((row) => row.status === "on").length,
  }), [campaigns]);

  async function planManual(operation: ChangeOperation) {
    const response = await fetch("/api/manual/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(operation) });
    const data = await response.json();
    if (!response.ok) return window.alert(data.error);
    setMessages((current) => [...current, { role: "assistant", content: "아래 변경 내용을 확인해 주세요.", pendingActions: [data.pendingAction] }]);
    setChatOpen(true);
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setInput("");
    setSending(true);
    try {
      const history = next.map(({ role, content }) => ({ role, content }));
      const response = await fetch("/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: history }) });
      const data = await response.json();
      setMessages((current) => [...current, { role: "assistant", content: response.ok ? data.message : data.error, pendingActions: data.pendingActions }]);
    } catch {
      setMessages((current) => [...current, { role: "assistant", content: "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <main>
      <header>
        <div><span className="eyebrow">CREATIP · AD OPERATIONS</span><h1>광고 운영 대시보드</h1><p>수동 조작과 자연어 운영을 한 화면에서 관리합니다.</p></div>
        <div className={`mode ${mode === "mock" ? "demo" : "live"}`}><span />{mode === "mock" ? "DEMO DATA" : "LIVE API"}</div>
      </header>

      <section className="metrics">
        <article><span>이번 달 광고비</span><strong>{won.format(totals.spend)}</strong><small>연결 채널 통합</small></article>
        <article><span>전환</span><strong>{totals.conversions.toLocaleString()}건</strong><small>이번 달 누적</small></article>
        <article><span>활성 캠페인</span><strong>{totals.active}개</strong><small>전체 {campaigns.length}개</small></article>
      </section>

      <section className="panel">
        <div className="panel-head"><div><h2>캠페인</h2><p>예산과 상태를 직접 수정하거나 AI에게 요청할 수 있습니다.</p></div><button className="secondary" onClick={refresh}>새로고침</button></div>
        {loadError && <div className="connection-error"><b>실계정 연결 오류</b><span>{loadError}</span><small>Vercel 환경변수의 계정 ID, 토큰 및 권한을 확인해 주세요.</small></div>}
        <div className="table-wrap">
          <table className="campaign-table">
            <thead><tr><th>채널</th><th>캠페인</th><th>일예산</th><th>광고비</th><th>ROAS</th><th>상태</th></tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={6}>불러오는 중…</td></tr> : !loadError && campaigns.length === 0 ? <tr><td colSpan={6}>조회된 캠페인이 없습니다.</td></tr> : campaigns.map((campaign) => (
                <tr key={campaign.id}>
                  <td><span className={`channel ${campaign.channel}`}>{channelLabel[campaign.channel]}</span></td>
                  <td><b>{campaign.name}</b><small className="id">{campaign.id}</small></td>
                  <td><button className="value-button" onClick={() => {
                    const value = window.prompt("변경할 일예산을 입력하세요.", String(campaign.dailyBudget));
                    if (value && Number(value) > 0) void planManual({ kind: "update_budget", channel: campaign.channel, entityType: "campaign", id: campaign.id, dailyBudget: Number(value) });
                  }}>{won.format(campaign.dailyBudget)}</button></td>
                  <td>{won.format(campaign.spend)}</td><td>{campaign.roas}%</td>
                  <td><button className={`status ${campaign.status}`} onClick={() => void planManual({ kind: "set_status", channel: campaign.channel, entityType: "campaign", id: campaign.id, status: campaign.status === "on" ? "off" : "on" })}>{campaign.status.toUpperCase()}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <button className="chat-fab" onClick={() => setChatOpen((open) => !open)} aria-label="AI 어시스턴트 열기">✦</button>
      {chatOpen && <aside className="chat-panel">
        <div className="chat-head"><div><b>AI 광고 운영 어시스턴트</b><small>변경은 승인 후 적용됩니다</small></div><button onClick={() => setChatOpen(false)}>×</button></div>
        <div className="messages">
          {messages.map((message, index) => <div className={`message ${message.role}`} key={index}>
            <MarkdownLite value={message.content} />
            {message.pendingActions?.map((action) => <ConfirmCard key={action.id} action={action} onDone={(notice) => { setMessages((current) => [...current, { role: "assistant", content: notice }]); void refresh(); }} />)}
          </div>)}
          {sending && <div className="message assistant"><span className="typing">● ● ●</span></div>}
        </div>
        <div className="suggestions"><button onClick={() => setInput("이번 달 광고비 TOP5를 표로 보여줘")}>광고비 TOP5</button><button onClick={() => setInput("MO 광고그룹을 모두 찾아서 꺼줘")}>MO 그룹 OFF</button></div>
        <div className="composer"><textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }} placeholder="예: 브랜드 캠페인 일예산 5만원으로 올려줘" /><button disabled={sending || !input.trim()} onClick={sendMessage}>전송</button></div>
      </aside>}
    </main>
  );
}

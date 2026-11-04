"use client";

import { useEffect, useMemo, useState } from "react";
import type { Channel, DailyRow } from "@/lib/types";
import { mixTotalBudget, type MediaMix, type MixChannelPlan } from "@/lib/mix";
import { CHANNEL_LABEL, CHANNEL_ORDER, periodRange } from "./report-view";

const won = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
const STATUS_LABEL: Record<MediaMix["status"], string> = { draft: "초안", active: "집행 중", closed: "마감" };

function nextMonth(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}
function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number);
  return { since: `${month}-01`, until: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

export function MixView({ advertiserId, advertiserName, accountKeys, mixes, onSave, onDelete, onAskAi, apiFetch }: {
  advertiserId: string;
  advertiserName: string;
  accountKeys: string[];
  mixes: MediaMix[];
  onSave: (mix: MediaMix) => Promise<void>;
  onDelete: (mix: MediaMix) => Promise<void>;
  onAskAi: (prompt: string) => void;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const thisMonth = periodRange("this_month").month;
  const [month, setMonth] = useState(thisMonth);
  const existing = mixes.find((mix) => mix.month === month);
  const channels = CHANNEL_ORDER.filter((c) => accountKeys.some((key) => key.startsWith(`${c}:`)));
  const blank = (): MediaMix => ({ id: crypto.randomUUID(), advertiserId, month, status: "draft", targetRoas: 0, channels: {}, notes: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const [draft, setDraft] = useState<MediaMix>(existing || blank());
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [prev, setPrev] = useState<Partial<Record<Channel, { spend: number; revenue: number }>> | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setDraft(existing || blank()); setMessage(""); }, [month, existing?.updatedAt, advertiserId]);

  // 직전 월 실적 (믹스 근거)
  useEffect(() => {
    if (!accountKeys.length) return;
    const range = monthRange(nextMonth(month, -1));
    setPrev(null);
    apiFetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accounts: accountKeys, ...range }) })
      .then((r) => r.json()).then((data) => {
        const agg: Partial<Record<Channel, { spend: number; revenue: number }>> = {};
        for (const row of (data.rows || []) as DailyRow[]) { const a = (agg[row.channel] ||= { spend: 0, revenue: 0 }); a.spend += row.spend; a.revenue += row.revenue; }
        setPrev(agg);
      }).catch(() => setPrev({}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, accountKeys.join(",")]);

  const total = mixTotalBudget(draft);
  const blendedRoas = useMemo(() => total ? Object.values(draft.channels).reduce((s, c) => s + (c?.budget || 0) * (c?.targetRoas || 0), 0) / total : 0, [draft, total]);
  const prevMonth = nextMonth(month, -1);
  const prevMix = mixes.find((mix) => mix.month === prevMonth);

  function setPlan(channel: Channel, patch: Partial<MixChannelPlan>) {
    setDraft((d) => ({ ...d, channels: { ...d.channels, [channel]: { budget: 0, targetRoas: 0, ...d.channels[channel], ...patch } } }));
  }
  function fillFromPrevious() {
    if (!prev) return;
    const channelsPlan: MediaMix["channels"] = {};
    for (const c of channels) {
      const p = prev[c];
      if (p?.spend) channelsPlan[c] = { budget: Math.round(p.spend / 10000) * 10000, targetRoas: Math.round(p.revenue / p.spend * 100), note: "직전 월 실적 기준" };
    }
    setDraft((d) => ({ ...d, channels: channelsPlan, targetRoas: d.targetRoas || Math.round(Object.values(prev).reduce((s, p) => s + (p?.revenue || 0), 0) / Math.max(1, Object.values(prev).reduce((s, p) => s + (p?.spend || 0), 0)) * 100) }));
  }
  async function save(status?: MediaMix["status"]) {
    setSaving(true); setMessage("");
    try { await onSave({ ...draft, status: status || draft.status, targetRoas: draft.targetRoas || Math.round(blendedRoas) }); setMessage("저장했습니다."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "저장하지 못했습니다."); }
    finally { setSaving(false); }
  }

  const aiPrompt = `${advertiserName}의 ${month} 미디어 믹스 초안을 만들어줘. ${prevMonth} 실적(get_report)과 지난 믹스를 근거로 채널별 월예산과 목표 ROAS를 제안하고, propose_mix로 초안을 올려줘.${total ? ` 총 예산은 ${total.toLocaleString()}원 기준.` : ""}`;

  return (
    <section className="mix">
      <div className="mix-head">
        <div className="month-picker">
          <button className="secondary" onClick={() => setMonth(nextMonth(month, -1))} aria-label="이전 달">‹</button>
          <b>{month}</b>
          <button className="secondary" onClick={() => setMonth(nextMonth(month, 1))} aria-label="다음 달">›</button>
          {existing ? <span className={`mix-status ${existing.status}`}>{STATUS_LABEL[existing.status]}</span> : <span className="mix-status none">믹스 없음</span>}
        </div>
        <div className="mix-actions">
          <button className="secondary" disabled={!prev} onClick={fillFromPrevious}>{prevMonth} 실적으로 채우기</button>
          <button className="secondary" onClick={() => onAskAi(aiPrompt)}>✦ AI로 초안 만들기</button>
        </div>
      </div>

      <div className="mix-grid">
        <article className="viz-card">
          <div className="viz-head"><span className="viz-title">채널별 계획</span><span className="viz-sub">합계 {won.format(total)} · 가중 목표 ROAS {Math.round(blendedRoas)}%</span></div>
          <div className="table-wrap"><table className="campaign-table mix-table">
            <thead><tr><th>채널</th><th>월 예산</th><th>비중</th><th>목표 ROAS(%)</th><th>{prevMonth} 실적</th><th>메모</th></tr></thead>
            <tbody>{channels.map((c) => {
              const plan = draft.channels[c];
              const p = prev?.[c];
              return <tr key={c}>
                <td><span className={`channel ${c}`}>{CHANNEL_LABEL[c]}</span></td>
                <td><input className="num-input" inputMode="numeric" value={plan?.budget ? plan.budget.toLocaleString() : ""} placeholder="0" onChange={(e) => setPlan(c, { budget: Number(e.target.value.replace(/[^0-9]/g, "")) || 0 })} /></td>
                <td>{total && plan?.budget ? `${Math.round(plan.budget / total * 100)}%` : "–"}</td>
                <td><input className="num-input short" inputMode="numeric" value={plan?.targetRoas || ""} placeholder="0" onChange={(e) => setPlan(c, { targetRoas: Number(e.target.value.replace(/[^0-9]/g, "")) || 0 })} /></td>
                <td className="muted">{prev === null ? "…" : p?.spend ? <>{won.format(p.spend)}<small> · ROAS {Math.round(p.revenue / p.spend * 100)}%</small></> : "–"}</td>
                <td><input className="note-input" value={plan?.note || ""} placeholder="전략·타겟·소재 방향" onChange={(e) => setPlan(c, { note: e.target.value })} /></td>
              </tr>;
            })}</tbody>
          </table></div>
          {!channels.length && <div className="empty-state"><b>매핑된 계정이 없습니다.</b><span>계정 매핑에서 채널 계정을 먼저 연결해 주세요.</span></div>}
        </article>

        <article className="viz-card mix-side">
          <label><span className="viz-title">전체 목표 ROAS(%)</span><input className="num-input" inputMode="numeric" value={draft.targetRoas || ""} placeholder={blendedRoas ? String(Math.round(blendedRoas)) : "0"} onChange={(e) => setDraft({ ...draft, targetRoas: Number(e.target.value.replace(/[^0-9]/g, "")) || 0 })} /></label>
          <label><span className="viz-title">전략 메모</span><textarea rows={5} value={draft.notes} placeholder="이번 달 목표, 프로모션 일정, 주력 상품, 소재 계획 등" onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label>
          {(draft.status === "closed" || month < thisMonth) && <label><span className="viz-title">월 마감 회고</span><textarea rows={4} value={draft.review || ""} placeholder="잘된 점 · 아쉬운 점 · 다음 달 믹스에 반영할 것" onChange={(e) => setDraft({ ...draft, review: e.target.value })} /></label>}
          {prevMix?.review && <div className="prev-review"><span className="viz-title">{prevMonth} 회고</span><p>{prevMix.review}</p></div>}
          <div className="mix-save">
            <button className="secondary" disabled={saving} onClick={() => save("draft")}>초안 저장</button>
            <button className="primary" disabled={saving || !total} onClick={() => save("active")}>집행 확정</button>
            {existing && month < thisMonth && <button className="secondary" disabled={saving} onClick={() => save("closed")}>마감</button>}
          </div>
          {message && <small className="viz-sub">{message}</small>}
          {existing && <button className="link-button danger" onClick={() => { if (window.confirm(`${month} 믹스를 삭제할까요?`)) void onDelete(existing); }}>이 믹스 삭제</button>}
        </article>
      </div>

      <article className="viz-card">
        <div className="viz-head"><span className="viz-title">믹스 이력</span></div>
        <div className="table-wrap"><table className="campaign-table"><thead><tr><th>월</th><th>상태</th><th>총 예산</th><th>목표 ROAS</th>{CHANNEL_ORDER.map((c) => <th key={c}>{CHANNEL_LABEL[c]}</th>)}</tr></thead>
          <tbody>{mixes.length ? mixes.map((mix) => <tr key={mix.id} onClick={() => setMonth(mix.month)} className={mix.month === month ? "selected-row" : ""}>
            <td><b>{mix.month}</b></td><td>{STATUS_LABEL[mix.status]}</td><td>{won.format(mixTotalBudget(mix))}</td><td>{mix.targetRoas}%</td>
            {CHANNEL_ORDER.map((c) => <td key={c}>{mix.channels[c]?.budget ? won.format(mix.channels[c]!.budget) : "–"}</td>)}
          </tr>) : <tr><td colSpan={4 + CHANNEL_ORDER.length}>저장된 믹스가 없습니다.</td></tr>}</tbody></table></div>
      </article>
    </section>
  );
}

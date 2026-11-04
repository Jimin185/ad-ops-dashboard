"use client";

import { useEffect, useMemo, useState } from "react";
import type { AdAccount, Channel } from "@/lib/types";
import type { Advertiser } from "@/lib/mix";
import { CHANNEL_LABEL, CHANNEL_ORDER } from "./report-view";

type Row = { channel: Channel; accountId: string; month: string; campaignId: string; campaignName: string; product: string; imp: number; clk: number; cost: number; conv: number; revenue: number };
type Post = { id: string; author: string; advertiser: string; channel: string; product: string; title: string; body: string; createdAt: string };
type Sum = { imp: number; clk: number; cost: number; conv: number; revenue: number };

const won = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
const compact = (v: number) => v >= 100_000_000 ? `${(v / 100_000_000).toFixed(1)}억` : v >= 10_000 ? `${Math.round(v / 10_000).toLocaleString()}만` : Math.round(v).toLocaleString();
const zero = (): Sum => ({ imp: 0, clk: 0, cost: 0, conv: 0, revenue: 0 });
const add = (a: Sum, r: Sum) => { a.imp += r.imp; a.clk += r.clk; a.cost += r.cost; a.conv += r.conv; a.revenue += r.revenue; return a; };
const kpi = (s: Sum) => ({ ctr: s.imp ? s.clk / s.imp * 100 : 0, cpc: s.clk ? s.cost / s.clk : 0, cvr: s.clk ? s.conv / s.clk * 100 : 0, cpa: s.conv ? s.cost / s.conv : 0, roas: s.cost ? s.revenue / s.cost * 100 : 0 });
const quantile = (values: number[], q: number) => { if (!values.length) return 0; const v = [...values].sort((a, b) => a - b); const i = (v.length - 1) * q; const lo = Math.floor(i), hi = Math.ceil(i); return v[lo] + (v[hi] - v[lo]) * (i - lo); };
const SERIES: Record<Channel, string> = { naver_sa: "var(--series-1)", naver_gfa: "var(--series-2)", meta: "var(--series-3)", google_ads: "var(--series-4)" };

export function InsightsView({ advertisers, accounts, apiFetch, onAsk }: { advertisers: Advertiser[]; accounts: AdAccount[]; apiFetch: (url: string, init?: RequestInit) => Promise<Response>; onAsk: (prompt: string) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [progress, setProgress] = useState<string>("");
  const [error, setError] = useState("");
  const [month, setMonth] = useState("ytd");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [trendAdvertiser, setTrendAdvertiser] = useState(advertisers[0]?.id || "");
  const allKeys = useMemo(() => [...new Set(advertisers.flatMap((a) => a.accountKeys))], [advertisers]);
  const ownerOf = useMemo(() => { const m = new Map<string, string>(); for (const a of advertisers) for (const k of a.accountKeys) m.set(k, a.name); return m; }, [advertisers]);

  useEffect(() => {
    if (!allKeys.length) return;
    let cancelled = false;
    (async () => {
      setError("");
      for (let attempt = 0; attempt < 40 && !cancelled; attempt++) {
        const r = await apiFetch("/api/monthly", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accounts: allKeys }) });
        const data = await r.json();
        if (cancelled) return;
        if (!r.ok) { setError(data.error || "불러오지 못했습니다."); setProgress(""); return; }
        if (data.status === "ready") { setRows(data.rows || []); setProgress(""); if (data.errors?.length) setError(data.errors.map((e: any) => `${e.account}: ${e.message}`).join(" / ")); return; }
        setProgress(`월별 데이터 적재 중… 완료 ${data.done}개 계정 · 남은 ${data.pending}개 계정 (처음 한 번만 오래 걸려요)`);
      }
    })().catch(() => !cancelled && setError("불러오지 못했습니다."));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allKeys.join(",")]);

  const months = useMemo(() => [...new Set(rows.map((r) => r.month))].sort(), [rows]);
  const scoped = rows.filter((r) => month === "ytd" || r.month === month);

  // 광고상품 벤치마크: 채널×광고상품 전체 합계 + 광고주별 분포
  const bench = useMemo(() => {
    const groups = new Map<string, { channel: Channel; product: string; total: Sum; byAdvertiser: Map<string, Sum> }>();
    for (const r of scoped) {
      const key = `${r.channel}|${r.product || "기타"}`;
      const g = groups.get(key) || { channel: r.channel, product: r.product || "기타", total: zero(), byAdvertiser: new Map() };
      add(g.total, r);
      const owner = ownerOf.get(`${r.channel}:${r.accountId}`) || "(매핑 해제됨)";
      g.byAdvertiser.set(owner, add(g.byAdvertiser.get(owner) || zero(), r));
      groups.set(key, g);
    }
    return [...groups.entries()].map(([key, g]) => {
      const advRoas = [...g.byAdvertiser.values()].filter((s) => s.cost > 100_000).map((s) => kpi(s).roas);
      const advCpc = [...g.byAdvertiser.values()].filter((s) => s.clk > 100).map((s) => kpi(s).cpc);
      return { key, ...g, k: kpi(g.total), advertisers: g.byAdvertiser.size, roasMedian: quantile(advRoas, 0.5), roasTop: quantile(advRoas, 0.75), cpcMedian: quantile(advCpc, 0.5) };
    }).filter((g) => g.total.cost > 0).sort((a, b) => CHANNEL_ORDER.indexOf(a.channel) - CHANNEL_ORDER.indexOf(b.channel) || b.total.cost - a.total.cost);
  }, [scoped, ownerOf]);

  // 광고주 월별 추이
  const trendKeys = advertisers.find((a) => a.id === trendAdvertiser)?.accountKeys || [];
  const trend = useMemo(() => months.map((m) => {
    const byChannel: Partial<Record<Channel, Sum>> = {};
    for (const r of rows) if (r.month === m && trendKeys.includes(`${r.channel}:${r.accountId}`)) byChannel[r.channel] = add(byChannel[r.channel] || zero(), r);
    const total = Object.values(byChannel).reduce((a, s) => add(a, s!), zero());
    return { month: m, byChannel, total };
  }), [rows, months, trendKeys]);
  const maxCost = Math.max(1, ...trend.map((t) => t.total.cost));

  const benchSummary = bench.slice(0, 20).map((g) => `${CHANNEL_LABEL[g.channel]} ${g.product}: 광고주 ${g.advertisers}곳, 광고비 ${Math.round(g.total.cost)}, CTR ${g.k.ctr.toFixed(2)}%, CPC ${Math.round(g.k.cpc)}, CVR ${g.k.cvr.toFixed(2)}%, ROAS ${Math.round(g.k.roas)}% (광고주 중앙값 ${Math.round(g.roasMedian)}%, 상위25% ${Math.round(g.roasTop)}%)`).join("\n");

  return (
    <section className="report">
      {progress && <div className="viz-card loading-card"><b>{progress}</b><span className="viz-sub">매핑된 모든 계정의 올해 1월~지난달 데이터를 한 번 저장해요. 이후엔 저장된 데이터로 바로 열리고, 매달 마감되면 자동으로 추가돼요.</span></div>}
      {error && <div className="connection-error"><b>일부 계정 적재 실패</b><span>{error}</span></div>}
      {!allKeys.length && <div className="empty-state"><b>매핑된 계정이 없습니다.</b><span>광고주를 만들고 계정을 매핑하면 월별 데이터가 쌓여요.</span></div>}

      {rows.length > 0 && <>
        <div className="report-toolbar">
          <label className="sort-select">기간 <select value={month} onChange={(e) => setMonth(e.target.value)}><option value="ytd">올해 누적</option>{months.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
          <button className="secondary" onClick={() => onAsk(`광고인사이트 벤치마크(${month === "ytd" ? "올해 누적" : month})를 보고 광고상품별로 잘하는 운영 패턴과 개선이 필요한 광고주, 다음 달 운영 제안을 정리해줘.\n${benchSummary}`)}>✦ AI 벤치마크 해설</button>
        </div>

        <article className="viz-card table-card">
          <div className="viz-head" style={{ padding: "16px 18px 0" }}><span className="viz-title">광고상품별 벤치마크 · 우리 팀 전체 광고주</span><span className="viz-sub">행을 누르면 광고주별 순위</span></div>
          <div className="table-wrap"><table className="campaign-table bench-table">
            <thead><tr><th>채널</th><th>광고상품</th><th>광고주</th><th>광고비</th><th>CTR</th><th>CPC</th><th>CVR</th><th>CPA</th><th>ROAS</th><th>ROAS 중앙값</th><th>ROAS 상위 25%</th></tr></thead>
            <tbody>{bench.map((g) => [
              <tr key={g.key} onClick={() => setExpanded(expanded === g.key ? null : g.key)}>
                <td><span className={`channel ${g.channel}`}>{CHANNEL_LABEL[g.channel]}</span></td><td><b>{g.product}</b></td><td>{g.advertisers}</td><td>{compact(g.total.cost)}</td>
                <td>{g.k.ctr.toFixed(2)}%</td><td>{won.format(g.k.cpc)}</td><td>{g.k.cvr.toFixed(2)}%</td><td>{g.k.cpa ? won.format(g.k.cpa) : "–"}</td><td><b>{Math.round(g.k.roas)}%</b></td><td>{Math.round(g.roasMedian)}%</td><td>{Math.round(g.roasTop)}%</td>
              </tr>,
              expanded === g.key && <tr key={`${g.key}-x`} className="expand-row"><td colSpan={11}>
                <ol className="rank-list">{[...g.byAdvertiser.entries()].map(([name, s]) => ({ name, s, k: kpi(s) })).sort((a, b) => b.k.roas - a.k.roas).map(({ name, s, k }) =>
                  <li key={name}><b>{name}</b><span>광고비 {compact(s.cost)} · CTR {k.ctr.toFixed(2)}% · CPC {won.format(k.cpc)} · CVR {k.cvr.toFixed(2)}% · ROAS <b className={k.roas >= g.roasMedian ? "good-text" : "bad-text"}>{Math.round(k.roas)}%</b></span></li>)}</ol>
              </td></tr>,
            ])}</tbody>
          </table></div>
          <small className="viz-sub" style={{ padding: "0 18px 14px", display: "block" }}>중앙값·상위 25%는 광고비 10만 원 이상인 광고주 기준. 네이버 SA 매출은 SA 통계의 전체 전환매출이라 다른 매체보다 높게 나올 수 있어요.</small>
        </article>

        <article className="viz-card">
          <div className="viz-head"><span className="viz-title">광고주 월별 추이</span>
            <select className="mini-select" value={trendAdvertiser} onChange={(e) => setTrendAdvertiser(e.target.value)}>{advertisers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          <div className="month-bars">{trend.map((t) => <div key={t.month} className="month-bar">
            <div className="month-stack" title={`${t.month} ${won.format(t.total.cost)}`}>{CHANNEL_ORDER.filter((c) => t.byChannel[c]?.cost).map((c) => <div key={c} style={{ height: `${t.byChannel[c]!.cost / maxCost * 100}%`, background: SERIES[c] }} />)}</div>
            <b>{compact(t.total.cost)}</b><small>ROAS {Math.round(kpi(t.total).roas)}%</small><span>{t.month.slice(5)}월</span>
          </div>)}</div>
          <div className="legend">{CHANNEL_ORDER.map((c) => <span key={c}><i style={{ background: SERIES[c] }} />{CHANNEL_LABEL[c]}</span>)}</div>
        </article>
      </>}

      <Board advertisers={advertisers} />
    </section>
  );
}

function Board({ advertisers }: { advertisers: Advertiser[] }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [form, setForm] = useState({ author: "", advertiser: "", channel: "", product: "", title: "", body: "" });
  const [error, setError] = useState("");
  const load = () => fetch("/api/board", { cache: "no-store" }).then((r) => r.json()).then((d) => { if (d.error) setError(d.error); else setPosts(d.posts || []); });
  useEffect(() => { try { setForm((f) => ({ ...f, author: localStorage.getItem("adops-author") || "" })); } catch { /* 저장 불가 */ } void load(); }, []);

  async function submit() {
    setError("");
    try { localStorage.setItem("adops-author", form.author); } catch { /* 저장 불가 */ }
    const r = await fetch("/api/board", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const d = await r.json();
    if (!r.ok) return setError(d.error || "등록하지 못했습니다.");
    setForm((f) => ({ ...f, title: "", body: "" }));
    void load();
  }

  return (
    <article className="viz-card board">
      <div className="viz-head"><span className="viz-title">팀 인사이트 보드</span><span className="viz-sub">AE들이 발견한 성과 포인트·테스트 결과를 공유해요</span></div>
      <div className="board-form">
        <input className="note-input" placeholder="작성자" value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} />
        <select className="mini-select" value={form.advertiser} onChange={(e) => setForm({ ...form, advertiser: e.target.value })}><option value="">광고주 (선택)</option>{advertisers.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}</select>
        <select className="mini-select" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}><option value="">채널 (선택)</option>{CHANNEL_ORDER.map((c) => <option key={c} value={CHANNEL_LABEL[c]}>{CHANNEL_LABEL[c]}</option>)}</select>
        <input className="note-input" placeholder="광고상품 (예: PMax, 쇼핑검색)" value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })} />
        <input className="note-input wide" placeholder="제목 (예: 쇼핑검색 상품명에 '무료배송' 넣었더니 CTR +30%)" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <textarea rows={3} placeholder="내용: 무엇을 바꿨고, 기간과 결과가 어땠는지" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        <button className="primary" disabled={!form.author.trim() || !form.title.trim()} onClick={() => void submit()}>공유</button>
      </div>
      {error && <small className="sa-status error">{error}</small>}
      <ul className="board-list">{posts.map((p) => <li key={p.id}>
        <div className="board-meta">{[p.advertiser, p.channel, p.product].filter(Boolean).map((t) => <span key={t} className="tag">{t}</span>)}<small>{p.author} · {new Date(p.createdAt).toLocaleDateString("ko-KR")}</small>
          <button className="link-button danger" onClick={() => { if (window.confirm("이 글을 삭제할까요?")) void fetch(`/api/board?id=${p.id}`, { method: "DELETE" }).then(load); }}>삭제</button></div>
        <b>{p.title}</b>{p.body && <p>{p.body}</p>}
      </li>)}</ul>
      {!posts.length && !error && <span className="viz-sub">아직 공유된 인사이트가 없어요. 첫 글을 남겨보세요.</span>}
    </article>
  );
}

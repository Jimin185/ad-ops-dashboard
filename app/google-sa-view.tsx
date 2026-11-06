"use client";

import { useEffect, useMemo, useState } from "react";

const won = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
type Metrics = { imp: number; clk: number; cost: number; conv: number; revenue: number };
type Base = Metrics & { adgroupId: string; adgroup: string; active?: boolean };
type Insights = {
  status: "ready"; since: string; until: string;
  typeTotals: Array<Metrics & { type: string; label: string }>;
  adgroups: Array<Base & { campaignId: string; campaign: string }>;
  keywords: Array<Base & { id: string; keyword: string; matchType: string }>;
  searchTerms: Array<Base & { term: string }>;
  ads: Array<Base & { id: string; headline?: string; description?: string; landingUrl?: string }>;
};
type Tab = "adgroups" | "keywords" | "terms" | "ads";
type SortKey = "cost" | "revenue" | "roas" | "conv" | "clk" | "ctr" | "cpc";
type Period = "this_month" | "last_month" | "last_7" | "last_30";

const roas = (m: Metrics) => m.cost ? m.revenue / m.cost * 100 : 0;
const ctr = (m: Metrics) => m.imp ? m.clk / m.imp * 100 : 0;
const cpc = (m: Metrics) => m.clk ? m.cost / m.clk : 0;
const metricOf: Record<SortKey, (m: Metrics) => number> = { cost: (m) => m.cost, revenue: (m) => m.revenue, roas, conv: (m) => m.conv, clk: (m) => m.clk, ctr, cpc };
const MATCH_LABEL: Record<string, string> = { EXACT: "일치", PHRASE: "구문", BROAD: "확장" };

function kst(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}
// 구글은 당일 데이터도 조회된다 (집계 지연만 있음)
function rangeOf(period: Period) {
  const today = kst();
  if (period === "last_7") return { since: kst(-7), until: today };
  if (period === "last_30") return { since: kst(-30), until: today };
  const [y, m] = today.split("-").map(Number);
  if (period === "last_month") {
    return { since: new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10), until: new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10) };
  }
  return { since: `${today.slice(0, 7)}-01`, until: today };
}

function MetricCells({ m }: { m: Metrics }) {
  const r = roas(m);
  return <>
    <td>{m.imp.toLocaleString()}</td><td>{m.clk.toLocaleString()}</td><td>{ctr(m).toFixed(2)}%</td><td>{won.format(cpc(m))}</td>
    <td><b>{won.format(m.cost)}</b></td><td>{Math.round(m.conv).toLocaleString()}</td><td>{won.format(m.revenue)}</td>
    <td className={m.cost ? (r >= 300 ? "good-text" : r < 100 ? "bad-text" : "") : ""}><b>{m.cost ? `${Math.round(r).toLocaleString()}%` : "–"}</b></td>
  </>;
}
const METRIC_HEAD = ["노출", "클릭", "CTR", "CPC", "광고비", "전환", "전환가치", "ROAS"];

export function GoogleSaView({ accountIds, apiFetch, onOpenCampaign }: { onOpenCampaign?: (campaignId: string) => void; accountIds: Array<{ id: string; name: string }>; apiFetch: (url: string, init?: RequestInit) => Promise<Response> }) {
  const [account, setAccount] = useState(accountIds[0]?.id || "");
  const [period, setPeriod] = useState<Period>("this_month");
  const [tab, setTab] = useState<Tab>("adgroups");
  const [group, setGroup] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("cost");
  const [hideInactive, setHideInactive] = useState(true);
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const range = useMemo(() => rangeOf(period), [period]);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    setError(""); setData(null); setLoading(true);
    apiFetch("/api/google-sa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: account, ...range }) })
      .then((r) => r.json().then((body) => { if (cancelled) return; if (!r.ok) setError(body.error || "불러오지 못했습니다."); else setData(body); }))
      .catch(() => !cancelled && setError("불러오지 못했습니다."))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, range.since, range.until]);

  const q = query.trim().toLowerCase();
  const filterBase = <T extends Base>(rows: T[], text: (r: T) => string) => rows
    .filter((r) => (group === "all" || r.adgroupId === group) && (!q || text(r).toLowerCase().includes(q)) && (!hideInactive || q || r.active !== false))
    .sort((a, b) => metricOf[sort](b) - metricOf[sort](a));
  const groups = useMemo(() => (data?.adgroups || []).slice().sort((a, b) => b.cost - a.cost), [data]);

  if (!accountIds.length) return <section className="report"><div className="empty-state"><b>구글애즈 계정이 매핑되어 있지 않습니다.</b><span>계정 매핑에서 구글애즈 계정을 연결해 주세요.</span></div></section>;

  return (
    <section className="report">
      <div className="report-toolbar">
        <nav className="channel-tabs">{([["this_month", "이번 달"], ["last_month", "지난 달"], ["last_7", "최근 7일"], ["last_30", "최근 30일"]] as Array<[Period, string]>).map(([k, l]) => <button key={k} className={period === k ? "active" : ""} onClick={() => setPeriod(k)}>{l}</button>)}</nav>
        <span className="report-range">
          {accountIds.length > 1 && <select className="mini-select" value={account} onChange={(e) => setAccount(e.target.value)}>{accountIds.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}
          {" "}{range.since} ~ {range.until} (오늘 포함 · 당일은 집계 지연 가능)
        </span>
      </div>
      {loading && <div className="viz-card loading-card"><b><span className="spinner inline" /> 구글 검색 성과를 불러오는 중…</b></div>}
      {error && <div className="connection-error"><b>구글 검색 분석 오류</b><span>{error}</span></div>}

      {data && <>
        <div className="kpi-row">{data.typeTotals.filter((t) => t.cost > 0).slice(0, 4).map((t) => <article key={t.type} className="viz-card kpi">
          <span className="viz-title">{t.label}</span><b>{won.format(t.cost)}</b>
          <small className="viz-sub">전환가치 {won.format(t.revenue)} · ROAS {Math.round(roas(t))}% · 전환 {Math.round(t.conv).toLocaleString()}</small>
        </article>)}</div>
        <small className="viz-sub">아래 표는 검색(SEARCH) 캠페인 기준이에요. PMax·영상 등 다른 유형은 위 유형별 합계로만 보여요 (키워드·검색어 차원이 제공되지 않아요).</small>

        <nav className="view-tabs sub-tabs">{([["adgroups", "광고그룹"], ["keywords", "키워드"], ["terms", "검색어"], ["ads", "광고문안"]] as Array<[Tab, string]>).map(([k, l]) => <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l}</button>)}</nav>

        <div className="creative-toolbar">
          {tab !== "adgroups" && <select className="mini-select group-select" value={group} onChange={(e) => setGroup(e.target.value)}><option value="all">전체 광고그룹</option>{groups.map((g) => <option key={g.adgroupId} value={g.adgroupId}>{g.adgroup} ({won.format(g.cost)})</option>)}</select>}
          <input className="account-search" type="search" placeholder={tab === "terms" ? "검색어 검색" : "이름 검색 (꺼진 항목 포함)"} value={query} onChange={(e) => setQuery(e.target.value)} />
          {tab !== "terms" && <label className="toggle"><input type="checkbox" checked={!hideInactive} onChange={(e) => setHideInactive(!e.target.checked)} /> 꺼진 항목 포함</label>}
          <label className="sort-select">정렬 <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>{([["cost", "광고비"], ["revenue", "전환가치"], ["roas", "ROAS"], ["conv", "전환"], ["clk", "클릭"], ["ctr", "CTR"], ["cpc", "CPC"]] as Array<[SortKey, string]>).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        </div>

        <div className="viz-card table-card"><div className="table-wrap">
          {tab === "adgroups" && <table className="campaign-table sa-table"><thead><tr><th>캠페인 › 광고그룹</th>{METRIC_HEAD.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{filterBase(data.adgroups, (r) => `${r.campaign} ${r.adgroup}`).map((r) => <tr key={r.adgroupId} className={r.active === false ? "inactive-row" : ""} onClick={() => { setGroup(r.adgroupId); setTab("keywords"); }}>
              <td><b>{r.adgroup}</b><button className="link-button campaign-link small" onClick={(e) => { e.stopPropagation(); onOpenCampaign?.(`google_ads|${account}|${r.campaignId}`); }}>{r.campaign} ↗</button></td><MetricCells m={r} /></tr>)}</tbody></table>}

          {tab === "keywords" && <table className="campaign-table sa-table"><thead><tr><th>키워드</th><th>광고그룹</th>{METRIC_HEAD.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{filterBase(data.keywords, (r) => `${r.keyword} ${r.adgroup}`).slice(0, 300).map((r) => <tr key={`${r.adgroupId}|${r.id}`} className={r.active === false ? "inactive-row" : ""}>
              <td><b>{r.keyword}</b><small className="viz-sub"> {MATCH_LABEL[r.matchType] || ""}</small></td><td><small>{r.adgroup}</small></td><MetricCells m={r} /></tr>)}</tbody></table>}

          {tab === "terms" && <table className="campaign-table sa-table"><thead><tr><th>검색어</th><th>광고그룹</th>{METRIC_HEAD.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{filterBase(data.searchTerms.map((r) => ({ ...r, active: true })), (r) => r.term).slice(0, 400).map((r, i) => <tr key={`${r.adgroupId}|${r.term}|${i}`}>
              <td><b>{r.term}</b></td><td><small>{r.adgroup}</small></td><MetricCells m={r} /></tr>)}</tbody></table>}

          {tab === "ads" && <table className="campaign-table sa-table"><thead><tr><th>광고 (제목 · 설명)</th><th>광고그룹</th>{METRIC_HEAD.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{filterBase(data.ads, (r) => `${r.headline || ""} ${r.description || ""} ${r.adgroup}`).slice(0, 300).map((r) => <tr key={`${r.adgroupId}|${r.id}`} className={r.active === false ? "inactive-row" : ""}>
              <td className="ad-copy"><b>{r.headline || `광고 ${r.id}`}</b><small>{r.description}</small>{r.landingUrl && <small className="id"><a href={r.landingUrl} target="_blank" rel="noreferrer">🔗 {r.landingUrl.replace(/^https?:\/\//, "").slice(0, 40)}</a></small>}</td>
              <td><small>{r.adgroup}</small></td><MetricCells m={r} /></tr>)}</tbody></table>}
        </div></div>
        {(tab === "keywords" || tab === "ads" || tab === "terms") && <small className="viz-sub">표는 정렬 기준 상위 항목까지 보여줍니다 (키워드 1,000 · 검색어 500 · 광고 500개 조회).</small>}
      </>}
    </section>
  );
}

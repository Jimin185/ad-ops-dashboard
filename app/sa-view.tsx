"use client";

import { useEffect, useMemo, useState } from "react";

const won = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
const TYPE_LABEL: Record<string, string> = { WEB_SITE: "파워링크", SHOPPING: "쇼핑검색", BRAND_SEARCH: "브랜드검색", POWER_CONTENTS: "파워콘텐츠", PLACE: "플레이스" };
type Metrics = { imp: number; clk: number; cost: number; conv: number; revenue: number; cart: number };
type Base = Metrics & { campaign: string; type: string; adgroupId: string; adgroup: string; active?: boolean };
type Insights = {
  status: "ready"; since: string; until: string;
  typeTotals: Array<Metrics & { type: string }>;
  adgroups: Base[];
  keywords: Array<Base & { id: string; keyword: string }>;
  powerlinkAds: Array<Base & { id: string; headline?: string; description?: string }>;
  searchTerms: Array<Base & { term: string }>;
  products: Array<Metrics & { name: string; image?: string; price?: number; category?: string; groups: string[] }>;
};
type Tab = "adgroups" | "keywords" | "ads" | "terms" | "products";
type SortKey = "cost" | "revenue" | "roas" | "conv" | "clk" | "ctr" | "cpc";
type Period = "this_month" | "last_month" | "last_7" | "last_30";

const roas = (m: Metrics) => m.cost ? m.revenue / m.cost * 100 : 0;
const ctr = (m: Metrics) => m.imp ? m.clk / m.imp * 100 : 0;
const cpc = (m: Metrics) => m.clk ? m.cost / m.clk : 0;
const metricOf: Record<SortKey, (m: Metrics) => number> = { cost: (m) => m.cost, revenue: (m) => m.revenue, roas, conv: (m) => m.conv, clk: (m) => m.clk, ctr, cpc };

function kst(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}
// 네이버 리포트는 어제까지 확정. 오늘은 제외한다.
function rangeOf(period: Period) {
  const yesterday = kst(-1);
  if (period === "last_7") return { since: kst(-7), until: yesterday };
  if (period === "last_30") return { since: kst(-30), until: yesterday };
  const [y, m] = kst().split("-").map(Number);
  if (period === "last_month") {
    const first = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
    return { since: first, until: last };
  }
  const first = `${kst().slice(0, 7)}-01`;
  return { since: first, until: yesterday < first ? first : yesterday };
}

function MetricCells({ m }: { m: Metrics }) {
  const r = roas(m);
  return <>
    <td>{m.imp.toLocaleString()}</td><td>{m.clk.toLocaleString()}</td><td>{ctr(m).toFixed(2)}%</td><td>{won.format(cpc(m))}</td>
    <td><b>{won.format(m.cost)}</b></td><td>{m.conv.toLocaleString()}{m.cart ? <small className="viz-sub"> · 장바구니 {m.cart}</small> : null}</td><td>{won.format(m.revenue)}</td>
    <td className={m.cost ? (r >= 300 ? "good-text" : r < 100 ? "bad-text" : "") : ""}><b>{m.cost ? `${Math.round(r).toLocaleString()}%` : "–"}</b></td>
  </>;
}
const METRIC_HEAD = ["노출", "클릭", "CTR", "CPC", "광고비", "구매", "구매매출", "ROAS"];

export function SaView({ accountIds, apiFetch }: { accountIds: Array<{ id: string; name: string }>; apiFetch: (url: string, init?: RequestInit) => Promise<Response> }) {
  const [account, setAccount] = useState(accountIds[0]?.id || "");
  const [period, setPeriod] = useState<Period>("this_month");
  const [tab, setTab] = useState<Tab>("adgroups");
  const [group, setGroup] = useState("all");
  const [type, setType] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("cost");
  const [hideInactive, setHideInactive] = useState(true);
  const [data, setData] = useState<Insights | null>(null);
  const [progress, setProgress] = useState<{ ready: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const range = useMemo(() => rangeOf(period), [period]);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    setError(""); setData(null); setProgress({ ready: 0, total: 0 });
    (async () => {
      // 날짜별 리포트가 다 만들어질 때까지 이어서 호출 (이미 받은 날짜는 서버에 저장돼 건너뜀)
      for (let attempt = 0; attempt < 30 && !cancelled; attempt++) {
        const response = await apiFetch("/api/sa-insights", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customerId: account, ...range, refresh: reloadKey > 0 && attempt === 0 }) });
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) { setError(body.error || "불러오지 못했습니다."); setProgress(null); return; }
        if (body.status === "ready") { setData(body); setProgress(null); return; }
        setProgress({ ready: body.ready, total: body.total });
      }
    })().catch(() => !cancelled && setError("불러오지 못했습니다."));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, range.since, range.until, reloadKey]);

  const q = query.trim().toLowerCase();
  const filterBase = <T extends Base>(rows: T[], text: (r: T) => string) => rows
    .filter((r) => (group === "all" || r.adgroupId === group) && (type === "all" || r.type === type) && (!q || text(r).toLowerCase().includes(q)) && (!hideInactive || q || r.active !== false))
    .sort((a, b) => metricOf[sort](b) - metricOf[sort](a));
  const groups = useMemo(() => (data?.adgroups || []).filter((g) => type === "all" || g.type === type).sort((a, b) => b.cost - a.cost), [data, type]);

  const sortSelect = <label className="sort-select">정렬 <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>{([["cost", "광고비"], ["revenue", "구매매출"], ["roas", "ROAS"], ["conv", "구매"], ["clk", "클릭"], ["ctr", "CTR"], ["cpc", "CPC"]] as Array<[SortKey, string]>).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>;

  if (!accountIds.length) return <section className="report"><div className="empty-state"><b>네이버 SA 계정이 매핑되어 있지 않습니다.</b><span>계정 매핑에서 SA 계정을 연결해 주세요.</span></div></section>;

  return (
    <section className="report">
      <div className="report-toolbar">
        <nav className="channel-tabs">{([["this_month", "이번 달"], ["last_month", "지난 달"], ["last_7", "최근 7일"], ["last_30", "최근 30일"]] as Array<[Period, string]>).map(([k, l]) => <button key={k} className={period === k ? "active" : ""} onClick={() => setPeriod(k)}>{l}</button>)}</nav>
        <span className="report-range">
          {accountIds.length > 1 && <select className="mini-select" value={account} onChange={(e) => setAccount(e.target.value)}>{accountIds.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}
          {" "}{range.since} ~ {range.until} (어제까지)
          <button className="link-button" disabled={Boolean(progress)} onClick={() => setReloadKey((k) => k + 1)}>새로 가져오기</button>
        </span>
      </div>
      {progress && <div className="viz-card loading-card"><b>네이버 리포트를 만드는 중… {progress.total ? `${progress.ready}/${progress.total}일` : ""}</b><span className="viz-sub">처음 조회하는 날짜는 네이버가 리포트를 만드는 데 시간이 걸려요. 한 번 받은 날짜는 저장돼서 다음부터는 바로 열려요.</span>{progress.total ? <div className="pace-track"><div className="pace-fill ok" style={{ width: `${progress.ready / progress.total * 100}%` }} /></div> : null}</div>}
      {error && <div className="connection-error"><b>SA 분석 오류</b><span>{error}</span></div>}

      {data && <>
        <div className="kpi-row">{data.typeTotals.filter((t) => t.cost > 0).sort((a, b) => b.cost - a.cost).slice(0, 4).map((t) => <article key={t.type} className="viz-card kpi">
          <span className="viz-title">{TYPE_LABEL[t.type] || t.type}</span><b>{won.format(t.cost)}</b>
          <small className="viz-sub">구매매출 {won.format(t.revenue)} · ROAS {Math.round(roas(t))}% · 구매 {t.conv.toLocaleString()}</small>
        </article>)}</div>
        <small className="viz-sub">구매매출은 구매 전환만 집계했어요 (장바구니 등 다른 전환은 제외). 그래서 리포트 탭의 SA 매출보다 작게 나옵니다.</small>

        <nav className="view-tabs sub-tabs">{([["adgroups", "광고그룹"], ["keywords", "키워드"], ["ads", "파워링크 소재"], ["terms", "쇼핑 검색어"], ["products", "제품"]] as Array<[Tab, string]>).map(([k, l]) => <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l}</button>)}</nav>

        <div className="creative-toolbar">
          {tab !== "products" && <select className="mini-select" value={type} onChange={(e) => { setType(e.target.value); setGroup("all"); }}><option value="all">전체 유형</option>{[...new Set(data.adgroups.map((g) => g.type))].map((t) => <option key={t} value={t}>{TYPE_LABEL[t] || t}</option>)}</select>}
          {(tab === "keywords" || tab === "ads" || tab === "terms") && <select className="mini-select group-select" value={group} onChange={(e) => setGroup(e.target.value)}><option value="all">전체 광고그룹</option>{groups.map((g) => <option key={g.adgroupId} value={g.adgroupId}>{g.adgroup} ({won.format(g.cost)})</option>)}</select>}
          <input className="account-search" type="search" placeholder={tab === "terms" ? "검색어 검색" : tab === "products" ? "제품명 검색" : "이름 검색 (꺼진 항목 포함)"} value={query} onChange={(e) => setQuery(e.target.value)} />
          {tab !== "terms" && tab !== "products" && <label className="toggle"><input type="checkbox" checked={!hideInactive} onChange={(e) => setHideInactive(!e.target.checked)} /> 꺼진 항목 포함</label>}
          {sortSelect}
        </div>

        <div className="viz-card table-card"><div className="table-wrap">
          {tab === "adgroups" && <table className="campaign-table sa-table"><thead><tr><th>유형</th><th>캠페인 › 광고그룹</th>{METRIC_HEAD.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{filterBase(data.adgroups, (r) => `${r.campaign} ${r.adgroup}`).map((r) => <tr key={r.adgroupId} className={r.active === false ? "inactive-row" : ""} onClick={() => { setGroup(r.adgroupId); setType(r.type); setTab(r.type === "SHOPPING" ? "terms" : "keywords"); }}>
              <td>{TYPE_LABEL[r.type] || r.type}</td><td><b>{r.adgroup}</b><small className="id">{r.campaign}</small></td><MetricCells m={r} /></tr>)}</tbody></table>}

          {tab === "keywords" && <table className="campaign-table sa-table"><thead><tr><th>키워드</th><th>광고그룹</th>{METRIC_HEAD.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{filterBase(data.keywords, (r) => `${r.keyword} ${r.adgroup}`).slice(0, 300).map((r) => <tr key={`${r.adgroupId}|${r.id}`} className={r.active === false ? "inactive-row" : ""}>
              <td><b>{r.keyword}</b></td><td><small>{r.adgroup}</small></td><MetricCells m={r} /></tr>)}</tbody></table>}

          {tab === "ads" && <table className="campaign-table sa-table"><thead><tr><th>소재 (제목 · 설명)</th><th>광고그룹</th>{METRIC_HEAD.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{filterBase(data.powerlinkAds, (r) => `${r.headline || ""} ${r.description || ""} ${r.adgroup}`).slice(0, 300).map((r) => <tr key={`${r.adgroupId}|${r.id}`} className={r.active === false ? "inactive-row" : ""}>
              <td className="ad-copy"><b>{r.headline || "(제목 미조회)"}</b><small>{r.description}</small></td><td><small>{r.adgroup}</small></td><MetricCells m={r} /></tr>)}</tbody></table>}

          {tab === "terms" && <table className="campaign-table sa-table"><thead><tr><th>검색어</th><th>광고그룹</th>{METRIC_HEAD.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{filterBase(data.searchTerms.map((r) => ({ ...r, active: true })), (r) => r.term).slice(0, 400).map((r, i) => <tr key={`${r.adgroupId}|${r.term}|${i}`}>
              <td><b>{r.term}</b></td><td><small>{r.adgroup}</small></td><MetricCells m={r} /></tr>)}</tbody></table>}

          {tab === "products" && <table className="campaign-table sa-table"><thead><tr><th>제품</th><th>판매가</th>{METRIC_HEAD.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{data.products.filter((p) => !q || p.name.toLowerCase().includes(q)).sort((a, b) => metricOf[sort](b) - metricOf[sort](a)).map((p) => <tr key={p.name}>
              <td className="product-cell">{p.image ? <img src={p.image} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="no-img" />}<div><b>{p.name}</b><small className="id">{p.category} · 그룹 {p.groups.length}개</small></div></td>
              <td>{p.price ? won.format(p.price) : "–"}</td><MetricCells m={p} /></tr>)}</tbody></table>}
        </div></div>
        {(tab === "keywords" || tab === "ads") && <small className="viz-sub">광고비 상위 항목은 이름까지, 나머지는 성과만 표시돼요. 표는 정렬 기준 상위 300개까지 보여줍니다.</small>}
      </>}
    </section>
  );
}

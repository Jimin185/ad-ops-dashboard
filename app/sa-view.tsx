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

export function SaView({ accountIds, apiFetch, onOpenCampaign }: { onOpenCampaign?: (campaignId: string) => void; accountIds: Array<{ id: string; name: string }>; apiFetch: (url: string, init?: RequestInit) => Promise<Response> }) {
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

  // ---- 파워링크 소재 관리: 그룹을 고르면 실제 소재(랜딩 포함)·확장소재를 받아와 수정/추가 ----
  type LiveAd = { id: string; headline: string; description: string; pcUrl: string; mobileUrl: string; inspect: string; on: boolean };
  type LiveExt = { id: string; type: string; on: boolean; inspect: string; content: string };
  const [liveAds, setLiveAds] = useState<{ adgroupId: string; ads: LiveAd[]; extensions: LiveExt[] } | null>(null);
  const [adBusy, setAdBusy] = useState("");
  const EXT_LABEL: Record<string, string> = { POWER_LINK_IMAGE: "파워링크 이미지", SUB_LINKS: "서브링크", IMAGE_SUB_LINKS: "이미지형 서브링크", PRICE_LINKS: "가격링크", PROMOTION: "프로모션", HEADLINE: "추가 제목", DESCRIPTION: "추가 설명", DESCRIPTION_EXTRA: "추가 설명+", CALCULATION: "계산", PHONE: "전화번호", LOCATION: "위치", NAVER_BLOG_REVIEW: "블로그 리뷰", BOOKING: "예약", TALK: "톡톡", WEBSITE_INFO: "웹사이트 정보", TALKTALK_CONSULTATION: "톡톡 상담" };
  async function loadLiveAds(adgroupId: string) {
    setAdBusy("소재 불러오는 중…");
    try {
      const res = await apiFetch(`/api/sa/ads?customerId=${encodeURIComponent(account)}&adgroupId=${encodeURIComponent(adgroupId)}`);
      const body = await res.json();
      if (!res.ok) { window.alert(body.error || "소재를 불러오지 못했어요."); return null; }
      const next = { adgroupId, ads: body.ads as LiveAd[], extensions: body.extensions as LiveExt[] };
      setLiveAds(next);
      return next;
    } finally { setAdBusy(""); }
  }
  function promptAdFields(base?: Partial<LiveAd>) {
    const headline = window.prompt("제목 (15자, {키워드:기본값} 치환 가능)", base?.headline || "");
    if (headline === null || !headline.trim()) return null;
    const description = window.prompt("설명 (45자)", base?.description || "");
    if (description === null || !description.trim()) return null;
    const pcUrl = window.prompt("PC 랜딩 URL", base?.pcUrl || "https://");
    if (pcUrl === null || !/^https?:\/\//.test(pcUrl)) { if (pcUrl !== null) window.alert("PC 랜딩 URL을 확인해 주세요."); return null; }
    const mobileUrl = window.prompt("모바일 랜딩 URL (비우면 PC와 동일)", base?.mobileUrl || pcUrl) || pcUrl;
    return { headline: headline.trim(), description: description.trim(), pcUrl: pcUrl.trim(), mobileUrl: mobileUrl.trim() };
  }
  async function submitAd(adgroupId: string, fields: { headline: string; description: string; pcUrl: string; mobileUrl: string }, deleteAdId?: string) {
    setAdBusy("소재 등록 중…");
    try {
      const res = await apiFetch("/api/sa/ads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customerId: account, adgroupId, deleteAdId, ...fields }) });
      const body = await res.json();
      if (!res.ok) { window.alert(body.error || "등록하지 못했어요."); return; }
      window.alert("새 소재를 등록했어요. 네이버 검수가 끝나면 노출됩니다.");
      await loadLiveAds(adgroupId);
    } finally { setAdBusy(""); }
  }
  async function editAd(adgroupId: string, ad: LiveAd) {
    const fields = promptAdFields(ad);
    if (!fields) return;
    if (!window.confirm(`B 방식으로 교체합니다:\n기존 소재를 먼저 지우고 새 소재를 등록해요 (검수 동안 이 소재 노출 공백).\n\n'${ad.headline}' → '${fields.headline}'\n진행할까요?`)) return;
    await submitAd(adgroupId, fields, ad.id);
  }
  async function addAd(adgroupId: string) {
    const current = liveAds?.adgroupId === adgroupId ? liveAds : await loadLiveAds(adgroupId);
    if (!current) return;
    let deleteAdId: string | undefined;
    if (current.ads.length >= 5) {
      const list = current.ads.map((a, i) => `${i + 1}. ${a.headline} — ${a.description.slice(0, 24)}${a.on ? "" : " (OFF)"}`).join("\n");
      const pick = window.prompt(`소재가 5개라 하나를 지워야 등록할 수 있어요.\n지울 소재 번호를 고르세요:\n\n${list}`, "");
      if (pick === null) return;
      const idx = Number(pick.trim()) - 1;
      if (!(idx >= 0 && idx < current.ads.length)) return window.alert("번호를 다시 확인해 주세요.");
      deleteAdId = current.ads[idx].id;
      if (!window.confirm(`'${current.ads[idx].headline}' 소재를 지우고 새 소재를 등록합니다. 진행할까요?`)) return;
    }
    const fields = promptAdFields();
    if (!fields) return;
    await submitAd(adgroupId, fields, deleteAdId);
  }

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
          {tab === "ads" && <button className="secondary" disabled={group === "all" || !!adBusy} title={group === "all" ? "광고그룹을 먼저 선택하세요" : "그룹당 5개 제한 — 꽉 찼으면 지울 소재를 고르게 돼요"} onClick={() => void addAd(group)}>➕ 새 소재</button>}
          {tab === "ads" && group !== "all" && <button className="secondary" disabled={!!adBusy} onClick={() => void loadLiveAds(group)}>확장소재 보기</button>}
          {sortSelect}
        </div>
        {tab === "ads" && adBusy && <p className="viz-sub notice-line"><span className="spinner inline" /> {adBusy}</p>}
        {tab === "ads" && liveAds && liveAds.adgroupId === group && <article className="viz-card">
          <div className="viz-head"><span className="viz-title">이 광고그룹의 실시간 소재 {liveAds.ads.length}/5 · 확장소재 {liveAds.extensions.length}</span>
            <span className="viz-sub">수정은 B 방식(기존 삭제 → 새 등록 → 검수)이라 검수 동안 해당 소재 노출이 비어요.</span></div>
          <ul className="line-campaigns">{liveAds.ads.map((a) => <li key={a.id}>
            <b>{a.headline}</b><small> {a.description}</small>
            <em>{a.on ? "" : "OFF · "}{a.inspect === "APPROVED" ? "검수 통과" : a.inspect === "UNDER_REVIEW" || a.inspect === "PENDING" ? "검수 중" : a.inspect}</em>
            <a className="link-button small" href={a.pcUrl} target="_blank" rel="noreferrer">🔗 랜딩</a>
            <button className="link-button small" disabled={!!adBusy} onClick={() => void editAd(liveAds.adgroupId, a)}>수정</button>
          </li>)}</ul>
          {liveAds.extensions.length > 0 && <><div className="viz-head" style={{ marginTop: 10 }}><span className="viz-title">확장소재</span></div>
            <ul className="line-campaigns">{liveAds.extensions.map((x) => <li key={x.id}>
              <b>{EXT_LABEL[x.type] || x.type}</b>
              <em>{x.on ? "" : "OFF · "}{x.inspect === "APPROVED" ? "검수 통과" : x.inspect || ""}</em>
              <small title={x.content}>{x.content.slice(0, 80)}</small>
            </li>)}</ul></>}
        </article>}

        <div className="viz-card table-card"><div className="table-wrap">
          {tab === "adgroups" && <table className="campaign-table sa-table"><thead><tr><th>유형</th><th>캠페인 › 광고그룹</th>{METRIC_HEAD.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{filterBase(data.adgroups, (r) => `${r.campaign} ${r.adgroup}`).map((r) => <tr key={r.adgroupId} className={r.active === false ? "inactive-row" : ""} onClick={() => { setGroup(r.adgroupId); setType(r.type); setTab(r.type === "SHOPPING" ? "terms" : "keywords"); }}>
              <td>{TYPE_LABEL[r.type] || r.type}</td><td><b>{r.adgroup}</b><button className="link-button campaign-link small" onClick={(e) => { e.stopPropagation(); onOpenCampaign?.(`naver_sa|${account}|${(r as any).campaignId}`); }}>{r.campaign} ↗</button></td><MetricCells m={r} /></tr>)}</tbody></table>}

          {tab === "keywords" && <table className="campaign-table sa-table"><thead><tr><th>키워드</th><th>광고그룹</th>{METRIC_HEAD.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{filterBase(data.keywords, (r) => `${r.keyword} ${r.adgroup}`).slice(0, 300).map((r) => <tr key={`${r.adgroupId}|${r.id}`} className={r.active === false ? "inactive-row" : ""}>
              <td><b>{r.keyword}</b></td><td><small>{r.adgroup}</small></td><MetricCells m={r} /></tr>)}</tbody></table>}

          {tab === "ads" && <table className="campaign-table sa-table"><thead><tr><th>소재 (제목 · 설명)</th><th /><th>광고그룹</th>{METRIC_HEAD.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{filterBase(data.powerlinkAds, (r) => `${r.headline || ""} ${r.description || ""} ${r.adgroup}`).slice(0, 300).map((r) => <tr key={`${r.adgroupId}|${r.id}`} className={r.active === false ? "inactive-row" : ""}>
              <td className="ad-copy"><b>{r.headline || "(제목 미조회)"}</b><small>{r.description}</small></td>
              <td><button className="link-button small" disabled={!!adBusy} title="B 방식 교체: 기존 소재 삭제 후 새 소재 등록 (검수 후 노출)" onClick={() => void (async () => { const d = await loadLiveAds(r.adgroupId); const ad = d?.ads.find((a) => a.id === r.id); if (ad) await editAd(r.adgroupId, ad); else window.alert("이 소재를 실시간 목록에서 찾지 못했어요 (이미 삭제됐을 수 있어요)."); })()}>수정</button></td>
              <td><small>{r.adgroup}</small></td><MetricCells m={r} /></tr>)}</tbody></table>}

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

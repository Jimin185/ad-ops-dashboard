"use client";

import { useEffect, useMemo, useState } from "react";
import type { AdAccount, Campaign, CreativeRow } from "@/lib/types";
import type { MixLine } from "@/lib/mix";
import { EMPTY_FILTER, FilterBar, lineCampaignIds, passes, type Filter } from "./filter-bar";
import { periodRange } from "./report-view";

const won = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
type Sort = "spend" | "roas" | "ctr" | "conversions";
type Period = "this_month" | "last_month" | "last_30";
const SORTS: Array<{ key: Sort; label: string }> = [{ key: "spend", label: "광고비" }, { key: "roas", label: "ROAS" }, { key: "ctr", label: "CTR" }, { key: "conversions", label: "전환" }];
const roas = (r: CreativeRow) => r.spend ? r.revenue / r.spend * 100 : 0;
const ctr = (r: CreativeRow) => r.impressions ? r.clicks / r.impressions * 100 : 0;

export function CreativeView({ accountKeys, apiFetch, accounts, campaigns, lines, onOpenCampaign }: { onOpenCampaign?: (campaignId: string) => void; accountKeys: string[]; apiFetch: (url: string, init?: RequestInit) => Promise<Response>; accounts: AdAccount[]; campaigns: Campaign[]; lines?: MixLine[] }) {
  const targets = accountKeys.filter((key) => key.startsWith("meta:") || key.startsWith("naver_gfa:") || key.startsWith("google_ads:"));
  const [period, setPeriod] = useState<Period>("this_month");
  const [filter, setFilter] = useState<Filter>(EMPTY_FILTER);
  const campaignsById = useMemo(() => new Map(campaigns.map((c) => [c.id, c])), [campaigns]);
  const lineSets = useMemo(() => lineCampaignIds(lines, campaigns), [lines, campaigns]);
  const [sort, setSort] = useState<Sort>("spend");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<CreativeRow[]>([]);
  const [errors, setErrors] = useState<Array<{ channel: string; accountId: string; message: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [dragId, setDragId] = useState("");
  const [editNotice, setEditNotice] = useState("");

  // ---- Meta 소재 교체: 이미지 드래그&드롭, 랜딩 변경 (새 크리에이티브 생성 후 광고에 연결) ----
  async function editCreative(r: CreativeRow, change: { imageBase64?: string; link?: string }, previewUrl?: string) {
    setEditingId(r.id); setEditNotice("");
    try {
      const response = await apiFetch("/api/creative/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: r.channel, accountId: r.accountId, adId: r.id, ...change }) });
      const data = await response.json();
      if (!response.ok) { window.alert(data.error || "소재를 바꾸지 못했어요."); return; }
      setRows((cur) => cur.map((x) => x.id === r.id && x.channel === r.channel ? { ...x, ...(previewUrl ? { imageUrl: previewUrl } : {}), ...(change.link ? { landingUrl: change.link } : {}) } : x));
      setEditNotice(`'${r.name}' ${change.imageBase64 ? "이미지" : "랜딩"}를 바꿨어요. 새 소재 버전이 만들어져 광고에 연결됐고, 매체 반영까지 잠시 걸릴 수 있어요.`);
      setTimeout(() => setEditNotice(""), 8000);
    } finally { setEditingId(""); }
  }
  function onDropImage(r: CreativeRow, file: File | undefined) {
    if (!file) return;
    if (r.channel !== "meta") return window.alert("이미지 교체는 지금 Meta 소재만 돼요. (GFA·네이버는 소재 등록 구조라 준비 중)");
    if (!/^image\//.test(file.type)) return window.alert("이미지 파일을 놓아 주세요 (jpg·png).");
    if (file.size > 6 * 1024 * 1024) return window.alert("이미지가 너무 커요 (6MB 이하).");
    if (!window.confirm(`'${r.name}' 소재 이미지를 '${file.name}'(으)로 바꿀까요?\n기존 소재를 복사한 새 버전이 만들어져 광고에 연결돼요.`)) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result || "").split(",")[1];
      if (base64) void editCreative(r, { imageBase64: base64 }, URL.createObjectURL(file));
    };
    reader.readAsDataURL(file);
  }
  function editLanding(r: CreativeRow) {
    if (r.channel !== "meta") return window.alert("랜딩 변경은 지금 Meta 소재만 돼요.");
    const v = (window.prompt(`'${r.name}' 랜딩 URL을 바꿉니다`, r.landingUrl || "https://") || "").trim();
    if (!v || v === r.landingUrl) return;
    if (!/^https?:\/\/\S+$/.test(v)) return window.alert("http:// 또는 https:// 로 시작하는 주소를 넣어 주세요.");
    void editCreative(r, { link: v });
  }
  const [reloadKey, setReloadKey] = useState(0);
  const [poll, setPoll] = useState(0);
  const [fetchedAt, setFetchedAt] = useState("");
  const range = useMemo(() => periodRange(period), [period]);

  useEffect(() => {
    if (!targets.length) return;
    let cancelled = false;
    setLoading(true);
    apiFetch("/api/creatives", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accounts: targets, since: range.since, until: range.until, refresh: reloadKey > 0 && poll === 0 }) })
      .then((r) => r.json()).then((data) => { if (cancelled) return; setRows(data.rows || []); if (data.pending?.length && poll < 6) setTimeout(() => !cancelled && setPoll((n) => n + 1), 500); setFetchedAt(data.fetchedAt || ""); setErrors(data.errors || (data.error ? [{ channel: "", accountId: "", message: data.error }] : [])); })
      .catch(() => !cancelled && setErrors([{ channel: "", accountId: "", message: "소재 성과를 불러오지 못했습니다." }]))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.join(","), range.since, range.until, reloadKey, poll]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const metric = { spend: (r: CreativeRow) => r.spend, roas, ctr, conversions: (r: CreativeRow) => r.conversions }[sort];
    return rows.filter((r) => passes(filter, r, campaignsById, lineSets) && (!q || `${r.name} ${r.campaignName || ""} ${r.groupName || ""} ${r.headline || ""}`.toLowerCase().includes(q)))
      .sort((a, b) => metric(b) - metric(a));
  }, [rows, filter, sort, query, campaignsById, lineSets]);
  const avgRoas = useMemo(() => { const s = visible.reduce((a, r) => a + r.spend, 0); return s ? visible.reduce((a, r) => a + r.revenue, 0) / s * 100 : 0; }, [visible]);

  if (!targets.length) return <section className="report"><div className="empty-state"><b>Meta·GFA·구글 계정이 매핑되어 있지 않습니다.</b><span>소재 성과는 Meta, 네이버 GFA, 구글(디스플레이·디맨드젠) 계정에서 볼 수 있습니다.</span></div></section>;

  return (
    <section className="report">
      <div className="report-toolbar">
        <nav className="channel-tabs">{([["this_month", "이번 달"], ["last_month", "지난 달"], ["last_30", "최근 30일"]] as Array<[Period, string]>).map(([key, label]) => <button key={key} className={period === key ? "active" : ""} onClick={() => setPeriod(key)}>{label}</button>)}</nav>
      </div>
      <FilterBar value={filter} onChange={setFilter} accountKeys={accountKeys} accounts={accounts} campaigns={campaigns} lines={lines} channels={["meta", "naver_gfa", "google_ads"]} />
      <div className="creative-toolbar">
        <input className="account-search" type="search" placeholder="소재·캠페인·광고세트 이름으로 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="sort-select">정렬 <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>{SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
      </div>
      <small className="viz-sub">{range.since} ~ {range.until} · 소재 {visible.length}개 · 평균 ROAS {Math.round(avgRoas)}%{loading ? " · 불러오는 중…" : ""} · 하루 한 번(오전 6시) 갱신, 지난 주 이전은 저장된 값 사용 <button className="link-button" disabled={loading} onClick={() => setReloadKey((k) => k + 1)}>지금 새로 가져오기</button></small>
      {errors.map((e, i) => <div className="connection-error" key={i}><b>{e.channel === "meta" ? "Meta" : e.channel === "naver_gfa" ? "네이버 GFA" : e.channel === "google_ads" ? "Google" : "오류"} {e.accountId}</b><span>{e.message}</span></div>)}
      {editNotice && <p className="viz-sub notice-line">✅ {editNotice}</p>}
      <small className="viz-sub">💡 Meta 소재는 카드 위에 이미지 파일을 끌어다 놓으면 교체되고, 랜딩 변경 버튼으로 링크를 바꿀 수 있어요 (새 소재 버전 생성 방식).</small>
      <div className="creative-grid">
        {visible.map((r, index) => {
          const value = roas(r);
          const key = `${r.channel}:${r.id}`;
          return <article className={`creative-card${dragId === key ? " drop-target" : ""}`} key={key}
            onDragOver={(e) => { if (r.channel === "meta") { e.preventDefault(); if (dragId !== key) setDragId(key); } }}
            onDragLeave={() => setDragId((cur) => cur === key ? "" : cur)}
            onDrop={(e) => { e.preventDefault(); setDragId(""); onDropImage(r, e.dataTransfer.files?.[0]); }}>
            <div className="creative-thumb" style={dragId === key ? { outline: "2px dashed var(--accent, #2f6b3a)", outlineOffset: -2 } : undefined}>
              {editingId === r.id && <span className="spinner inline" style={{ position: "absolute", top: 8, right: 8 }} />}
              {r.imageUrl ? <img src={r.imageUrl} alt={r.name} loading="lazy" referrerPolicy="no-referrer" /> : <span>이미지 없음</span>}
              <span className={`channel ${r.channel}`}>{r.channel === "meta" ? "Meta" : r.channel === "google_ads" ? "Google" : "GFA"}</span>
              <span className="rank">#{index + 1}</span>
            </div>
            <div className="creative-body">
              <b title={r.name}>{r.name}</b>
              {r.campaignId ? <button className="link-button campaign-link small" title="매체별 데이터에서 캠페인 보기" onClick={() => onOpenCampaign?.(r.campaignId!)}>{[r.campaignName, r.groupName].filter(Boolean).join(" › ") || "캠페인 보기"}</button>
                : <small title={`${r.campaignName || ""} › ${r.groupName || ""}`}>{[r.campaignName, r.groupName].filter(Boolean).join(" › ") || "–"}</small>}
              {r.headline && <p className="creative-copy">{r.headline}</p>}
              <span className="viz-sub creative-landing">
                {r.landingUrl ? <a href={r.landingUrl} target="_blank" rel="noreferrer" title={r.landingUrl}>🔗 {r.landingUrl.replace(/^https?:\/\//, "").slice(0, 34)}</a> : null}
                {r.channel === "meta" && <button className="link-button small" disabled={editingId === r.id} onClick={() => editLanding(r)}>랜딩 변경</button>}
              </span>
              <dl>
                <div><dt>광고비</dt><dd>{won.format(r.spend)}</dd></div>
                <div><dt>ROAS</dt><dd className={value >= avgRoas ? "good" : "bad"}>{Math.round(value)}%</dd></div>
                <div><dt>CTR</dt><dd>{ctr(r).toFixed(2)}%</dd></div>
                <div><dt>전환</dt><dd>{Math.round(r.conversions).toLocaleString()}</dd></div>
              </dl>
            </div>
          </article>;
        })}
      </div>
      {!loading && !visible.length && <div className="empty-state"><b>표시할 소재가 없습니다.</b><span>이 기간에 광고비가 발생한 소재만 보여줍니다.</span></div>}
    </section>
  );
}

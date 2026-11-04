"use client";

import { useEffect, useMemo, useState } from "react";
import type { CreativeRow } from "@/lib/types";
import { periodRange } from "./report-view";

const won = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
type Sort = "spend" | "roas" | "ctr" | "conversions";
type Period = "this_month" | "last_month" | "last_30";
const SORTS: Array<{ key: Sort; label: string }> = [{ key: "spend", label: "광고비" }, { key: "roas", label: "ROAS" }, { key: "ctr", label: "CTR" }, { key: "conversions", label: "전환" }];
const roas = (r: CreativeRow) => r.spend ? r.revenue / r.spend * 100 : 0;
const ctr = (r: CreativeRow) => r.impressions ? r.clicks / r.impressions * 100 : 0;

export function CreativeView({ accountKeys, apiFetch }: { accountKeys: string[]; apiFetch: (url: string, init?: RequestInit) => Promise<Response> }) {
  const targets = accountKeys.filter((key) => key.startsWith("meta:") || key.startsWith("naver_gfa:"));
  const [period, setPeriod] = useState<Period>("this_month");
  const [channel, setChannel] = useState<"all" | "meta" | "naver_gfa">("all");
  const [sort, setSort] = useState<Sort>("spend");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<CreativeRow[]>([]);
  const [errors, setErrors] = useState<Array<{ channel: string; accountId: string; message: string }>>([]);
  const [loading, setLoading] = useState(false);
  const range = useMemo(() => periodRange(period), [period]);

  useEffect(() => {
    if (!targets.length) return;
    let cancelled = false;
    setLoading(true);
    apiFetch("/api/creatives", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accounts: targets, since: range.since, until: range.until }) })
      .then((r) => r.json()).then((data) => { if (cancelled) return; setRows(data.rows || []); setErrors(data.errors || (data.error ? [{ channel: "", accountId: "", message: data.error }] : [])); })
      .catch(() => !cancelled && setErrors([{ channel: "", accountId: "", message: "소재 성과를 불러오지 못했습니다." }]))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.join(","), range.since, range.until]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const metric = { spend: (r: CreativeRow) => r.spend, roas, ctr, conversions: (r: CreativeRow) => r.conversions }[sort];
    return rows.filter((r) => (channel === "all" || r.channel === channel) && (!q || `${r.name} ${r.campaignName || ""} ${r.groupName || ""} ${r.headline || ""}`.toLowerCase().includes(q)))
      .sort((a, b) => metric(b) - metric(a));
  }, [rows, channel, sort, query]);
  const avgRoas = useMemo(() => { const s = visible.reduce((a, r) => a + r.spend, 0); return s ? visible.reduce((a, r) => a + r.revenue, 0) / s * 100 : 0; }, [visible]);

  if (!targets.length) return <section className="report"><div className="empty-state"><b>Meta·GFA 계정이 매핑되어 있지 않습니다.</b><span>소재 성과는 Meta와 네이버 GFA 계정에서 볼 수 있습니다.</span></div></section>;

  return (
    <section className="report">
      <div className="report-toolbar">
        <nav className="channel-tabs">{([["this_month", "이번 달"], ["last_month", "지난 달"], ["last_30", "최근 30일"]] as Array<[Period, string]>).map(([key, label]) => <button key={key} className={period === key ? "active" : ""} onClick={() => setPeriod(key)}>{label}</button>)}</nav>
        <nav className="channel-tabs">{([["all", "전체"], ["meta", "Meta"], ["naver_gfa", "네이버 GFA"]] as const).map(([key, label]) => <button key={key} className={channel === key ? "active" : ""} onClick={() => setChannel(key)}>{label}</button>)}</nav>
      </div>
      <div className="creative-toolbar">
        <input className="account-search" type="search" placeholder="소재·캠페인·광고세트 이름으로 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="sort-select">정렬 <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>{SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
      </div>
      <small className="viz-sub">{range.since} ~ {range.until} · 소재 {visible.length}개 · 평균 ROAS {Math.round(avgRoas)}%{loading ? " · 불러오는 중…" : ""}</small>
      {errors.map((e, i) => <div className="connection-error" key={i}><b>{e.channel === "meta" ? "Meta" : e.channel === "naver_gfa" ? "네이버 GFA" : "오류"} {e.accountId}</b><span>{e.message}</span></div>)}
      <div className="creative-grid">
        {visible.map((r, index) => {
          const value = roas(r);
          return <article className="creative-card" key={`${r.channel}:${r.id}`}>
            <div className="creative-thumb">
              {r.imageUrl ? <img src={r.imageUrl} alt={r.name} loading="lazy" referrerPolicy="no-referrer" /> : <span>이미지 없음</span>}
              <span className={`channel ${r.channel}`}>{r.channel === "meta" ? "Meta" : "GFA"}</span>
              <span className="rank">#{index + 1}</span>
            </div>
            <div className="creative-body">
              <b title={r.name}>{r.name}</b>
              <small title={`${r.campaignName || ""} › ${r.groupName || ""}`}>{[r.campaignName, r.groupName].filter(Boolean).join(" › ") || "–"}</small>
              {r.headline && <p className="creative-copy">{r.headline}</p>}
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

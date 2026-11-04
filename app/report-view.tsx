"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Campaign, Channel, DailyRow, ReportResult } from "@/lib/types";
import type { MediaMix } from "@/lib/mix";

// 채널 색은 채널(엔티티)에 고정한다. 순위나 필터에 따라 바뀌지 않는다.
export const CHANNEL_ORDER: Channel[] = ["naver_sa", "naver_gfa", "meta", "google_ads"];
export const CHANNEL_LABEL: Record<Channel, string> = { naver_sa: "네이버 SA", naver_gfa: "네이버 GFA", meta: "Meta", google_ads: "Google Ads" };
const SERIES_VAR: Record<Channel, string> = { naver_sa: "var(--series-1)", naver_gfa: "var(--series-2)", meta: "var(--series-3)", google_ads: "var(--series-4)" };

const won = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
const compactWon = (v: number) => v >= 100_000_000 ? `${(v / 100_000_000).toFixed(1)}억` : v >= 10_000 ? `${Math.round(v / 10_000).toLocaleString()}만` : Math.round(v).toLocaleString();
const pct = (v: number) => `${Math.round(v).toLocaleString()}%`;
const roasOf = (spend: number, revenue: number) => spend ? revenue / spend * 100 : 0;

type Period = "this_month" | "last_month" | "last_30" | "last_90";
const PERIODS: Array<{ key: Period; label: string }> = [
  { key: "this_month", label: "이번 달" }, { key: "last_month", label: "지난 달" }, { key: "last_30", label: "최근 30일" }, { key: "last_90", label: "최근 90일" },
];

function seoulToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function shift(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
export function periodRange(period: Period) {
  const today = seoulToday();
  const [y, m] = today.split("-").map(Number);
  if (period === "this_month") return { since: `${today.slice(0, 7)}-01`, until: today, month: today.slice(0, 7) };
  if (period === "last_month") {
    const first = new Date(Date.UTC(y, m - 2, 1)); const last = new Date(Date.UTC(y, m - 1, 0));
    return { since: first.toISOString().slice(0, 10), until: last.toISOString().slice(0, 10), month: first.toISOString().slice(0, 7) };
  }
  return { since: shift(today, period === "last_30" ? -29 : -89), until: today, month: today.slice(0, 7) };
}
function datesBetween(since: string, until: string) {
  const out: string[] = [];
  for (let d = since; d <= until; d = shift(d, 1)) out.push(d);
  return out;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function Gauge({ label, value, target, format, caption, toneRatio }: { label: string; value: number; target?: number; format: (v: number) => string; caption: string; toneRatio?: number }) {
  const ratio = target ? value / target : 0;
  const judged = toneRatio ?? ratio;
  const r = 52, c = 2 * Math.PI * r;
  const filled = Math.min(1, ratio);
  const tone = !target ? "var(--muted-mark)" : toneRatio !== undefined ? (Math.abs(judged - 1) <= 0.1 ? "var(--good)" : Math.abs(judged - 1) <= 0.25 ? "var(--warning)" : "var(--critical)") : judged >= 1 ? "var(--good)" : judged >= 0.8 ? "var(--warning)" : "var(--critical)";
  return (
    <article className="viz-card gauge-card">
      <span className="viz-title">{label}</span>
      <div className="gauge">
        <svg viewBox="0 0 132 132" role="img" aria-label={`${label} ${target ? `${Math.round(ratio * 100)}%` : "목표 없음"}`}>
          <circle cx="66" cy="66" r={r} fill="none" stroke="var(--track)" strokeWidth="12" />
          {target ? <circle cx="66" cy="66" r={r} fill="none" stroke={tone} strokeWidth="12" strokeLinecap="round" strokeDasharray={`${filled * c} ${c}`} transform="rotate(-90 66 66)" /> : null}
        </svg>
        <div className="gauge-center"><b>{target ? `${Math.round(ratio * 100)}%` : "–"}</b><small>{target ? "달성률" : "목표 미설정"}</small></div>
      </div>
      <p className="gauge-caption"><b>{format(value)}</b>{target ? <> / 목표 {format(target)}</> : null}</p>
      <small className="viz-sub">{caption}</small>
    </article>
  );
}

type DayAgg = { date: string; total: number; revenue: number; byChannel: Partial<Record<Channel, number>> };

function SpendBars({ days, channels }: { days: DayAgg[]; channels: Channel[] }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 240, pad = { l: 56, r: 12, t: 12, b: 28 };
  const innerW = width - pad.l - pad.r, innerH = height - pad.t - pad.b;
  const max = Math.max(1, ...days.map((d) => d.total));
  const ticks = niceTicks(Math.max(max, 100_000));
  const top = ticks[ticks.length - 1];
  const band = innerW / Math.max(1, days.length);
  const barW = Math.max(2, Math.min(28, band - 4));
  const labelEvery = Math.ceil(days.length / Math.max(2, Math.floor(innerW / 56)));
  const y = (v: number) => pad.t + innerH - v / top * innerH;
  const hovered = hover !== null ? days[hover] : null;
  return (
    <div className="chart-box" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label="일자별 채널 광고비">
        {ticks.map((t, ti) => <g key={ti}><line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="grid" /><text x={pad.l - 8} y={y(t) + 4} className="axis" textAnchor="end">{compactWon(t)}</text></g>)}
        {days.map((d, i) => {
          const x = pad.l + i * band + (band - barW) / 2;
          let acc = 0;
          const segs = channels.filter((c) => (d.byChannel[c] || 0) > 0);
          return <g key={d.date}>
            {segs.map((c, si) => {
              const v = d.byChannel[c] || 0;
              const h = v / top * innerH;
              const yTop = y(acc + v);
              acc += v;
              const isTop = si === segs.length - 1;
              // 세그먼트 사이 2px 표면 간격, 맨 위만 둥근 끝
              return <path key={c} d={barPath(x, yTop + (isTop ? 0 : 1), barW, Math.max(0, h - (isTop ? 0 : 1) - (si === 0 ? 0 : 1)), isTop ? 3 : 0)} fill={SERIES_VAR[c]} opacity={hover === null || hover === i ? 1 : 0.45} />;
            })}
            {i % labelEvery === 0 && <text x={x + barW / 2} y={height - 8} className="axis" textAnchor="middle">{d.date.slice(5).replace("-", "/")}</text>}
            <rect x={pad.l + i * band} y={pad.t} width={band} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
          </g>;
        })}
        <line x1={pad.l} x2={width - pad.r} y1={y(0)} y2={y(0)} className="baseline" />
      </svg>
      {hovered && <div className="tooltip" style={{ left: Math.min(width - 190, Math.max(0, pad.l + (hover as number) * band + band / 2 - 90)) }}>
        <b>{hovered.date}</b>
        {channels.filter((c) => hovered.byChannel[c]).map((c) => <span key={c}><i style={{ background: SERIES_VAR[c] }} />{CHANNEL_LABEL[c]}<em>{won.format(hovered.byChannel[c] || 0)}</em></span>)}
        <span className="tooltip-total">합계<em>{won.format(hovered.total)}</em></span>
        <span>ROAS<em>{pct(roasOf(hovered.total, hovered.revenue))}</em></span>
      </div>}
    </div>
  );
}

function RoasLine({ days, target }: { days: DayAgg[]; target?: number }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 180, pad = { l: 56, r: 12, t: 14, b: 28 };
  const innerW = width - pad.l - pad.r, innerH = height - pad.t - pad.b;
  const values = days.map((d) => roasOf(d.total, d.revenue));
  const ticks = niceTicks(Math.max(100, target || 0, ...values));
  const top = ticks[ticks.length - 1];
  const x = (i: number) => pad.l + (days.length <= 1 ? innerW / 2 : i / (days.length - 1) * innerW);
  const y = (v: number) => pad.t + innerH - v / top * innerH;
  // 광고비가 없는 날(아직 집계 전인 오늘 등)은 선을 끊는다
  let pen = false;
  const path = values.map((v, i) => { if (!days[i].total) { pen = false; return ""; } const cmd = `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; return cmd; }).join("");
  const labelEvery = Math.ceil(days.length / Math.max(2, Math.floor(innerW / 56)));
  return (
    <div className="chart-box" ref={ref} onMouseLeave={() => setHover(null)}
      onMouseMove={(e) => { const box = e.currentTarget.getBoundingClientRect(); const i = Math.round((e.clientX - box.left - pad.l) / Math.max(1, innerW) * (days.length - 1)); setHover(Math.max(0, Math.min(days.length - 1, i))); }}>
      <svg width={width} height={height} role="img" aria-label="일자별 ROAS">
        {ticks.map((t, ti) => <g key={ti}><line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="grid" /><text x={pad.l - 8} y={y(t) + 4} className="axis" textAnchor="end">{t}%</text></g>)}
        {target ? <g><line x1={pad.l} x2={width - pad.r} y1={y(target)} y2={y(target)} className="target-line" /><text x={width - pad.r} y={y(target) - 6} className="axis target-label" textAnchor="end">목표 {pct(target)}</text></g> : null}
        <path d={path} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" />
        {days.map((d, i) => i % labelEvery === 0 && <text key={d.date} x={x(i)} y={height - 8} className="axis" textAnchor="middle">{d.date.slice(5).replace("-", "/")}</text>)}
        {hover !== null && days[hover]?.total > 0 && <g><line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + innerH} className="crosshair" /><circle cx={x(hover)} cy={y(values[hover])} r="5" fill="var(--series-1)" stroke="var(--surface)" strokeWidth="2" /></g>}
      </svg>
      {hover !== null && days[hover] && <div className="tooltip" style={{ left: Math.min(width - 170, Math.max(0, x(hover) - 80)) }}>
        <b>{days[hover].date}</b><span>ROAS<em>{pct(values[hover])}</em></span><span>광고비<em>{won.format(days[hover].total)}</em></span><span>매출<em>{won.format(days[hover].revenue)}</em></span>
      </div>}
    </div>
  );
}

function barPath(x: number, y: number, w: number, h: number, r: number) {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}
function niceTicks(max: number) {
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  return Array.from({ length: 5 }, (_, i) => Math.round(i * step));
}

export function ReportView({ accountKeys, campaigns, mixes, onOpenMix, apiFetch }: {
  accountKeys: string[];
  campaigns: Campaign[];
  mixes: MediaMix[];
  onOpenMix: () => void;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const [period, setPeriod] = useState<Period>("this_month");
  const [report, setReport] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showTable, setShowTable] = useState(false);
  const range = useMemo(() => periodRange(period), [period]);
  const mix = mixes.find((m) => m.month === range.month) || null;
  const keysSignature = accountKeys.join(",");

  useEffect(() => {
    if (!accountKeys.length) { setReport(null); return; }
    let cancelled = false;
    setLoading(true); setError("");
    apiFetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accounts: accountKeys, since: range.since, until: range.until }) })
      .then(async (response) => { const data = await response.json(); if (cancelled) return; if (!response.ok) setError(data.error || "리포트를 불러오지 못했습니다."); else setReport(data); })
      .catch(() => !cancelled && setError("리포트를 불러오지 못했습니다."))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSignature, range.since, range.until]);

  const rows: DailyRow[] = report?.rows || [];
  const channels = CHANNEL_ORDER.filter((c) => accountKeys.some((key) => key.startsWith(`${c}:`)));
  const days: DayAgg[] = useMemo(() => {
    const map = new Map(datesBetween(range.since, range.until).map((date) => [date, { date, total: 0, revenue: 0, byChannel: {} } as DayAgg]));
    for (const row of rows) {
      const d = map.get(row.date); if (!d) continue;
      d.total += row.spend; d.revenue += row.revenue; d.byChannel[row.channel] = (d.byChannel[row.channel] || 0) + row.spend;
    }
    return [...map.values()];
  }, [rows, range.since, range.until]);

  const totals = rows.reduce((acc, row) => ({ spend: acc.spend + row.spend, revenue: acc.revenue + row.revenue, conversions: acc.conversions + row.conversions, clicks: acc.clicks + row.clicks, impressions: acc.impressions + row.impressions }), { spend: 0, revenue: 0, conversions: 0, clicks: 0, impressions: 0 });
  const byChannel = channels.map((channel) => {
    const list = rows.filter((row) => row.channel === channel);
    const spend = list.reduce((s, r) => s + r.spend, 0), revenue = list.reduce((s, r) => s + r.revenue, 0), conversions = list.reduce((s, r) => s + r.conversions, 0);
    const plan = mix?.month === range.month ? mix.channels[channel] : undefined;
    return { channel, spend, revenue, conversions, roas: roasOf(spend, revenue), planBudget: plan?.budget || 0, planRoas: plan?.targetRoas || 0 };
  });
  const maxChannelSpend = Math.max(1, ...byChannel.map((c) => Math.max(c.spend, c.planBudget)));

  const mixForPeriod = mix && mix.month === range.month && period !== "last_30" && period !== "last_90" ? mix : null;
  const targetBudget = mixForPeriod ? Object.values(mixForPeriod.channels).reduce((s, c) => s + (c?.budget || 0), 0) : 0;
  const targetRoas = mixForPeriod?.targetRoas || 0;
  // 이번 달이면 경과일 기준 예상 소진액도 보여준다
  const elapsed = datesBetween(range.since, range.until).length;
  const monthDays = period === "this_month" ? new Date(Number(range.month.slice(0, 4)), Number(range.month.slice(5, 7)), 0).getDate() : elapsed;
  const projected = period === "this_month" && elapsed ? totals.spend / elapsed * monthDays : totals.spend;

  const topCampaigns = campaigns.filter((c) => accountKeys.includes(`${c.channel}:${c.accountId}`) && c.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, 10);

  if (!accountKeys.length) return <section className="report"><div className="empty-state"><b>매핑된 광고계정이 없습니다.</b><span>계정 매핑에서 이 광고주의 계정을 연결하면 리포트가 나타납니다.</span></div></section>;

  return (
    <section className="report viz-root">
      <div className="report-toolbar">
        <nav className="channel-tabs">{PERIODS.map((p) => <button key={p.key} className={period === p.key ? "active" : ""} onClick={() => setPeriod(p.key)}>{p.label}</button>)}</nav>
        <span className="report-range">{range.since} ~ {range.until}{loading ? " · 불러오는 중…" : ""}</span>
      </div>
      {error && <div className="connection-error"><b>리포트 오류</b><span>{error}</span></div>}
      {!!report?.errors.length && <div className="connection-error"><b>일부 계정 조회 실패</b>{report.errors.map((e) => <span key={`${e.channel}:${e.accountId}`}>{CHANNEL_LABEL[e.channel]} {e.accountId}: {e.message}</span>)}</div>}

      <div className="kpi-row">
        <article className="viz-card kpi"><span className="viz-title">광고비</span><b>{won.format(totals.spend)}</b><small className="viz-sub">{period === "this_month" ? `월말 예상 ${won.format(projected)}` : `${elapsed}일`}</small></article>
        <article className="viz-card kpi"><span className="viz-title">매출(전환가치)</span><b>{won.format(totals.revenue)}</b><small className="viz-sub">전환 {Math.round(totals.conversions).toLocaleString()}건</small></article>
        <article className="viz-card kpi"><span className="viz-title">ROAS</span><b>{pct(roasOf(totals.spend, totals.revenue))}</b><small className="viz-sub">CPA {totals.conversions ? won.format(totals.spend / totals.conversions) : "–"}</small></article>
        <article className="viz-card kpi"><span className="viz-title">클릭 · CTR</span><b>{Math.round(totals.clicks).toLocaleString()}</b><small className="viz-sub">CTR {totals.impressions ? (totals.clicks / totals.impressions * 100).toFixed(2) : "0.00"}% · CPC {totals.clicks ? won.format(totals.spend / totals.clicks) : "–"}</small></article>
      </div>

      <div className="report-grid-top">
        <Gauge label="ROAS 목표 달성" value={roasOf(totals.spend, totals.revenue)} target={targetRoas || undefined} format={pct} caption={mixForPeriod ? `${range.month} 믹스 기준` : "이 기간의 믹스가 없습니다"} />
        <Gauge label="예산 소진" value={totals.spend} target={targetBudget || undefined} toneRatio={targetBudget && period === "this_month" ? projected / targetBudget : undefined} format={compactWon} caption={targetBudget ? (period === "this_month" ? `월말 예상 ${Math.round(projected / targetBudget * 100)}%` : `${range.month} 믹스 예산`) : "이 기간의 믹스가 없습니다"} />
        <article className="viz-card wide">
          <div className="viz-head"><span className="viz-title">일자별 광고비 (채널별)</span>
            <div className="legend">{channels.map((c) => <span key={c}><i style={{ background: SERIES_VAR[c] }} />{CHANNEL_LABEL[c]}</span>)}</div></div>
          <SpendBars days={days} channels={channels} />
        </article>
      </div>
      {!mixForPeriod && (period === "this_month" || period === "last_month") && <button className="mix-cta" onClick={onOpenMix}>{range.month} 미디어 믹스를 만들면 목표 대비 달성률이 표시됩니다 →</button>}

      <div className="report-grid-bottom">
        <article className="viz-card">
          <div className="viz-head"><span className="viz-title">일자별 ROAS</span></div>
          <RoasLine days={days} target={targetRoas || undefined} />
        </article>
        <article className="viz-card">
          <div className="viz-head"><span className="viz-title">채널별 성과{mixForPeriod ? " · 믹스 대비" : ""}</span></div>
          <div className="channel-bars">{byChannel.map((c) => <div key={c.channel} className="channel-bar-row">
            <span className="channel-name"><i style={{ background: SERIES_VAR[c.channel] }} />{CHANNEL_LABEL[c.channel]}</span>
            <div className="channel-bar-track" title={`${won.format(c.spend)}${c.planBudget ? ` / 계획 ${won.format(c.planBudget)}` : ""}`}>
              {c.planBudget ? <div className="plan-mark" style={{ width: `${c.planBudget / maxChannelSpend * 100}%` }} /> : null}
              <div className="channel-bar-fill" style={{ width: `${c.spend / maxChannelSpend * 100}%`, background: SERIES_VAR[c.channel] }} />
            </div>
            <span className="channel-stat"><b>{compactWon(c.spend)}</b>{c.planBudget ? <small>/ {compactWon(c.planBudget)}</small> : null}</span>
            <span className={`channel-stat roas ${c.planRoas ? (c.roas >= c.planRoas ? "good" : "bad") : ""}`}><b>{pct(c.roas)}</b>{c.planRoas ? <small>목표 {pct(c.planRoas)}</small> : null}</span>
          </div>)}</div>
          {mixForPeriod && <small className="viz-sub">회색 막대 = 믹스 계획 예산</small>}
        </article>
      </div>

      <article className="viz-card">
        <div className="viz-head"><span className="viz-title">이번 달 광고비 상위 캠페인</span><button className="link-button" onClick={() => setShowTable(!showTable)}>{showTable ? "일자별 표 닫기" : "일자별 데이터 표로 보기"}</button></div>
        {showTable ? <div className="table-wrap"><table className="campaign-table"><thead><tr><th>날짜</th>{channels.map((c) => <th key={c}>{CHANNEL_LABEL[c]}</th>)}<th>합계</th><th>매출</th><th>ROAS</th></tr></thead>
          <tbody>{days.map((d) => <tr key={d.date}><td>{d.date}</td>{channels.map((c) => <td key={c}>{won.format(d.byChannel[c] || 0)}</td>)}<td>{won.format(d.total)}</td><td>{won.format(d.revenue)}</td><td>{pct(roasOf(d.total, d.revenue))}</td></tr>)}</tbody></table></div>
          : <div className="table-wrap"><table className="campaign-table"><thead><tr><th>채널</th><th>캠페인</th><th>광고비</th><th>전환</th><th>ROAS</th></tr></thead>
            <tbody>{topCampaigns.length ? topCampaigns.map((c) => <tr key={c.id}><td><span className={`channel ${c.channel}`}>{CHANNEL_LABEL[c.channel]}</span></td><td><b>{c.name}</b><small className="id">{c.accountName}</small></td><td>{won.format(c.spend)}</td><td>{c.conversions.toLocaleString()}</td><td>{pct(c.roas)}</td></tr>) : <tr><td colSpan={5}>이번 달 광고비가 있는 캠페인이 없습니다.</td></tr>}</tbody></table></div>}
      </article>
    </section>
  );
}

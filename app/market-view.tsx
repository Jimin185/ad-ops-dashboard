"use client";

import { useState } from "react";

type Kw = { keyword: string; pc: number; mobile: number; total: number; clicks: number; ctr: number; competition: string; adDepth: number };
type Trend = { name: string; data: Array<{ period: string; ratio: number }> };
type Content = { title: string; description: string; link: string; date: string; source: string };
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "#6250d6"];

function monthsAgo(n: number) {
  const d = new Date(Date.now() + 9 * 3600_000);
  d.setUTCMonth(d.getUTCMonth() - n, 1);
  return d.toISOString().slice(0, 10);
}
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

function TrendChart({ trends }: { trends: Trend[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 760, height = 240, pad = { l: 40, r: 12, t: 12, b: 28 };
  const periods = trends[0]?.data.map((d) => d.period) || [];
  if (!periods.length) return null;
  const x = (i: number) => pad.l + (periods.length <= 1 ? 0 : i / (periods.length - 1) * (width - pad.l - pad.r));
  const y = (v: number) => pad.t + (100 - v) / 100 * (height - pad.t - pad.b);
  const every = Math.ceil(periods.length / 8);
  return (
    <div className="chart-box" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="검색어 트렌드"
        onMouseMove={(e) => { const box = e.currentTarget.getBoundingClientRect(); const px = (e.clientX - box.left) / box.width * width; setHover(Math.max(0, Math.min(periods.length - 1, Math.round((px - pad.l) / (width - pad.l - pad.r) * (periods.length - 1))))); }}>
        {[0, 25, 50, 75, 100].map((t) => <g key={t}><line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="grid" /><text x={pad.l - 6} y={y(t) + 4} className="axis" textAnchor="end">{t}</text></g>)}
        {periods.map((p, i) => i % every === 0 && <text key={p} x={x(i)} y={height - 8} className="axis" textAnchor="middle">{p.slice(2, 7).replace("-", ".")}</text>)}
        {trends.map((t, si) => <path key={t.name} d={t.data.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.ratio)}`).join("")} fill="none" stroke={SERIES[si]} strokeWidth="2" />)}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} className="crosshair" />}
      </svg>
      {hover !== null && <div className="tooltip" style={{ left: `${Math.min(80, x(hover) / width * 100)}%` }}>
        <b>{periods[hover]}</b>{trends.map((t, si) => <span key={t.name}><i style={{ background: SERIES[si] }} />{t.name}<em>{t.data[hover]?.ratio ?? "–"}</em></span>)}
      </div>}
    </div>
  );
}

export function MarketView({ onAsk }: { onAsk: (prompt: string) => void }) {
  const [input, setInput] = useState("");
  const [months, setMonths] = useState(12);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [kw, setKw] = useState<Kw[]>([]);
  const [trends, setTrends] = useState<Trend[]>([]);
  const [contents, setContents] = useState<Record<string, { total: number; items: Content[] }>>({});
  const [searched, setSearched] = useState<string[]>([]);

  async function call(body: object) {
    const r = await fetch("/api/market", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "불러오지 못했습니다.");
    return data;
  }

  async function run() {
    const keywords = input.split(/[,\n]/).map((v) => v.trim()).filter(Boolean).slice(0, 5);
    if (!keywords.length) return;
    setLoading(true); setError(""); setSearched(keywords);
    const results = await Promise.allSettled([
      call({ action: "keywords", keywords }),
      call({ action: "trend", groups: keywords.map((k) => ({ name: k, keywords: [k] })), startDate: monthsAgo(months), endDate: today(), timeUnit: months > 3 ? "month" : "week" }),
      ...(["news", "blog", "cafearticle"] as const).map((type) => call({ action: "content", type, query: keywords[0], display: 5, sort: type === "news" ? "date" : "sim" })),
    ]);
    const [k, t, news, blog, cafe] = results;
    setKw(k.status === "fulfilled" ? k.value.keywords : []);
    setTrends(t.status === "fulfilled" ? t.value.results : []);
    setContents({ news: news.status === "fulfilled" ? news.value : { total: 0, items: [] }, blog: blog.status === "fulfilled" ? blog.value : { total: 0, items: [] }, cafearticle: cafe.status === "fulfilled" ? cafe.value : { total: 0, items: [] } });
    const failed = results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason?.message);
    if (failed.length) setError(failed.join(" / "));
    setLoading(false);
  }

  return (
    <section className="report market">
      <div className="viz-card market-search">
        <div><b>키워드 · 시장 인사이트</b><span className="viz-sub">키워드를 쉼표로 구분해 최대 5개까지 넣으세요. 검색량은 네이버 키워드도구, 추이는 검색어 트렌드, 반응은 뉴스·블로그·카페 검색 결과예요. 같은 검색은 하루 동안 저장된 결과를 다시 써요.</span></div>
        <div className="market-input">
          <input className="account-search" value={input} placeholder="예: 모션데스크, 컴퓨터책상, 독서실책상" onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void run()} />
          <select className="mini-select" value={months} onChange={(e) => setMonths(Number(e.target.value))}><option value={3}>최근 3개월</option><option value={12}>최근 12개월</option><option value={24}>최근 24개월</option></select>
          <button className="primary" disabled={loading || !input.trim()} onClick={() => void run()}>{loading ? "조회 중…" : "조회"}</button>
          <button className="secondary" disabled={!input.trim()} onClick={() => onAsk(`다음 키워드의 시장 상황을 분석해줘: ${input}. 검색량(market_keywords), 최근 ${months}개월 추이(market_trend), 뉴스·블로그·카페 반응(market_content)을 근거로 시즌성, 수요 변화, 소비자 관심 포인트, 광고 운영 시사점(키워드 확장·예산 배분·소재 메시지)을 정리해줘.`)}>✦ AI 분석</button>
        </div>
      </div>
      {error && <div className="connection-error"><b>일부 조회 실패</b><span>{error}</span></div>}

      {trends.length > 0 && <article className="viz-card">
        <div className="viz-head"><span className="viz-title">검색어 트렌드 (최대값 = 100)</span><div className="legend">{trends.map((t, i) => <span key={t.name}><i style={{ background: SERIES[i] }} />{t.name}</span>)}</div></div>
        <TrendChart trends={trends} />
      </article>}

      {kw.length > 0 && <article className="viz-card table-card"><div className="viz-head" style={{ padding: "16px 18px 0" }}><span className="viz-title">월간 검색수 · 연관 키워드</span></div><div className="table-wrap">
        <table className="campaign-table"><thead><tr><th>키워드</th><th>월간 검색수</th><th>PC</th><th>모바일</th><th>월평균 클릭</th><th>평균 CTR</th><th>경쟁도</th><th>광고 노출 수</th></tr></thead>
          <tbody>{kw.map((k) => <tr key={k.keyword} className={searched.some((s) => s.replace(/\s/g, "") === k.keyword) ? "selected-row" : ""}>
            <td><b>{k.keyword}</b></td><td><b>{k.total.toLocaleString()}</b></td><td>{k.pc.toLocaleString()}</td><td>{k.mobile.toLocaleString()}</td><td>{k.clicks.toLocaleString()}</td><td>{k.ctr}%</td><td>{k.competition}</td><td>{k.adDepth}</td>
          </tr>)}</tbody></table></div></article>}

      {Object.keys(contents).length > 0 && <div className="content-grid">{([["news", "뉴스 (최신순)"], ["blog", "블로그"], ["cafearticle", "카페"]] as const).map(([type, label]) => <article key={type} className="viz-card">
        <div className="viz-head"><span className="viz-title">{label} · "{searched[0]}"</span><span className="viz-sub">전체 {(contents[type]?.total || 0).toLocaleString()}건</span></div>
        <ul className="content-list">{(contents[type]?.items || []).map((item) => <li key={item.link}><a href={item.link} target="_blank" rel="noreferrer">{item.title}</a><p>{item.description}</p><small>{[item.source, item.date].filter(Boolean).join(" · ")}</small></li>)}</ul>
      </article>)}</div>}

      {!kw.length && !trends.length && !loading && <div className="empty-state"><b>키워드를 넣고 조회해 보세요.</b><span>AI 어시스턴트(오른쪽 아래 ✦)에서도 언제든 "모션데스크 시장 어때?"처럼 물어보면 같은 데이터를 찾아 답해요.</span></div>}
    </section>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Campaign, Channel } from "@/lib/types";
import { channelsFromLines, lineGroup, lineMatches, matchMix, parseMixAttachment, type MediaMix, type MixLine } from "@/lib/mix";
import { CHANNEL_LABEL, periodRange } from "./report-view";

const won = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
const compact = (v: number) => v >= 100_000_000 ? `${(v / 100_000_000).toFixed(1)}억` : v >= 10_000 ? `${Math.round(v / 10_000).toLocaleString()}만` : Math.round(v).toLocaleString();
const isRunning = (c: Campaign) => c.active ?? c.status === "on";
const UNASSIGNED = "__unassigned__";

function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

/** 키워드가 없는 라인은 라인 이름이 캠페인 이름에 들어 있으면 그걸 키워드로 쓴다 (AI 없이) */
function ruleKeywords(lines: MixLine[], campaigns: Campaign[]) {
  return lines.map((line) => {
    if (line.keywords.length || line.campaignIds.length || !line.name) return line;
    const candidate = { ...line, keywords: [line.name] };
    return campaigns.some((c) => lineMatches(candidate, c)) ? candidate : line;
  });
}

/**
 * 믹스 매핑: 믹스(엑셀·CSV·붙여넣기)만 넣으면 라인을 만들고 캠페인을 추론해 붙인다.
 * 잘못 붙은 캠페인은 끌어서 다른 라인이나 미분류로 옮긴다(직접 지정이 키워드보다 우선).
 */
export function MixMappingView({ advertiserId, mixes, campaigns, onSave }: {
  advertiserId: string;
  mixes: MediaMix[];
  campaigns: Campaign[];
  onSave: (mix: MediaMix) => Promise<void>;
}) {
  const thisMonth = periodRange("this_month").month;
  const [month, setMonth] = useState(thisMonth);
  const saved = mixes.find((m) => m.month === month);
  const [lines, setLines] = useState<MixLine[]>(saved?.lines || []);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [importOpen, setImportOpen] = useState(!saved?.lines?.length);
  const [pasteText, setPasteText] = useState("");
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState<Channel | "">("");
  const [dragOver, setDragOver] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLines(saved?.lines || []); setDirty(false); setNotice(""); setImportOpen(!saved?.lines?.length); }, [month, saved?.updatedAt, advertiserId]);

  // 매칭 대상: 운영 중이거나 이번 달 광고비가 있는 캠페인 (지난 달 믹스는 운영 중인 것만)
  const pool = useMemo(() => campaigns.filter((c) => isRunning(c) || (month === thisMonth && c.spend > 0)), [campaigns, month, thisMonth]);
  const { results, unassigned } = useMemo(() => matchMix(lines, pool), [lines, pool]);
  const byLine = useMemo(() => new Map(results.map((r) => [r.line.id, r])), [results]);
  const groups = useMemo(() => [...new Set(lines.map(lineGroup))], [lines]);
  const linked = results.reduce((s, r) => s + r.campaigns.length, 0);
  const emptyLines = results.filter((r) => !r.campaigns.length).length;
  const unassignedSpend = unassigned.reduce((s, c) => s + c.spend, 0);

  function change(next: MixLine[]) { setLines(next); setDirty(true); }

  // ---- 믹스 넣기 → 라인 만들기 → 캠페인 추론 ----
  async function aiParse(payload: { text?: string; lines?: MixLine[] }) {
    const names = pool.map((c) => ({ channel: c.channel, name: c.name }));
    const response = await fetch("/api/mix/parse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, month, campaigns: names }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "AI 정리에 실패했습니다.");
    return data as { lines: MixLine[] };
  }
  async function importMix(text: string, source: string) {
    if (!text.trim()) return;
    setNotice("");
    try {
      // 1) 표면 그대로 읽기(AI 없음) → 2) 안 되면 AI가 표/메모를 라인으로 정리
      setBusy("표를 읽는 중…");
      let next = parseMixAttachment(text);
      let how = "표를 그대로 읽었어요";
      if (!next?.length) {
        setBusy("AI가 믹스를 라인으로 정리하는 중…");
        next = (await aiParse({ text })).lines;
        how = "AI가 믹스를 정리했어요";
      }
      if (!next.length) throw new Error("믹스에서 예산 라인을 찾지 못했어요.");
      // 3) 이름이 캠페인과 겹치면 규칙으로 연결 → 4) 남은 라인만 AI가 실제 캠페인 이름을 보고 키워드 추론
      next = ruleKeywords(next, pool);
      const missing = next.filter((l) => !l.keywords.length && !l.campaignIds.length);
      let aiNote = "";
      if (missing.length) {
        setBusy(`캠페인 연결을 추론하는 중… (${missing.length}개 라인)`);
        try {
          const ai = await aiParse({ lines: missing });
          next = next.map((l) => { const i = missing.findIndex((m) => m.id === l.id); return i >= 0 && ai.lines[i] ? { ...l, keywords: ai.lines[i].keywords, excludes: ai.lines[i].excludes } : l; });
          aiNote = ` · ${missing.length}개 라인은 AI가 캠페인을 추론했어요`;
        } catch { aiNote = ` · ${missing.length}개 라인은 추론하지 못했어요(직접 끌어다 놓아 주세요)`; }
      }
      change(next);
      setImportOpen(false); setPasteText("");
      setNotice(`${source}: ${how} — 라인 ${next.length}개${aiNote}. 아래에서 확인하고 잘못 붙은 캠페인은 끌어서 옮긴 뒤 저장하세요.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "믹스를 읽지 못했어요.");
    } finally { setBusy(""); }
  }
  async function onFile(file: File | undefined) {
    if (!file) return;
    const lower = file.name.toLowerCase();
    let text = "";
    if (/\.(xlsx|xlsm|xls)$/.test(lower)) {
      const XLSX = await import("xlsx");
      const book = XLSX.read(await file.arrayBuffer(), { type: "array" });
      text = book.SheetNames.map((name) => `## 시트: ${name}\n${XLSX.utils.sheet_to_csv(book.Sheets[name], { blankrows: false })}`).join("\n\n");
    } else text = await file.text();
    if (fileRef.current) fileRef.current.value = "";
    await importMix(text, file.name);
  }

  // ---- 끌어서 옮기기 ----
  function move(campaign: Campaign, toLineId: string) {
    let next = lines.map((l) => ({ ...l, campaignIds: l.campaignIds.filter((id) => id !== campaign.id), excludes: toLineId === l.id ? l.excludes.filter((w) => w !== campaign.name) : l.excludes }));
    if (toLineId === UNASSIGNED) {
      // 키워드로 다시 걸리지 않게, 걸리는 라인마다 이 캠페인 이름을 제외에 넣는다
      for (let guard = 0; guard < next.length; guard++) {
        const hit = next.find((l) => lineMatches(l, campaign));
        if (!hit) break;
        next = next.map((l) => l.id === hit.id ? { ...l, excludes: [...l.excludes, campaign.name] } : l);
      }
    } else next = next.map((l) => l.id === toLineId ? { ...l, campaignIds: [...l.campaignIds, campaign.id] } : l);
    change(next);
  }
  const campaignById = useMemo(() => new Map(pool.map((c) => [c.id, c])), [pool]);
  function onDrop(e: React.DragEvent, toLineId: string) {
    e.preventDefault(); setDragOver("");
    const campaign = campaignById.get(e.dataTransfer.getData("text/campaign-id"));
    if (campaign) move(campaign, toLineId);
  }
  const dropProps = (id: string) => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); if (dragOver !== id) setDragOver(id); },
    onDragLeave: () => setDragOver((cur) => cur === id ? "" : cur),
    onDrop: (e: React.DragEvent) => onDrop(e, id),
  });

  async function save() {
    setBusy("저장 중…");
    try {
      const base: MediaMix = saved || { id: crypto.randomUUID(), advertiserId, month, status: "draft", targetRoas: 0, channels: {}, notes: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await onSave({ ...base, lines, channels: lines.some((l) => l.channel !== "all") ? { ...base.channels, ...channelsFromLines(lines) } : base.channels });
      setDirty(false); setNotice("저장했어요. 리포트·매체별 데이터의 믹스구분 보기에 바로 반영돼요.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "저장하지 못했어요."); }
    finally { setBusy(""); }
  }

  const chip = (c: Campaign, from: string, pinned?: boolean) => (
    <li key={c.id} className={`map-chip${isRunning(c) ? "" : " muted"}`} draggable onDragStart={(e) => { e.dataTransfer.setData("text/campaign-id", c.id); e.dataTransfer.effectAllowed = "move"; }} title={`${c.accountName || ""} · 끌어서 다른 라인으로 옮기세요`}>
      <span className={`channel ${c.channel}`}>{CHANNEL_LABEL[c.channel].replace("네이버 ", "")}</span>
      <span className="map-chip-name">{c.name}</span>
      <em>{c.spend ? compact(c.spend) : "–"}{pinned ? " · 📌" : ""}</em>
      <select className="mini-select" value="" aria-label="라인 이동" onChange={(e) => e.target.value && move(c, e.target.value)}>
        <option value="">이동…</option>
        {from !== UNASSIGNED && <option value={UNASSIGNED}>미분류로 빼기</option>}
        {groups.map((g) => <optgroup key={g} label={g}>{lines.filter((l) => lineGroup(l) === g && l.id !== from).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</optgroup>)}
      </select>
    </li>
  );

  const filteredUnassigned = unassigned
    .filter((c) => (!channelFilter || c.channel === channelFilter) && (!search || c.name.toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => b.spend - a.spend);

  return (
    <section className="mix-mapping">
      <div className="mix-head">
        <div className="month-picker">
          <button className="secondary" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="이전 달">‹</button>
          <b>{month}</b>
          <button className="secondary" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="다음 달">›</button>
          <span className="viz-sub">{lines.length ? `라인 ${lines.length}개 · 캠페인 ${linked}개 연결 · 빈 라인 ${emptyLines}개 · 미분류 ${unassigned.length}개(${won.format(unassignedSpend)})` : "아직 믹스가 없어요"}</span>
        </div>
        <div className="mix-actions">
          <button className="secondary" onClick={() => setImportOpen(!importOpen)}>믹스 넣기</button>
          {!lines.length && mixes.find((m) => m.month === shiftMonth(month, -1))?.lines?.length ? <button className="secondary" onClick={() => change(mixes.find((m) => m.month === shiftMonth(month, -1))!.lines!.map((l) => ({ ...l, id: crypto.randomUUID() })))}>지난달 매핑 복사</button> : null}
          <button className="primary" disabled={!dirty || !!busy} onClick={() => void save()}>{dirty ? "저장" : "저장됨"}</button>
        </div>
      </div>

      {importOpen && <article className="viz-card map-import">
        <div className="viz-head"><span className="viz-title">믹스 넣기 · {month}</span><span className="viz-sub">믹스 파일만 넣으면 라인을 만들고 캠페인을 알아서 연결해요. 기존 매핑은 덮어써요(저장 전까지는 그대로).</span></div>
        <div className="mix-actions">
          <button className="primary" disabled={!!busy} onClick={() => fileRef.current?.click()}>엑셀·CSV 파일 선택</button>
          <input ref={fileRef} type="file" hidden accept=".xlsx,.xlsm,.xls,.csv,.tsv,.txt" onChange={(e) => void onFile(e.target.files?.[0])} />
        </div>
        <textarea rows={5} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder={"또는 엑셀에서 복사해 붙여넣기 (표·메모 형식 모두 가능)\n머리글에 믹스구분 / 매체 / 캠페인(키워드) / 월예산이 있으면 AI 없이 그대로 읽어요."} />
        <div className="mix-actions"><button className="secondary" disabled={!!busy || !pasteText.trim()} onClick={() => void importMix(pasteText, "붙여넣기")}>가져오기</button></div>
      </article>}
      {(busy || notice) && <p className="viz-sub notice-line">{busy ? <><span className="spinner inline" /> {busy}</> : notice}</p>}

      {lines.length > 0 && <div className="map-board">
        <aside className={`map-unassigned${dragOver === UNASSIGNED ? " over" : ""}`} {...dropProps(UNASSIGNED)}>
          <div className="viz-head"><span className="viz-title">미분류 {unassigned.length}</span><small className="viz-sub">{won.format(unassignedSpend)}</small></div>
          <div className="map-filter">
            <select className="mini-select" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value as Channel | "")}><option value="">전체 매체</option>{(["naver_sa", "naver_gfa", "meta", "google_ads"] as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}</select>
            <input className="note-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="캠페인 검색" />
          </div>
          <ul className="map-list">{filteredUnassigned.slice(0, 200).map((c) => chip(c, UNASSIGNED))}</ul>
          {!filteredUnassigned.length && <small className="viz-sub">여기로 끌어다 놓으면 라인에서 빠져요.</small>}
        </aside>
        <div className="map-groups">
          {groups.map((g) => {
            const groupLines = results.filter((r) => lineGroup(r.line) === g);
            const budget = groupLines.reduce((s, r) => s + r.line.budget, 0), spend = groupLines.reduce((s, r) => s + r.spend, 0);
            return <div key={g} className="map-group">
              <div className="map-group-head"><b>{g}</b><span className="viz-sub">{compact(spend)} / {compact(budget)}</span></div>
              <div className="map-lines">{groupLines.map(({ line }) => {
                const r = byLine.get(line.id)!;
                return <div key={line.id} className={`map-line${dragOver === line.id ? " over" : ""}${r.campaigns.length ? "" : " empty"}`} {...dropProps(line.id)}>
                  <div className="map-line-head">
                    <span className={`channel ${line.channel}`}>{line.channel === "all" ? "전체" : CHANNEL_LABEL[line.channel as Channel].replace("네이버 ", "")}</span>
                    <b title={line.note || ""}>{line.name}</b>
                    <span className="viz-sub">{compact(r.spend)} / {compact(line.budget)}</span>
                  </div>
                  <ul className="map-list">{r.campaigns.sort((a, b) => b.spend - a.spend).map((c) => chip(c, line.id, line.campaignIds.includes(c.id)))}</ul>
                  {!r.campaigns.length && <small className="viz-sub">연결된 캠페인 없음 — 미분류에서 끌어다 놓으세요{line.keywords.length ? ` (키워드: ${line.keywords.join(", ")})` : ""}</small>}
                </div>;
              })}</div>
            </div>;
          })}
        </div>
      </div>}
      {lines.length > 0 && <small className="viz-sub">📌 = 직접 옮긴 캠페인(키워드보다 우선). 미분류로 뺀 캠페인은 그 라인 키워드에서 제외돼요. 다음 달은 '지난달 매핑 복사'로 그대로 이어 쓸 수 있어요.</small>}
    </section>
  );
}

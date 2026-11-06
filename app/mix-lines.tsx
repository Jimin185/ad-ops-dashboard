"use client";

import { useMemo, useState } from "react";
import type { Campaign, Channel } from "@/lib/types";
import { lineGroup, lineMatches, matchMix, parseMixTable, type LineResult, type MixLine } from "@/lib/mix";
import { CHANNEL_LABEL, CHANNEL_ORDER } from "./report-view";

const won = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
const compact = (v: number) => v >= 100_000_000 ? `${(v / 100_000_000).toFixed(1)}억` : v >= 10_000 ? `${Math.round(v / 10_000).toLocaleString()}만` : Math.round(v).toLocaleString();
const blankLine = (): MixLine => ({ id: crypto.randomUUID(), name: "", channel: "all", budget: 0, targetRoas: 0, keywords: [], excludes: [], campaignIds: [] });
const isRunning = (c: Campaign) => c.active ?? c.status === "on";

/** 키워드가 없는 라인은 라인 이름 자체가 캠페인 이름에 들어 있으면 그걸 키워드로 쓴다 (AI 없이). */
function autoKeywords(lines: MixLine[], campaigns: Campaign[]) {
  return lines.map((line) => {
    if (line.keywords.length || !line.name) return line;
    const candidate = { ...line, keywords: [line.name] };
    return campaigns.some((c) => lineMatches(candidate, c)) ? candidate : line;
  });
}

export function MixLines({ lines, onChange, campaigns, monthProgress, isCurrentMonth, previousLines, onOpenCampaign }: {
  onOpenCampaign?: (campaignId: string) => void;
  lines: MixLine[];
  onChange: (lines: MixLine[]) => void;
  campaigns: Campaign[];
  monthProgress: number; // 0~1, 이번 달 경과 비율
  isCurrentMonth: boolean;
  previousLines?: MixLine[];
}) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  // 매칭 대상: 운영 중이거나 이번 달 광고비가 있는 캠페인
  const pool = useMemo(() => campaigns.filter((c) => isRunning(c) || c.spend > 0), [campaigns]);
  const { results, unassigned } = useMemo(() => matchMix(lines, pool), [lines, pool]);
  const unassignedSpend = unassigned.reduce((s, c) => s + c.spend, 0);
  const totalBudget = lines.reduce((s, l) => s + l.budget, 0);
  const totalSpend = results.reduce((s, r) => s + r.spend, 0);
  const campaignNames = useMemo(() => pool.filter(isRunning).map((c) => ({ channel: c.channel, name: c.name })), [pool]);

  const groups = useMemo(() => [...new Set(lines.map(lineGroup))], [lines]);
  const update = (id: string, patch: Partial<MixLine>) => onChange(lines.map((l) => l.id === id ? { ...l, ...patch } : l));

  async function callAi(payload: { text?: string; lines?: MixLine[] }) {
    const response = await fetch("/api/mix/parse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, campaigns: campaignNames }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "AI 정리에 실패했습니다.");
    return data as { lines: MixLine[]; usage?: { input: number; output: number } };
  }

  async function importPaste(forceAi = false) {
    setBusy(true); setNotice("");
    try {
      const table = forceAi ? null : parseMixTable(pasteText);
      if (table) {
        let next = autoKeywords(table, pool);
        const missing = next.filter((l) => !l.keywords.length);
        // 표는 AI 없이 읽고, 캠페인을 못 찾은 라인만 AI에게 키워드를 물어본다
        if (missing.length) {
          const ai = await callAi({ lines: missing });
          next = next.map((l) => { const i = missing.findIndex((m) => m.id === l.id); return i >= 0 && ai.lines[i] ? { ...l, keywords: ai.lines[i].keywords, excludes: ai.lines[i].excludes } : l; });
          setNotice(`표에서 ${table.length}개 라인을 읽었어요. 캠페인을 못 찾은 ${missing.length}개만 AI가 키워드를 골랐어요 (토큰 ${ai.usage ? ai.usage.input + ai.usage.output : "?"}개).`);
        } else setNotice(`표에서 ${table.length}개 라인을 읽었어요. AI는 쓰지 않았어요.`);
        onChange(next);
      } else {
        const ai = await callAi({ text: pasteText });
        onChange(ai.lines);
        setNotice(`AI가 ${ai.lines.length}개 라인으로 정리했어요 (토큰 ${ai.usage ? ai.usage.input + ai.usage.output : "?"}개). 키워드를 확인해 주세요.`);
      }
      setPasteOpen(false); setPasteText("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "가져오지 못했습니다.");
    } finally { setBusy(false); }
  }

  async function suggestKeywords() {
    const missing = lines.filter((l) => !l.keywords.length && l.name);
    if (!missing.length) return;
    setBusy(true); setNotice("");
    try {
      const ai = await callAi({ lines: missing });
      onChange(lines.map((l) => { const i = missing.findIndex((m) => m.id === l.id); return i >= 0 && ai.lines[i] ? { ...l, keywords: ai.lines[i].keywords, excludes: ai.lines[i].excludes } : l; }));
      setNotice(`${missing.length}개 라인의 키워드를 추천받았어요 (토큰 ${ai.usage ? ai.usage.input + ai.usage.output : "?"}개).`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "추천에 실패했습니다."); }
    finally { setBusy(false); }
  }

  function assign(campaign: Campaign, lineId: string) {
    onChange(lines.map((l) => l.id === lineId ? { ...l, campaignIds: [...new Set([...l.campaignIds, campaign.id])] } : { ...l, campaignIds: l.campaignIds.filter((id) => id !== campaign.id) }));
  }
  function unpin(line: MixLine, campaign: Campaign) {
    // 직접 지정이면 해제, 키워드로 걸린 거면 제외 키워드에 캠페인 이름을 추가
    if (line.campaignIds.includes(campaign.id)) update(line.id, { campaignIds: line.campaignIds.filter((id) => id !== campaign.id) });
    else update(line.id, { excludes: [...line.excludes, campaign.name] });
  }

  return (
    <article className="viz-card">
      <div className="viz-head">
        <span className="viz-title">믹스 라인 · 운영 효율{isCurrentMonth ? " (이번 달 누적)" : ""}</span>
        <div className="mix-actions">
          <button className="secondary" onClick={() => setPasteOpen(!pasteOpen)}>붙여넣기로 가져오기</button>
          {previousLines?.length ? <button className="secondary" onClick={() => onChange(previousLines.map((l) => ({ ...l, id: crypto.randomUUID() })))}>지난달 라인 복사</button> : null}
          {lines.some((l) => !l.keywords.length && l.name) && <button className="secondary" disabled={busy} onClick={() => void suggestKeywords()}>✦ 빈 키워드 AI 추천</button>}
          <button className="secondary" onClick={() => onChange([...lines, blankLine()])}>+ 라인</button>
        </div>
      </div>

      {pasteOpen && <div className="paste-box">
        <textarea rows={6} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder={"엑셀·시트에서 복사해 붙여넣으세요. 예)\n구분\t매체\t예산\t목표ROAS\t키워드\n아이책상 기획전\tGFA\t2,000만\t400\t아이책상\nB2C 리타겟팅\t메타\t1,500만\t380\tB2C\n\n표가 아니어도 돼요 (메모 형식은 AI가 정리)"} />
        <div className="mix-actions">
          <button className="primary" disabled={busy || !pasteText.trim()} onClick={() => void importPaste(false)}>{busy ? "정리 중…" : "가져오기"}</button>
          <button className="secondary" disabled={busy || !pasteText.trim()} onClick={() => void importPaste(true)}>AI로 정리</button>
          <small className="viz-sub">표 형식(머리글에 구분/매체/예산)이면 AI 없이 바로 읽어요. 기존 라인은 덮어씁니다.</small>
        </div>
      </div>}
      {notice && <p className="viz-sub notice-line">{notice}</p>}

      {lines.length ? <div className="table-wrap"><table className="campaign-table mix-table lines-table">
        <thead><tr><th>믹스구분 · 라인</th><th>매체</th><th>월 예산</th><th>목표 ROAS</th><th>캠페인 키워드</th><th>연결</th><th>집행 · 페이싱</th><th>ROAS</th><th /></tr></thead>
        <tbody>{groupResults(results).flatMap(({ group, items, budget: gBudget, spend: gSpend, roas: gRoas }) => [
          groups.length > 1 && <tr key={`g-${group}`} className="group-row"><td colSpan={2}><b>{group}</b> <small className="viz-sub">{items.length}개 라인</small></td><td>{won.format(gBudget)}</td><td /><td /><td>{items.reduce((s, r) => s + r.campaigns.length, 0)}개</td>
            <td><div className="pace-cell"><b>{compact(gSpend)}</b>{gBudget ? <small> / {compact(gBudget)}</small> : null}</div>{gBudget && isCurrentMonth ? <small className="viz-sub">소진 {Math.round(gSpend / gBudget * 100)}% · 경과 {Math.round(monthProgress * 100)}%</small> : null}</td>
            <td><b>{gSpend ? `${Math.round(gRoas)}%` : "–"}</b></td><td /></tr>,
          ...items.map(({ line, campaigns: list, spend, roas }) => {
          const expected = line.budget * monthProgress;
          const pacing = expected ? spend / expected : 0;
          const pace = !line.budget || !isCurrentMonth ? "" : pacing > 1.15 ? "over" : pacing < 0.85 ? "under" : "ok";
          return [
            <tr key={line.id}>
              <td><input className="note-input group-input" value={line.group || ""} placeholder="믹스구분" title="믹스구분 (리포트를 이 단위로 묶어요)" onChange={(e) => update(line.id, { group: e.target.value || undefined })} /><input className="note-input" value={line.name} placeholder="라인 이름" onChange={(e) => update(line.id, { name: e.target.value })} /></td>
              <td><select className="mini-select" value={line.channel} onChange={(e) => update(line.id, { channel: e.target.value as Channel | "all" })}><option value="all">전체</option>{CHANNEL_ORDER.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}</select></td>
              <td><input className="num-input" inputMode="numeric" value={line.budget ? line.budget.toLocaleString() : ""} placeholder="0" onChange={(e) => update(line.id, { budget: Number(e.target.value.replace(/[^0-9]/g, "")) || 0 })} /></td>
              <td><input className="num-input short" inputMode="numeric" value={line.targetRoas || ""} placeholder="0" onChange={(e) => update(line.id, { targetRoas: Number(e.target.value.replace(/[^0-9]/g, "")) || 0 })} /></td>
              <td><input className="note-input" value={line.keywords.join(", ")} placeholder="캠페인 이름에 들어간 단어" onChange={(e) => update(line.id, { keywords: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} />
                {line.excludes.length ? <small className="exclude-hint" title={line.excludes.join(", ")}>제외 {line.excludes.length}개 <button className="link-button" onClick={() => update(line.id, { excludes: [] })}>초기화</button></small> : null}</td>
              <td><button className={`link-button ${list.length ? "" : "danger"}`} onClick={() => setExpanded(expanded === line.id ? null : line.id)}>{list.length}개</button></td>
              <td>
                <div className="pace-cell"><b>{compact(spend)}</b>{line.budget ? <small> / {compact(line.budget)}</small> : null}</div>
                {line.budget ? <div className="pace-track"><div className={`pace-fill ${pace}`} style={{ width: `${Math.min(100, spend / line.budget * 100)}%` }} />{isCurrentMonth && <i style={{ left: `${Math.min(100, monthProgress * 100)}%` }} />}</div> : null}
                {pace && <small className={`pace-label ${pace}`}>{pace === "over" ? "과소진" : pace === "under" ? "소진 부족" : "정상"} {Math.round(pacing * 100)}%</small>}
              </td>
              <td className={line.targetRoas && spend ? (roas >= line.targetRoas ? "good-text" : "bad-text") : ""}><b>{spend ? `${Math.round(roas)}%` : "–"}</b>{line.targetRoas ? <small className="viz-sub"><br />목표 {line.targetRoas}%</small> : null}</td>
              <td><button className="link-button danger" onClick={() => onChange(lines.filter((l) => l.id !== line.id))}>삭제</button></td>
            </tr>,
            expanded === line.id && <tr key={`${line.id}-x`} className="expand-row"><td colSpan={9}>
              {list.length ? <ul className="line-campaigns">{list.sort((a, b) => b.spend - a.spend).map((c) => <li key={c.id}>
                <span className={`channel ${c.channel}`}>{CHANNEL_LABEL[c.channel]}</span><button className={`link-button campaign-link ${isRunning(c) ? "" : "muted"}`} onClick={() => onOpenCampaign?.(c.id)}>{c.name}</button>
                <em>{won.format(c.spend)} · ROAS {c.roas}%{line.campaignIds.includes(c.id) ? " · 직접 지정" : ""}</em>
                <button className="link-button" onClick={() => unpin(line, c)}>빼기</button></li>)}</ul>
                : <span className="viz-sub">연결된 캠페인이 없어요. 키워드를 바꾸거나 아래 미분류 캠페인에서 직접 지정하세요.</span>}
            </td></tr>,
          ];
        })])}</tbody>
        <tfoot><tr><td colSpan={2}><b>합계</b></td><td>{won.format(totalBudget)}</td><td /><td /><td /><td><b>{compact(totalSpend)}</b>{totalBudget ? <small> / {compact(totalBudget)}</small> : null}</td><td /><td /></tr></tfoot>
      </table></div> : <div className="empty-state"><b>믹스 라인이 없습니다.</b><span>시트의 믹스를 붙여넣거나 지난달 라인을 복사해 시작하세요. 채널 단위로만 계획해도 괜찮아요.</span></div>}

      {lines.length > 0 && unassigned.length > 0 && <details className="unassigned">
        <summary>미분류 캠페인 {unassigned.length}개 · 광고비 {won.format(unassignedSpend)}</summary>
        <ul className="line-campaigns">{unassigned.sort((a, b) => b.spend - a.spend).slice(0, 100).map((c) => <li key={c.id}>
          <span className={`channel ${c.channel}`}>{CHANNEL_LABEL[c.channel]}</span><span className={isRunning(c) ? "" : "muted"}>{c.name}</span><em>{won.format(c.spend)}</em>
          <select className="mini-select" value="" onChange={(e) => e.target.value && assign(c, e.target.value)}><option value="">라인 지정…</option>{groups.map((g) => <optgroup key={g} label={g}>{lines.filter((l) => lineGroup(l) === g).map((l) => <option key={l.id} value={l.id}>{l.name || "(이름 없음)"}</option>)}</optgroup>)}</select>
        </li>)}</ul>
      </details>}
    </article>
  );
}

/** 라인 결과를 믹스구분별로 묶는다(라인에 나온 순서 유지) */
export function groupResults(results: LineResult[]) {
  const order: string[] = [];
  const map = new Map<string, LineResult[]>();
  for (const r of results) { const g = lineGroup(r.line); if (!map.has(g)) { map.set(g, []); order.push(g); } map.get(g)!.push(r); }
  return order.map((group) => {
    const items = map.get(group)!;
    const budget = items.reduce((s, r) => s + r.line.budget, 0), spend = items.reduce((s, r) => s + r.spend, 0), revenue = items.reduce((s, r) => s + r.revenue, 0);
    return { group, items, budget, spend, revenue, roas: spend ? revenue / spend * 100 : 0 };
  });
}

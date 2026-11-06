"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Campaign, Channel, ChangeOperation } from "@/lib/types";
import { channelsFromLines, expectedSpend, lineGroup, lineMatches, matchMix, mergePeriodLines, parseMixAttachment, periodAdvice, type MediaMix, type MixLine, type MixPeriod } from "@/lib/mix";
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
export function MixMappingView({ advertiserId, mixes, campaigns, onSave, onExclude, onApplyOps, apiFetch, excludedCount = 0 }: {
  onExclude?: (campaign: Campaign) => void;
  excludedCount?: number;
  advertiserId: string;
  mixes: MediaMix[];
  campaigns: Campaign[];
  onSave: (mix: MediaMix) => Promise<void>;
  /** 일예산 일괄 적용 (page의 applyOps — 성공분은 화면에도 반영됨) */
  onApplyOps?: (ops: ChangeOperation[]) => Promise<void>;
  /** 네이버 SA 토큰 헤더가 붙는 fetch (광고그룹 예산 조회용) */
  apiFetch?: (url: string, init?: RequestInit) => Promise<Response>;
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
  const [layout, setLayout] = useState<"table" | "board">("table");
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
  const dim = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const today = Number(periodRange("this_month").until.slice(8, 10));
  const day = month === thisMonth ? today : month < thisMonth ? dim : 0;
  /** 기간별 예산 편집: "1-4 1000000, 5-30 5000000" (빈 값이면 기간 나누기 해제) */
  function editPeriods(line: MixLine) {
    const current = (line.periods || []).map((p) => `${p.from}-${p.to} ${p.budget}`).join(", ");
    const text = window.prompt(`'${line.name}' 기간별 예산 (그 달의 일 기준)\n예: 1-4 1000000, 5-30 5000000\n비우면 한 달 전체 ${line.budget.toLocaleString()}원으로 돌아가요.`, current || `1-${dim} ${line.budget}`);
    if (text === null) return;
    const periods: MixPeriod[] = text.split(/[,\n]/).map((part) => part.trim().match(/^(\d{1,2})\s*[-~]\s*(\d{1,2})\s*[: ]\s*([\d,]+)/)).filter(Boolean).map((m) => ({ from: Number(m![1]), to: Number(m![2]), budget: Number(m![3].replace(/,/g, "")) }));
    if (text.trim() && !periods.length) { window.alert("형식을 읽지 못했어요. 예: 1-4 1000000, 5-30 5000000"); return; }
    change(lines.map((l) => l.id !== line.id ? l : periods.length ? { ...l, periods: periods.sort((a, b) => a.from - b.from), budget: periods.reduce((s, p) => s + p.budget, 0) } : { ...l, periods: undefined }));
  }

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
        next = mergePeriodLines((await aiParse({ text })).lines);
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

  // ---- 예산 맞춰 일예산 일괄 세팅 ----
  // 라인의 남은 예산(기간 예산이 있으면 지금 구간 기준)을 남은 일수로 나눠 연결 캠페인에 배분한다.
  type BudgetRow = { campaign: Campaign; entityType: "campaign" | "adgroup"; targetId: string; targetName: string; lineName: string; current: number; next: number; checked: boolean; note: string; warn: boolean };
  type PlanGroups = Map<string, Array<{ id: string; name: string; dailyBudget: number; lifetimeBudget?: number; active?: boolean; status: string }>>;
  const [plan, setPlan] = useState<BudgetRow[] | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const BIG = 500_000; // 일예산 경고 기준
  // 매체별 마크업 %. 믹스 금액은 마크업 포함이므로 매체 집행액 = 금액 ÷ (1 + m/100).
  const [markup, setMarkup] = useState<Record<string, number>>({});
  const planGroupsRef = useRef<PlanGroups>(new Map());
  useEffect(() => { try { setMarkup(JSON.parse(localStorage.getItem(`adops-markup:${advertiserId}`) || "{}")); } catch { setMarkup({}); } }, [advertiserId]);
  // 달·광고주가 바뀌면 광고그룹 캐시와 열린 플랜을 비운다
  useEffect(() => { planGroupsRef.current = new Map(); setPlan(null); }, [month, advertiserId]);
  /** 네이버 SA·GFA 하루예산 입력칸은 VAT 포함 기준 → 매체 집행액에 ×1.1 해서 넣는다 */
  const vat = (channel: Channel) => channel === "naver_sa" || channel === "naver_gfa" ? 1.1 : 1;
  function setMarkupRate(channel: Channel, value: number, rebuild: boolean) {
    const next = { ...markup, [channel]: value };
    setMarkup(next);
    try { localStorage.setItem(`adops-markup:${advertiserId}`, JSON.stringify(next)); } catch { /* 저장 실패해도 계산은 됨 */ }
    if (rebuild) computePlan(planGroupsRef.current, next);
  }

  function rowOf(base: Omit<BudgetRow, "checked" | "note" | "warn">, extraNote = "", forceOff = ""): BudgetRow {
    const { current, next } = base;
    const exhausted = next < 100;
    const warn = !forceOff && !exhausted && (next >= BIG || (current > 0 && next >= current * 10));
    return {
      ...base, warn,
      checked: !forceOff && !exhausted && next !== current,
      note: forceOff ? forceOff : exhausted ? "남은 예산 없음 — OFF 검토" : next === current ? "현재와 동일" :
        warn ? (next >= BIG ? `${won.format(BIG)} 이상 — 자릿수 확인!` : `현재의 ${Math.round(next / Math.max(current, 1))}배 — 확인 필요`) : extraNote,
    };
  }

  /**
   * 믹스 금액(마크업 포함) → 매체 집행액 환산 후 배분한다.
   * 캠페인 예산이 없는 캠페인(Meta ABO·GFA·네이버 그룹예산 운영)은 광고그룹 예산으로 내려간다.
   */
  function computePlan(groupsByCampaign: PlanGroups, rates = markup) {
    const rate = (channel: Channel) => 1 + (Number(rates[channel]) || 0) / 100;
    const daysLeft = Math.max(1, dim - day + 1);
    const rows: BudgetRow[] = [];
    for (const r of results) {
      if (!r.line.budget) continue;
      // 매체 소진액을 믹스 단위(마크업 포함)로 환산해 남은 예산을 계산한다
      const adjSpend = r.campaigns.reduce((s, c) => s + c.spend * rate(c.channel), 0);
      const advice = periodAdvice(r.line, adjSpend, day);
      const lineDaily = advice ? advice.daily : Math.max(0, r.line.budget - adjSpend) / daysLeft;
      const targets = r.campaigns.filter(isRunning);
      if (!targets.length) continue;
      const baseNote = advice ? `${advice.period.from}~${advice.period.to}일 구간 · 남은 ${advice.daysLeft}일` : `남은 ${daysLeft}일 기준`;
      // 배분: 이번 달 소진 비중대로, 소진이 없으면 균등
      const spendSum = targets.reduce((s, c) => s + c.spend, 0);
      for (const c of targets) {
        const share = spendSum > 0 ? c.spend / spendSum : 1 / targets.length;
        const m = Number(rates[c.channel]) || 0;
        // 믹스 몫 → 마크업 제외(매체 집행액) → 네이버·GFA는 VAT 포함 입력(×1.1)
        const campTarget = lineDaily * share / rate(c.channel) * vat(c.channel);
        const convNote = [m ? `마크업 ${m}% 제외` : "", vat(c.channel) > 1 ? "VAT 포함 ×1.1" : ""].filter(Boolean).join(" · ");
        const note = [convNote, baseNote].filter(Boolean).join(" · ");
        const flat = c.channel === "naver_sa" && (c.product || "").includes("브랜드");
        if (flat) { rows.push(rowOf({ campaign: c, entityType: "campaign", targetId: c.id, targetName: c.name, lineName: r.line.name, current: c.dailyBudget || 0, next: Math.round(campTarget / 100) * 100 }, "", "브랜드검색은 정액제 — 일예산 없음")); continue; }
        const gvideo = c.channel === "google_ads" && (c.product || "").includes("동영상");
        if (gvideo) { rows.push(rowOf({ campaign: c, entityType: "campaign", targetId: c.id, targetName: c.name, lineName: r.line.name, current: c.dailyBudget || 0, next: Math.round(campTarget / 100) * 100 }, "", "구글 영상 캠페인은 API 수정 불가 — 구글애즈에서 수동 변경 (권장값 참고)")); continue; }
        // 캠페인 총예산(CBO lifetime)을 쓰면 광고세트 예산 설정이 매체에서 거절된다 (Meta subcode 1885621)
        if (!c.dailyBudget && c.lifetimeBudget) { rows.push(rowOf({ campaign: c, entityType: "campaign", targetId: c.id, targetName: c.name, lineName: r.line.name, current: 0, next: Math.round(campTarget / 100) * 100 }, "", "캠페인 총예산(CBO) 사용 — 일예산 없음, 매체 화면에서 총예산으로 관리 (권장 일액 참고)")); continue; }
        const groups = groupsByCampaign.get(c.id);
        if (!c.dailyBudget && c.channel !== "google_ads") {
          // 캠페인 예산 없음 → 광고그룹(광고세트) 예산으로 배분: 기존 그룹예산 비중대로, 없으면 균등
          const act = (groups || []).filter((g) => g.active ?? g.status === "on");
          const usable = act.length ? act : groups || [];
          if (!usable.length) { rows.push(rowOf({ campaign: c, entityType: "campaign", targetId: c.id, targetName: c.name, lineName: r.line.name, current: 0, next: Math.round(campTarget / 100) * 100 }, "", "캠페인 예산이 없고 광고그룹도 못 찾음 — 수동 확인")); continue; }
          const bsum = usable.reduce((s, g) => s + (g.dailyBudget || 0), 0);
          for (const g of usable) {
            const gshare = bsum > 0 ? (g.dailyBudget || 0) / bsum : 1 / usable.length;
            const next = Math.round(campTarget * gshare / 100) * 100;
            const lifetime = g.lifetimeBudget ? "총예산(기간) 사용 그룹 — 수동 확인" : "";
            rows.push(rowOf({ campaign: c, entityType: "adgroup", targetId: g.id, targetName: `${c.name} › ${g.name}`, lineName: r.line.name, current: g.dailyBudget || 0, next }, ["그룹예산 운영", note].filter(Boolean).join(" · "), lifetime));
          }
        } else {
          rows.push(rowOf({ campaign: c, entityType: "campaign", targetId: c.id, targetName: c.name, lineName: r.line.name, current: c.dailyBudget || 0, next: Math.round(campTarget / 100) * 100 },
            (c.channel === "google_ads" ? "공유예산이면 적용 시 거절돼요 · " : "") + note));
        }
      }
    }
    if (!rows.length) { setNotice("일예산을 계산할 라인이 없어요. 예산이 있는 라인에 운영 중 캠페인을 연결해 주세요."); return; }
    setPlan(rows.sort((a, b) => Number(b.checked) - Number(a.checked) || b.next - a.next));
  }
  async function buildPlan() {
    setBusy("예산 단위(캠페인/광고그룹)를 확인하는 중…");
    try {
      // 광고그룹 조회가 정말 필요한 캠페인만 추린다: 캠페인 예산도 총예산(CBO)도 없는 Meta·GFA·네이버 (브랜드검색 제외)
      const needGroups = results.flatMap((r) => r.line.budget ? r.campaigns.filter((c) => isRunning(c) && !c.dailyBudget && !c.lifetimeBudget
        && c.channel !== "google_ads" && !(c.channel === "naver_sa" && (c.product || "").includes("브랜드"))) : []);
      const groupsByCampaign = planGroupsRef.current; // 한 번 받은 캠페인은 다시 조회하지 않는다 (느린 건 GFA 광고세트 목록)
      const targets = [...new Map(needGroups.map((c) => [c.id, c])).values()].filter((c) => !groupsByCampaign.has(c.id));
      let done = 0;
      if (targets.length) setBusy(`예산 단위(광고그룹)를 확인하는 중… 0/${targets.length}`);
      await Promise.all(targets.map(async (c) => {
        try {
          const res = await (apiFetch || fetch)(`/api/entities?channel=${c.channel}&campaignId=${encodeURIComponent(c.id)}`);
          const data = await res.json();
          if (res.ok) groupsByCampaign.set(c.id, data.adgroups || []);
        } catch { /* 이 캠페인은 캠페인 단위로 시도 */ }
        finally { done += 1; setBusy(`예산 단위(광고그룹)를 확인하는 중… ${done}/${targets.length}`); }
      }));
      computePlan(groupsByCampaign);
    } finally { setBusy(""); }
  }
  async function applyPlan() {
    if (!plan || !onApplyOps) return;
    const picked = plan.filter((r) => r.checked && r.next > 0);
    if (!picked.length) return;
    const danger = picked.filter((r) => r.warn);
    if (!window.confirm(`${picked.length}개 대상(캠페인·광고그룹)의 일예산을 바꿉니다.${danger.length ? `\n⚠️ 경고 표시된 ${danger.length}건이 포함돼 있어요 — 금액을 다시 확인했나요?` : ""}`)) return;
    setApplyBusy(true);
    try {
      await onApplyOps(picked.map((r) => ({ kind: "update_budget", channel: r.campaign.channel, entityType: r.entityType, id: r.targetId, dailyBudget: r.next })));
      setPlan(null);
    } finally { setApplyBusy(false); }
  }

  const MoveMenu = ({ c, from }: { c: Campaign; from: string }) => (
    <select className="mini-select" value="" aria-label="라인 이동" onChange={(e) => { const v = e.target.value; if (!v) return; if (v === "__exclude__") onExclude?.(c); else move(c, v); }}>
      <option value="">이동…</option>
      {from !== UNASSIGNED && <option value={UNASSIGNED}>미분류로 빼기</option>}
      {onExclude && <option value="__exclude__">예산에서 제외(숨김)…</option>}
      {groups.map((g) => <optgroup key={g} label={g}>{lines.filter((l) => lineGroup(l) === g && l.id !== from).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</optgroup>)}
    </select>
  );
  const chip = (c: Campaign, from: string, pinned?: boolean) => (
    <li key={c.id} className={`map-chip${isRunning(c) ? "" : " muted"}`} draggable onDragStart={(e) => { e.dataTransfer.setData("text/campaign-id", c.id); e.dataTransfer.effectAllowed = "move"; }} title={`${c.accountName || ""} · 끌어서 다른 라인으로 옮기세요`}>
      <span className={`channel ${c.channel}`}>{CHANNEL_LABEL[c.channel].replace("네이버 ", "")}</span>
      <span className="map-chip-name">{c.name}</span>
      <em>{c.spend ? compact(c.spend) : "–"}{pinned ? " · 📌" : ""}</em>
      <MoveMenu c={c} from={from} />
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
          <span className="viz-sub">{excludedCount ? `예산 제외 ${excludedCount}개 숨김 · ` : ""}{lines.length ? `라인 ${lines.length}개 · 캠페인 ${linked}개 연결 · 빈 라인 ${emptyLines}개 · 미분류 ${unassigned.length}개(${won.format(unassignedSpend)})` : "아직 믹스가 없어요"}</span>
        </div>
        <div className="mix-actions">
          {lines.length > 0 && <nav className="segmented small"><button className={layout === "table" ? "active" : ""} onClick={() => setLayout("table")}>믹스 표</button><button className={layout === "board" ? "active" : ""} onClick={() => setLayout("board")}>라인 띠</button></nav>}
          {lines.length > 0 && month === thisMonth && onApplyOps && <button className="secondary" disabled={!!busy || applyBusy} onClick={() => void buildPlan()}>일예산 맞추기</button>}
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

      {plan && <article className="viz-card map-import">
        <div className="viz-head">
          <span className="viz-title">일예산 맞추기 · {month}</span>
          <span className="viz-sub">믹스 금액 ÷ (1+마크업) = 매체 집행액으로 환산해 남은 예산 ÷ 남은 일수를 소진 비중대로 배분해요. 네이버 SA·GFA는 예산칸이 VAT 포함이라 ×1.1 해서 넣어요. 금액은 바꿀 수 있고, 체크된 것만 적용돼요.</span>
        </div>
        <div className="mix-actions" style={{ alignItems: "center", gap: 10 }}>
          <span className="viz-sub">매체별 마크업 %</span>
          {(["naver_sa", "naver_gfa", "meta", "google_ads"] as Channel[]).map((ch) => <label key={ch} className="viz-sub" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {CHANNEL_LABEL[ch].replace("네이버 ", "")}
            <input className="note-input num" style={{ width: "3.5em", textAlign: "right" }} inputMode="decimal" value={markup[ch] ?? 0}
              onChange={(e) => setMarkupRate(ch, Math.max(0, Math.min(100, Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)), true)} />%
          </label>)}
          <span className="viz-sub">(한 번 넣으면 저장돼요 · 바꾸면 표가 다시 계산돼요)</span>
        </div>
        <div className="table-wrap"><table className="campaign-table">
          <thead><tr><th /><th>라인</th><th>캠페인</th><th>현재 일예산</th><th>새 일예산</th><th>비고</th></tr></thead>
          <tbody>{plan.map((r, i) => <tr key={r.targetId} className={r.warn && r.checked ? "over" : ""}>
            <td><input type="checkbox" checked={r.checked} onChange={(e) => setPlan(plan.map((x, j) => j === i ? { ...x, checked: e.target.checked } : x))} /></td>
            <td>{r.lineName}</td>
            <td><span className={`channel ${r.campaign.channel}`}>{CHANNEL_LABEL[r.campaign.channel].replace("네이버 ", "")}</span> {r.targetName}{r.entityType === "adgroup" ? <small className="viz-sub"> · 그룹예산</small> : null}</td>
            <td className="num">{r.current ? won.format(r.current) : "–"}</td>
            <td className="num"><input className="note-input num" style={{ width: "7.5em", textAlign: "right" }} value={r.next.toLocaleString()} inputMode="numeric"
              onChange={(e) => { const v = Number(e.target.value.replace(/[^0-9]/g, "")) || 0; setPlan(plan.map((x, j) => j === i ? { ...x, next: v, warn: v >= BIG || (x.current > 0 && v >= x.current * 10) } : x)); }} /></td>
            <td className="viz-sub">{r.warn && r.checked ? "⚠️ " : ""}{r.note}</td>
          </tr>)}</tbody>
          <tfoot><tr><td colSpan={4}><b>적용 대상 {plan.filter((r) => r.checked).length}개 · 하루 합계</b></td>
            <td className="num"><b>{won.format(plan.filter((r) => r.checked).reduce((s, r) => s + r.next, 0))}</b></td>
            <td className="viz-sub">남은 {Math.max(1, dim - day + 1)}일 환산 {compact(plan.filter((r) => r.checked).reduce((s, r) => s + r.next, 0) * Math.max(1, dim - day + 1))}</td></tr></tfoot>
        </table></div>
        <div className="mix-actions">
          <button className="primary" disabled={applyBusy || !plan.some((r) => r.checked && r.next > 0)} onClick={() => void applyPlan()}>{applyBusy ? "적용 중…" : "선택한 일예산 적용"}</button>
          <button className="secondary" disabled={applyBusy} onClick={() => setPlan(null)}>닫기</button>
        </div>
      </article>}

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
        {layout === "table" ? <div className="map-groups">
          {groups.map((g) => {
            const groupResults = results.filter((r) => lineGroup(r.line) === g);
            // 이 믹스구분의 원본 열(라인마다 다를 수 있어 합집합, 처음 나온 순서)
            const cols: string[] = [];
            for (const r of groupResults) for (const [k] of r.line.source || []) if (!cols.includes(k)) cols.push(k);
            const showName = !cols.length;
            const budget = groupResults.reduce((s, r) => s + r.line.budget, 0), spend = groupResults.reduce((s, r) => s + r.spend, 0);
            const cell = (r: typeof groupResults[number], k: string) => r.line.source?.find(([key]) => key === k)?.[1] || "";
            return <div key={g} className="map-group">
              <div className="map-group-head"><b>{g}</b><span className="viz-sub">소진 {compact(spend)} / 예산 {compact(budget)}{budget ? ` · ${Math.round(spend / budget * 100)}%` : ""}</span></div>
              <div className="table-wrap"><table className="campaign-table map-table">
                <thead><tr>{showName && <th>라인</th>}{cols.map((k) => <th key={k}>{k}</th>)}<th className="map-col-campaigns">연결 캠페인 <small>(끌어다 놓기)</small></th><th>예산</th><th>소진</th></tr></thead>
                <tbody>{groupResults.map((r, i) => {
                  const prevR = groupResults[i - 1];
                  // 엑셀의 셀 병합처럼: 위 행과 같은 값(앞 열도 모두 같을 때)은 비워 보인다
                  let same = !!prevR;
                  const list = [...r.campaigns].sort((a, b) => b.spend - a.spend);
                  const ratio = r.line.budget ? r.spend / r.line.budget : 0;
                  return <tr key={r.line.id} className={`${dragOver === r.line.id ? "over" : ""}${list.length ? "" : " empty"}`} {...dropProps(r.line.id)}>
                    {showName && <td><b>{r.line.name}</b></td>}
                    {cols.map((k) => { const v = cell(r, k); same = same && cell(prevR, k) === v; return <td key={k} className={same ? "merged" : ""}>{same ? "" : v}</td>; })}
                    <td className="map-col-campaigns">{list.length ? <ul className="map-list">{list.map((c) => chip(c, r.line.id, r.line.campaignIds.includes(c.id)))}</ul> : <small className="map-empty">연결 없음 — 끌어다 놓으세요</small>}</td>
                    <td className="num"><button className="link-button budget-link" title="기간별로 예산이 다르면 눌러서 나누세요" onClick={() => editPeriods(r.line)}>{won.format(r.line.budget)}</button>
                      {r.line.periods?.length ? <small className="viz-sub period-note">{r.line.periods.map((p) => `${p.from}~${p.to}일 ${compact(p.budget)}`).join(" + ")}</small> : null}</td>
                    <td className="num">{(() => {
                      const expected = day ? expectedSpend(r.line, day, dim) : 0;
                      const tone = !r.line.budget || !day ? "" : r.spend > expected * 1.15 ? "over" : r.spend < expected * 0.85 ? "under" : "ok";
                      const advice = month === thisMonth ? periodAdvice(r.line, r.spend, day) : null;
                      return <><b>{compact(r.spend)}</b>{r.line.budget ? <><div className="pace-track"><div className={`pace-fill ${tone}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />{day ? <i style={{ left: `${Math.min(100, expected / r.line.budget * 100)}%` }} title={`오늘까지 계획 ${compact(expected)}`} /> : null}</div>
                        <small className="viz-sub">{Math.round(ratio * 100)}%{day ? ` · 계획 ${compact(expected)}` : ""}</small></> : null}
                        {advice && <small className="viz-sub period-note">지금 {advice.period.from}~{advice.period.to}일 구간 · 남은 {advice.daysLeft}일 하루 {compact(advice.daily)}</small>}</>;
                    })()}</td>
                  </tr>;
                })}</tbody>
                <tfoot><tr><td colSpan={(showName ? 1 : 0) + cols.length + 1}><b>{g} 합계</b></td><td className="num"><b>{won.format(budget)}</b></td><td className="num"><b>{compact(spend)}</b></td></tr></tfoot>
              </table></div>
            </div>;
          })}
        </div> : <div className="map-groups">
          {groups.map((g) => {
            const groupLines = results.filter((r) => lineGroup(r.line) === g);
            const budget = groupLines.reduce((s, r) => s + r.line.budget, 0), spend = groupLines.reduce((s, r) => s + r.spend, 0);
            return <div key={g} className="map-group">
              <div className="map-group-head"><b>{g}</b><span className="viz-sub">{compact(spend)} / {compact(budget)}</span></div>
              <div className="map-lines">{groupLines.map(({ line }) => {
                const r = byLine.get(line.id)!;
                const list = [...r.campaigns].sort((a, b) => b.spend - a.spend);
                // 캠페인 1개이고 이름이 라인과 같으면 띠 하나로 합친다(띠 자체를 끌어서 옮김)
                const single = list.length === 1 && list[0].name.replace(/\s+/g, "").toLowerCase().includes(line.name.replace(/\s+/g, "").toLowerCase()) ? list[0] : null;
                return <div key={line.id} className={`map-line${dragOver === line.id ? " over" : ""}${list.length ? "" : " empty"}`} {...dropProps(line.id)}>
                  <div className={`map-band${single ? " draggable" : ""}`} draggable={!!single} onDragStart={single ? (e) => { e.dataTransfer.setData("text/campaign-id", single.id); e.dataTransfer.effectAllowed = "move"; } : undefined} title={single ? "끌어서 다른 라인으로 옮기세요" : line.note || ""}>
                    <span className={`channel ${line.channel}`}>{line.channel === "all" ? "전체" : CHANNEL_LABEL[line.channel as Channel].replace("네이버 ", "")}</span>
                    <b>{line.name}</b>
                    {single && line.campaignIds.includes(single.id) ? <span title="직접 지정">📌</span> : null}
                    <span className="map-amount">{compact(r.spend)} / {compact(line.budget)}</span>
                    {single && <MoveMenu c={single} from={line.id} />}
                  </div>
                  {!single && list.length > 0 && <ul className="map-list sub">{list.map((c) => chip(c, line.id, line.campaignIds.includes(c.id)))}</ul>}
                  {!list.length && <small className="map-empty">연결 없음 — 미분류에서 끌어다 놓으세요{line.keywords.length ? ` (키워드: ${line.keywords.join(", ")})` : ""}</small>}
                </div>;
              })}</div>
            </div>;
          })}
        </div>}
      </div>}
      {lines.length > 0 && <small className="viz-sub">📌 = 직접 옮긴 캠페인(키워드보다 우선). 미분류로 뺀 캠페인은 그 라인 키워드에서 제외돼요. 다음 달은 '지난달 매핑 복사'로 그대로 이어 쓸 수 있어요.</small>}
    </section>
  );
}

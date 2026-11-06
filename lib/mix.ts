import type { Campaign, Channel } from "@/lib/types";

// 월별 미디어 믹스: 광고주 × 월 단위 계획. 채널별 예산·목표 ROAS와 메모.
export type MixChannelPlan = { budget: number; targetRoas: number; note?: string };
/**
 * 믹스 라인: 한 광고주 안의 운영 단위(예: "B2C 전환", "아이책상 기획전").
 * 캠페인 연결은 이름 키워드 규칙 + 직접 지정(campaignIds)으로 코드가 계산한다 (LLM 불필요).
 */
export type MixPeriod = { from: number; to: number; budget: number };
export type MixLine = {
  id: string;
  name: string;
  /** 믹스구분(예: 27Y 학생방·온크쇼). 같은 달 믹스 안에서 리포트를 묶는 단위 */
  group?: string;
  /** 원본 믹스 행의 칸(열 이름, 값) — 믹스 표를 원래 모양대로 보여줄 때 쓴다 */
  source?: Array<[string, string]>;
  /** 같은 캠페인인데 기간별로 예산이 다를 때(예: 1~4일 100만, 5~30일 500만). 날짜는 그 달의 일(day). budget 은 구간 합계 */
  periods?: MixPeriod[];
  channel: Channel | "all";
  budget: number;
  targetRoas: number;
  note?: string;
  keywords: string[];
  excludes: string[];
  campaignIds: string[];
};

export type MediaMix = {
  id: string;
  advertiserId: string;
  month: string; // YYYY-MM
  status: "draft" | "active" | "closed";
  targetRoas: number; // 전체 목표 ROAS(%)
  channels: Partial<Record<Channel, MixChannelPlan>>;
  notes: string;
  review?: string; // 월 마감 후 회고 (다음 달 믹스 근거)
  lines?: MixLine[];
  createdAt: string;
  updatedAt: string;
};

export type Advertiser = { id: string; name: string; accountKeys: string[] };

export const mixTotalBudget = (mix: Pick<MediaMix, "channels">) => Object.values(mix.channels).reduce((sum, plan) => sum + (plan?.budget || 0), 0);

const CHANNELS: Channel[] = ["naver_sa", "naver_gfa", "meta", "google_ads"];
const words = (value: unknown) => (Array.isArray(value) ? value : String(value || "").split(/[,\n]/)).map((v) => String(v).trim()).filter(Boolean).slice(0, 20);

/** 예전 라인은 이름이 '믹스구분 · 캠페인' 형태 → 앞부분을 믹스구분으로 본다 */
export function groupFromName(name: string) { const i = name.indexOf(" · "); return i > 0 ? name.slice(0, i).trim().slice(0, 40) : ""; }
export const lineGroup = (line: Pick<MixLine, "group" | "name">) => line.group || groupFromName(line.name) || "믹스";
/** 라인에 나온 순서대로 믹스구분 목록 */
export const lineGroups = (lines: MixLine[] | undefined) => [...new Set((lines || []).map(lineGroup))];

function sanitizePeriods(value: unknown): MixPeriod[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((p: any) => ({ from: Math.max(1, Math.min(31, Math.round(Number(p?.from) || 1))), to: Math.max(1, Math.min(31, Math.round(Number(p?.to) || 31))), budget: Math.max(0, Math.round(Number(p?.budget) || 0)) }))
    .map((p) => p.from > p.to ? { ...p, from: p.to, to: p.from } : p).sort((a, b) => a.from - b.from).slice(0, 12);
  return out.length ? out : undefined;
}

/** '11.1~11.4', '11/5-11/30', '2026.11.16 ~ 2026.11.23', '1~4일' → { from, to } (그 달의 일) */
export function parsePeriod(text: string): { from: number; to: number } | null {
  const t = String(text || "").replace(/\s+/g, "");
  const md = t.match(/(?:\d{4}[./-])?(\d{1,2})[./-](\d{1,2})\.?[~∼\-–—](?:\d{4}[./-])?(?:(\d{1,2})[./-])?(\d{1,2})/);
  if (md) { const from = Number(md[2]), to = Number(md[4]); if (from >= 1 && to >= 1 && from <= 31 && to <= 31) return { from, to: md[3] && Number(md[3]) !== Number(md[1]) ? 31 : to }; }
  const d = t.match(/^(\d{1,2})일?[~∼\-–—](\d{1,2})일?$/);
  if (d) return { from: Number(d[1]), to: Number(d[2]) };
  return null;
}
const PERIOD_COL = /기간|일정|period|날짜|집행일/i;
/** 같은 믹스구분·매체·이름(키워드)인데 기간만 다른 행들을 한 라인의 기간 구간으로 합친다 */
export function mergePeriodLines(lines: MixLine[]): MixLine[] {
  const out: Array<MixLine & { __period?: { from: number; to: number } }> = [];
  const keyOf = (l: MixLine) => [lineGroup(l), l.channel, norm(l.name), l.keywords.map(norm).sort().join(",")].join("|");
  for (const line of lines) {
    const periodText = line.source?.find(([k]) => PERIOD_COL.test(k))?.[1] || "";
    const period = parsePeriod(periodText);
    const prev = period ? out.find((o) => keyOf(o) === keyOf(line) && (o.periods?.length || o.__period)) : undefined;
    if (prev && period) {
      const base: MixPeriod[] = prev.periods?.length ? prev.periods : [{ ...(prev.__period as { from: number; to: number }), budget: prev.budget }];
      prev.periods = [...base, { ...period, budget: line.budget }].sort((a, b) => a.from - b.from);
      prev.budget = prev.periods.reduce((s, p) => s + p.budget, 0);
      prev.source = prev.source?.map(([k, v]) => PERIOD_COL.test(k) ? [k, `${v} / ${periodText}`] as [string, string] : [k, v]);
      continue;
    }
    out.push(period ? Object.assign({ ...line }, { __period: period }) : line);
  }
  // 한 행만 있어도 기간이 한 달 전체가 아니면(예: 기획전 16~23일) 그 구간으로 페이스를 잡는다
  return out.map(({ __period, ...l }: any) => (!l.periods && __period && !(__period.from === 1 && __period.to >= 28) ? { ...l, periods: [{ ...__period, budget: l.budget }] } : l) as MixLine);
}

/** 오늘(그 달의 day)까지 이 라인이 썼어야 할 금액 — 기간 구간이 있으면 구간별로, 없으면 한 달 균등 */
export function expectedSpend(line: Pick<MixLine, "budget" | "periods">, day: number, daysInMonth: number) {
  if (!line.periods?.length) return line.budget * Math.min(1, day / daysInMonth);
  return line.periods.reduce((s, p) => s + p.budget * Math.max(0, Math.min(1, (day - p.from + 1) / (p.to - p.from + 1))), 0);
}
/** 지금 구간과 그 구간에 맞춘 일예산(마크업 등은 고려 안 함: 라인 금액 기준) */
export function periodAdvice(line: Pick<MixLine, "budget" | "periods">, spend: number, day: number) {
  const cur = line.periods?.find((p) => day >= p.from && day <= p.to);
  if (!cur || !line.periods) return null;
  const upToCur = line.periods.filter((p) => p.from <= cur.from).reduce((s, p) => s + p.budget, 0);
  const daysLeft = cur.to - day + 1;
  return { period: cur, daily: Math.max(0, (upToCur - spend) / daysLeft), daysLeft };
}
export const periodLabel = (p: MixPeriod, month?: string) => `${month ? `${Number(month.slice(5))}/` : ""}${p.from}~${month ? `${Number(month.slice(5))}/` : ""}${p.to}`;

function sanitizeSource(value: unknown): Array<[string, string]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((v: any) => Array.isArray(v) ? [String(v[0] ?? ""), String(v[1] ?? "")] : [String(v?.column ?? ""), String(v?.value ?? "")])
    .filter(([k]) => k.trim()).slice(0, 14).map(([k, v]) => [k.trim().slice(0, 40), v.trim().slice(0, 120)] as [string, string]);
  return out.length ? out : undefined;
}

export function sanitizeLines(input: unknown): MixLine[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 60).map((line: any) => ({
    id: String(line?.id || crypto.randomUUID()),
    name: String(line?.name || "이름 없는 라인").slice(0, 80),
    group: String(line?.group || "").trim().slice(0, 40) || groupFromName(String(line?.name || "")) || undefined,
    channel: (CHANNELS as string[]).includes(line?.channel) ? line.channel : "all",
    budget: Math.max(0, Math.round(Number(line?.budget) || 0)),
    targetRoas: Math.max(0, Math.round(Number(line?.targetRoas) || 0)),
    note: line?.note ? String(line.note).slice(0, 300) : undefined,
    source: sanitizeSource(line?.source),
    periods: sanitizePeriods(line?.periods),
    keywords: words(line?.keywords),
    excludes: words(line?.excludes),
    campaignIds: (Array.isArray(line?.campaignIds) ? line.campaignIds : []).map(String).slice(0, 200),
  }));
}

/** 라인이 있으면 채널별 예산·목표 ROAS를 라인에서 다시 계산한다. */
export function channelsFromLines(lines: MixLine[]): MediaMix["channels"] {
  const out: MediaMix["channels"] = {};
  for (const channel of CHANNELS) {
    const list = lines.filter((line) => line.channel === channel);
    const budget = list.reduce((s, l) => s + l.budget, 0);
    if (!budget) continue;
    out[channel] = { budget, targetRoas: Math.round(list.reduce((s, l) => s + l.budget * l.targetRoas, 0) / budget), note: list.map((l) => l.name).join(", ").slice(0, 300) };
  }
  return out;
}

export function sanitizeMix(input: any): MediaMix | null {
  if (!input || typeof input !== "object") return null;
  const month = String(input.month || "");
  if (!/^\d{4}-\d{2}$/.test(month) || !input.advertiserId) return null;
  const channels: MediaMix["channels"] = {};
  for (const key of ["naver_sa", "naver_gfa", "meta", "google_ads"] as Channel[]) {
    const plan = input.channels?.[key];
    if (!plan) continue;
    const budget = Math.max(0, Math.round(Number(plan.budget) || 0));
    const targetRoas = Math.max(0, Math.round(Number(plan.targetRoas) || 0));
    if (budget || targetRoas || plan.note) channels[key] = { budget, targetRoas, note: plan.note ? String(plan.note).slice(0, 500) : undefined };
  }
  const lines = sanitizeLines(input.lines);
  if (lines.some((line) => line.channel !== "all")) Object.assign(channels, channelsFromLines(lines));
  const now = new Date().toISOString();
  return {
    id: String(input.id || crypto.randomUUID()),
    advertiserId: String(input.advertiserId),
    month,
    status: ["draft", "active", "closed"].includes(input.status) ? input.status : "draft",
    targetRoas: Math.max(0, Math.round(Number(input.targetRoas) || 0)),
    channels,
    notes: String(input.notes || "").slice(0, 4000),
    review: input.review ? String(input.review).slice(0, 4000) : undefined,
    // 빈 배열은 '라인을 지웠다'는 뜻으로 그대로 보내고, 필드가 아예 없으면 undefined(기존 라인 유지)로 둔다
    lines: lines.length ? lines : Array.isArray(input.lines) ? [] : undefined,
    createdAt: String(input.createdAt || now),
    updatedAt: now,
  };
}

// ---- 캠페인 ↔ 믹스 라인 매칭 ----
const norm = (value: string) => value.toLowerCase().replace(/\s+/g, "");

export function lineMatches(line: MixLine, campaign: Pick<Campaign, "id" | "name" | "channel">) {
  if (line.channel !== "all" && line.channel !== campaign.channel) return false;
  const name = norm(campaign.name);
  if (line.excludes.some((word) => name.includes(norm(word)))) return false;
  return line.keywords.length > 0 && line.keywords.some((word) => name.includes(norm(word)));
}

export type LineResult = { line: MixLine; campaigns: Campaign[]; spend: number; revenue: number; conversions: number; roas: number };

/**
 * 직접 지정(campaignIds)이 우선이고, 그다음 라인 순서대로 키워드 규칙을 적용한다.
 * 한 캠페인은 한 라인에만 들어가므로 중복 집계가 없다.
 */
export function matchMix(lines: MixLine[], campaigns: Campaign[]) {
  const assigned = new Map<string, string>();
  for (const line of lines) for (const id of line.campaignIds) if (!assigned.has(id)) assigned.set(id, line.id);
  for (const campaign of campaigns) {
    if (assigned.has(campaign.id)) continue;
    const hit = lines.find((line) => lineMatches(line, campaign));
    if (hit) assigned.set(campaign.id, hit.id);
  }
  const results: LineResult[] = lines.map((line) => {
    const list = campaigns.filter((c) => assigned.get(c.id) === line.id);
    const spend = list.reduce((s, c) => s + c.spend, 0);
    const revenue = list.reduce((s, c) => s + c.spend * c.roas / 100, 0);
    const conversions = list.reduce((s, c) => s + c.conversions, 0);
    return { line, campaigns: list, spend, revenue, conversions, roas: spend ? revenue / spend * 100 : 0 };
  });
  const unassigned = campaigns.filter((c) => !assigned.has(c.id));
  return { results, unassigned };
}

// ---- 붙여넣기 파서 (표 형식이면 LLM 없이 처리) ----
const CHANNEL_ALIASES: Array<[RegExp, Channel]> = [
  [/gfa|성과형|디스플레이|naver\s*da|네이버\s*da/i, "naver_gfa"],
  [/sa\b|검색|파워링크|브랜드검색|쇼핑검색|naver\s*sa|네이버\s*sa|네이버/i, "naver_sa"],
  [/meta|메타|페이스북|facebook|인스타|instagram/i, "meta"],
  [/google|구글|유튜브|youtube|pmax|gdn/i, "google_ads"],
];
export function parseChannel(value: string): Channel | "all" {
  for (const [re, channel] of CHANNEL_ALIASES) if (re.test(value)) return channel;
  return "all";
}
export function parseMoney(value: string): number {
  const v = value.replace(/[,\s₩원]/g, "");
  const m = v.match(/^([\d.]+)(억|천만|백만|만)?$/);
  if (!m) return Number(v.replace(/[^\d.]/g, "")) || 0;
  const unit = { 억: 100_000_000, 천만: 10_000_000, 백만: 1_000_000, 만: 10_000 }[m[2] as "억"] || 1;
  return Math.round(Number(m[1]) * unit);
}

/** 탭/쉼표로 구분된 표를 라인으로 바꾼다. 머리글을 못 찾으면 null (그때만 AI 사용). */
export function parseMixTable(text: string): MixLine[] | null {
  const rows = splitTable(text).map((cells) => cells.map((c) => c.trim())).filter((cells) => cells.some(Boolean));
  if (rows.length < 2) return null;
  const rawHeader = rows[0];
  const header = rawHeader.map((h) => h.toLowerCase());
  const find = (re: RegExp) => header.findIndex((h) => re.test(h));
  const findNot = (re: RegExp, not: RegExp) => header.findIndex((h) => re.test(h) && !not.test(h));
  const group = find(/믹스\s*구분|믹스명|그룹|group/);
  const keywords = findNot(/키워드|keyword|매칭/, /제외|exclude/);
  const nameCol = header.findIndex((h, i) => i !== group && /구분|라인|캠페인|항목|name|line/.test(h));
  const budgetCol = [find(/월\s*예산|월예산|budget/), findNot(/예산|금액/, /단위|집행|÷/)].find((i) => i >= 0) ?? -1;
  const col = { group, name: nameCol, channel: find(/매체|채널|channel|media/), budget: budgetCol, roas: find(/roas/), keywords, excludes: find(/제외|exclude/), note: find(/메모|비고|전략|note/) };
  if (col.budget < 0 || (col.name < 0 && col.channel < 0)) return null;
  // 셀 병합된 엑셀은 아래 칸이 비어 있다 → 예산 열 왼쪽 칸은 위 행 값을 이어받는다
  let prevCells: string[] = [];
  const shown = new Set([col.budget, col.keywords, col.excludes, col.group].filter((i) => i >= 0));
  const lines = rows.slice(1).map((raw) => {
    // 합계·소계 행은 건너뛴다(병합 이어받기 전에 판단)
    if (raw.some((c) => /^(합계|소계|총계|총합|total|subtotal|sum)$|subtotal|^total\b/i.test(c))) return null;
    const cells = raw.map((c, i) => c || (i < col.budget && i !== col.note && i !== col.keywords && i !== col.excludes ? prevCells[i] || "" : ""));
    prevCells = cells;
    const source = rawHeader.map((h, i) => [h || `열${i + 1}`, cells[i] || ""] as [string, string]).filter((_, i) => !shown.has(i) && rawHeader[i] !== undefined).slice(0, 14);
    const name = (col.name >= 0 ? cells[col.name] : "") || (col.channel >= 0 ? cells[col.channel] : "");
    const channelCell = col.channel >= 0 ? cells[col.channel] || "" : "";
    const fromCell = parseChannel(channelCell);
    const channel = fromCell !== "all" ? fromCell : parseChannel(`${channelCell} ${name}`);
    // 대시보드에 없는 매체(버티컬·카카오·NOSP 등)는 라인에서 뺀다
    if (channelCell && channel === "all" && !/전체|all/i.test(channelCell)) return null;
    return {
      id: crypto.randomUUID(), name, group: col.group >= 0 ? cells[col.group] || undefined : undefined, channel, budget: parseMoney(cells[col.budget] || ""),
      targetRoas: col.roas >= 0 ? Math.round(Number(String(cells[col.roas] || "").replace(/[^\d.]/g, "")) || 0) : 0,
      note: col.note >= 0 ? cells[col.note] : undefined, source,
      keywords: col.keywords >= 0 ? words(cells[col.keywords]) : [], excludes: col.excludes >= 0 ? words(cells[col.excludes]) : [], campaignIds: [],
    } as MixLine;
  }).filter((line): line is MixLine => !!line && !!line.name && line.budget > 0 && !/^(합계|총계|total|sum)$/i.test(line.name));
  return lines.length ? mergePeriodLines(lines) : null;
}

/** 탭 구분이면 탭으로, 아니면 따옴표를 지키는 CSV 로 나눈다 */
function splitTable(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  if (clean.split(/\r?\n/, 2)[0].includes("\t")) return clean.split(/\r?\n/).map((row) => row.split("\t"));
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) { if (ch === '"' && clean[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; continue; }
    if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && clean[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---- 첨부 표 → 믹스 초안 (AI 없이) ----
/** 엑셀 변환본(## 시트: 이름 단위)이나 CSV 에서 믹스 표를 찾는다 */
export function parseMixAttachment(text: string): MixLine[] | null {
  // 시트가 여러 개면 시트마다 읽고, 믹스구분 열이 없으면 시트 이름을 믹스구분으로 쓴다
  const sections = text.includes("## 시트:")
    ? text.split(/^## 시트:/m).map((s) => s.trim()).filter(Boolean).map((s) => { const nl = s.indexOf("\n"); return { name: s.slice(0, nl).trim(), body: s.slice(nl + 1) }; })
    : [{ name: "", body: text }];
  const found = sections.map((sec) => ({ sec, lines: parseMixTable(sec.body) })).filter((x) => x.lines?.length);
  if (!found.length) return null;
  const all = found.flatMap(({ sec, lines }) => lines!.map((l) => ({ ...l, group: l.group || (found.length > 1 ? sec.name : undefined) })));
  return all.slice(0, 60);
}

/** 메시지·파일 이름에서 대상 월(YYYY-MM)을 찾는다. 없으면 이번 달 */
export function detectMonth(texts: string[], today: string): string {
  const [ty, tm] = today.split("-").map(Number);
  // 메시지 → 파일 이름 순서로, 각각 'YYYY-MM' 다음 'N월'을 찾는다
  for (const t of texts) {
    const full = t.match(/(20\d\d)\s*[-._년]\s*(\d{1,2})(?!\d)/);
    if (full && Number(full[2]) >= 1 && Number(full[2]) <= 12) return `${full[1]}-${String(full[2]).padStart(2, "0")}`;
    const m = t.match(/(\d{1,2})\s*월/);
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) {
      const mm = Number(m[1]);
      const year = mm < tm - 6 ? ty + 1 : mm > tm + 6 ? ty - 1 : ty;
      return `${year}-${String(mm).padStart(2, "0")}`;
    }
  }
  return today.slice(0, 7);
}

const lineKey = (l: MixLine) => `${l.channel}|${norm(lineGroup(l))}|${norm(l.name)}`;
/** 기존 라인 대비 바뀐 점 */
export function diffLines(before: MixLine[] | undefined, after: MixLine[]) {
  const prev = new Map((before || []).map((l) => [lineKey(l), l]));
  const next = new Map(after.map((l) => [lineKey(l), l]));
  const changed = after.filter((l) => prev.has(lineKey(l)) && prev.get(lineKey(l))!.budget !== l.budget).map((l) => ({ line: l, before: prev.get(lineKey(l))!.budget }));
  const added = after.filter((l) => !prev.has(lineKey(l)));
  const removed = (before || []).filter((l) => !next.has(lineKey(l)));
  return { changed, added, removed };
}

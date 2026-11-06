import type { Campaign, Channel } from "@/lib/types";

// 월별 미디어 믹스: 광고주 × 월 단위 계획. 채널별 예산·목표 ROAS와 메모.
export type MixChannelPlan = { budget: number; targetRoas: number; note?: string };
/**
 * 믹스 라인: 한 광고주 안의 운영 단위(예: "B2C 전환", "아이책상 기획전").
 * 캠페인 연결은 이름 키워드 규칙 + 직접 지정(campaignIds)으로 코드가 계산한다 (LLM 불필요).
 */
export type MixLine = {
  id: string;
  name: string;
  /** 믹스구분(예: 27Y 학생방·온크쇼). 같은 달 믹스 안에서 리포트를 묶는 단위 */
  group?: string;
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
export const lineGroup = (line: Pick<MixLine, "group" | "name">) => line.group || groupFromName(line.name) || "미분류";
/** 라인에 나온 순서대로 믹스구분 목록 */
export const lineGroups = (lines: MixLine[] | undefined) => [...new Set((lines || []).map(lineGroup))];

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
    lines: lines.length ? lines : undefined,
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
  const header = rows[0].map((h) => h.toLowerCase());
  const find = (re: RegExp) => header.findIndex((h) => re.test(h));
  const findNot = (re: RegExp, not: RegExp) => header.findIndex((h) => re.test(h) && !not.test(h));
  const group = find(/믹스\s*구분|믹스명|그룹|group/);
  const keywords = findNot(/키워드|keyword|매칭/, /제외|exclude/);
  const nameCol = header.findIndex((h, i) => i !== group && /구분|라인|캠페인|항목|name|line/.test(h));
  const budgetCol = [find(/월\s*예산|월예산|budget/), findNot(/예산|금액/, /단위|집행|÷/)].find((i) => i >= 0) ?? -1;
  const col = { group, name: nameCol, channel: find(/매체|채널|channel|media/), budget: budgetCol, roas: find(/roas/), keywords, excludes: find(/제외|exclude/), note: find(/메모|비고|전략|note/) };
  if (col.budget < 0 || (col.name < 0 && col.channel < 0)) return null;
  const lines = rows.slice(1).map((cells) => {
    const name = (col.name >= 0 ? cells[col.name] : "") || (col.channel >= 0 ? cells[col.channel] : "");
    const channelCell = col.channel >= 0 ? cells[col.channel] || "" : "";
    const fromCell = parseChannel(channelCell);
    const channel = fromCell !== "all" ? fromCell : parseChannel(`${channelCell} ${name}`);
    // 대시보드에 없는 매체(버티컬·카카오·NOSP 등)는 라인에서 뺀다
    if (channelCell && channel === "all" && !/전체|all/i.test(channelCell)) return null;
    return {
      id: crypto.randomUUID(), name, group: col.group >= 0 ? cells[col.group] || undefined : undefined, channel, budget: parseMoney(cells[col.budget] || ""),
      targetRoas: col.roas >= 0 ? Math.round(Number(String(cells[col.roas] || "").replace(/[^\d.]/g, "")) || 0) : 0,
      note: col.note >= 0 ? cells[col.note] : undefined,
      keywords: col.keywords >= 0 ? words(cells[col.keywords]) : [], excludes: col.excludes >= 0 ? words(cells[col.excludes]) : [], campaignIds: [],
    } as MixLine;
  }).filter((line): line is MixLine => !!line && !!line.name && line.budget > 0 && !/^(합계|총계|total|sum)$/i.test(line.name));
  return lines.length ? lines : null;
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
  const sections = text.includes("## 시트:") ? text.split(/^## 시트:.*$/m).map((s) => s.trim()).filter(Boolean) : [text];
  let best: MixLine[] | null = null;
  for (const section of sections) {
    const lines = parseMixTable(section);
    if (lines && (!best || lines.length > best.length)) best = lines;
  }
  return best;
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

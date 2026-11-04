"use client";

import type { AdAccount, Campaign, Channel } from "@/lib/types";
import type { MixLine } from "@/lib/mix";
import { matchMix } from "@/lib/mix";
import { CHANNEL_LABEL, CHANNEL_ORDER } from "./report-view";

export type Filter = { channel: Channel | ""; account: string; product: string; line: string };
export const EMPTY_FILTER: Filter = { channel: "", account: "", product: "", line: "" };

type Props = {
  value: Filter;
  onChange: (next: Filter) => void;
  accountKeys: string[];
  accounts: AdAccount[];
  campaigns: Campaign[];
  lines?: MixLine[];
  channels?: Channel[]; // 이 화면에서 쓸 수 있는 채널 (예: 소재 성과는 Meta·GFA만)
};

const keyOf = (channel: string, id: string) => `${channel}:${id}`;

/** 운영 믹스 라인 → 캠페인 ID 집합 */
export function lineCampaignIds(lines: MixLine[] | undefined, campaigns: Campaign[]) {
  const map = new Map<string, Set<string>>();
  if (!lines?.length) return map;
  const { results } = matchMix(lines, campaigns);
  for (const r of results) map.set(r.line.id, new Set(r.campaigns.map((c) => c.id)));
  return map;
}

/** 필터를 통과하는지. campaign이 없으면(소재의 캠페인을 모를 때) 광고상품·믹스 조건은 통과시키지 않는다. */
export function passes(filter: Filter, row: { channel: Channel; accountId?: string; campaignId?: string }, campaignsById: Map<string, Campaign>, lineSets: Map<string, Set<string>>) {
  if (filter.channel && row.channel !== filter.channel) return false;
  if (filter.account && keyOf(row.channel, row.accountId || "") !== filter.account) return false;
  if (filter.product) {
    const campaign = row.campaignId ? campaignsById.get(row.campaignId) : undefined;
    if (!campaign || campaign.product !== filter.product) return false;
  }
  if (filter.line) {
    const set = lineSets.get(filter.line);
    if (!set || !row.campaignId || !set.has(row.campaignId)) return false;
  }
  return true;
}

export function FilterBar({ value, onChange, accountKeys, accounts, campaigns, lines, channels }: Props) {
  const allowed = (channels || CHANNEL_ORDER).filter((c) => accountKeys.some((k) => k.startsWith(`${c}:`)));
  // 하위 목록은 상위 선택을 벗어나지 않는다. 상위가 비어 있으면 전부 보여준다.
  const accountOptions = accountKeys.filter((k) => allowed.some((c) => k.startsWith(`${c}:`)) && (!value.channel || k.startsWith(`${value.channel}:`)));
  const scoped = campaigns.filter((c) => allowed.includes(c.channel) && (!value.channel || c.channel === value.channel) && (!value.account || keyOf(c.channel, c.accountId || "") === value.account));
  const productOptions = [...new Set(scoped.map((c) => c.product).filter(Boolean) as string[])].sort();
  const lineOptions = (lines || []).filter((l) => l.channel === "all" || !value.channel || l.channel === value.channel);
  const accountName = (key: string) => {
    const [channel, ...rest] = key.split(":");
    const id = rest.join(":");
    return accounts.find((a) => a.channel === channel && a.id === id)?.name || id;
  };

  const set = (patch: Partial<Filter>) => {
    const next = { ...value, ...patch };
    // 상위를 바꾸면 맞지 않게 된 하위 선택은 해제
    if (patch.channel !== undefined) {
      if (next.account && next.channel && !next.account.startsWith(`${next.channel}:`)) next.account = "";
      next.product = ""; next.line = "";
    }
    if (patch.account !== undefined) {
      if (patch.account) next.channel = patch.account.split(":")[0] as Channel;
      next.product = "";
    }
    onChange(next);
  };

  return (
    <div className="filter-bar">
      <label><span>채널</span><select value={value.channel} onChange={(e) => set({ channel: e.target.value as Channel | "" })}>
        <option value="">전체</option>{allowed.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
      </select></label>
      <label><span>계정</span><select value={value.account} onChange={(e) => set({ account: e.target.value })}>
        <option value="">전체 ({accountOptions.length})</option>{accountOptions.map((k) => <option key={k} value={k}>{value.channel ? "" : `${CHANNEL_LABEL[k.split(":")[0] as Channel]} · `}{accountName(k)}</option>)}
      </select></label>
      <label><span>광고상품</span><select value={value.product} onChange={(e) => set({ product: e.target.value })}>
        <option value="">전체 ({productOptions.length})</option>{productOptions.map((p) => <option key={p} value={p}>{p}</option>)}
      </select></label>
      <label><span>운영믹스</span><select value={value.line} disabled={!lineOptions.length} onChange={(e) => set({ line: e.target.value })}>
        <option value="">전체</option>{lineOptions.map((l) => <option key={l.id} value={l.id}>{l.name || "(이름 없음)"}</option>)}
      </select>{!lineOptions.length && <small className="filter-note">믹스 통합 상태</small>}</label>
      {(value.channel || value.account || value.product || value.line) && <button className="link-button" onClick={() => onChange({ channel: "", account: "", product: "", line: "" })}>초기화</button>}
    </div>
  );
}

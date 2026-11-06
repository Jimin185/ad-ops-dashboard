export type Channel = "naver_sa" | "naver_gfa" | "meta" | "google_ads";
export type EntityType = "campaign" | "adgroup" | "ad";
export type EntityStatus = "on" | "off";

export type ConnectionStatus = {
  channel: Channel;
  status: "connected" | "error" | "not_configured" | "unsupported";
  campaignCount: number;
  message: string;
};

export type AdAccount = {
  id: string;
  channel: Channel;
  name: string;
};

export type Campaign = {
  id: string;
  channel: Channel;
  name: string;
  dailyBudget: number;
  /** 총예산(기간 예산) 캠페인·광고그룹: 총액과 남은 금액 */
  lifetimeBudget?: number;
  budgetRemaining?: number;
  status: EntityStatus;
  spend: number;
  conversions: number;
  roas: number;
  accountId?: string;
  accountName?: string;
  /** 실제로 돌아가는 중인지 (OFF·종료·완료·일시정지는 false) */
  active?: boolean;
  /** 매체 원본 상태값 (예: ACTIVE, PAUSED, ENDED, RUNNABLE) */
  rawStatus?: string;
  /** 광고상품 (예: 파워링크, 쇼핑검색, PMax, 판매 목표) */
  product?: string;
};

export type AdGroup = {
  id: string;
  campaignId: string;
  channel: Channel;
  name: string;
  dailyBudget: number;
  /** 총예산(기간 예산) 캠페인·광고그룹: 총액과 남은 금액 */
  lifetimeBudget?: number;
  budgetRemaining?: number;
  status: EntityStatus;
  active?: boolean;
};

export type Ad = {
  id: string;
  adgroupId: string;
  channel: Channel;
  name: string;
  status: EntityStatus;
  imageUrl?: string;
  landingUrl?: string;
  active?: boolean;
};

export type StatsRow = {
  id: string;
  name: string;
  channel: Channel;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  ctr: number;
  cpc: number;
  roas: number;
};

export type MediaPlanStep = { channel: Channel; accountId: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown; note?: string };

export type ChangeOperation =
  | { kind: "media_plan"; channel: Channel; summary: string; steps: MediaPlanStep[]; accountKeys: string[] }
  | { kind: "update_budget"; channel: Channel; entityType: EntityType; id: string; dailyBudget: number }
  | { kind: "set_status"; channel: Channel; entityType: EntityType; id: string; status: EntityStatus }
  | { kind: "update_landing"; channel: Channel; entityType: "ad"; id: string; url: string }
  | { kind: "replace_text_ad"; channel: "naver_sa"; adgroupId: string; deleteAdId?: string; headline: string; description: string; pcUrl: string; mobileUrl?: string }
  | {
      kind: "create_text_ad";
      channel: "naver_sa";
      adgroupIds: string[];
      headline: string;
      description: string;
      landingUrl: string;
    };

export type PendingItem = {
  targetId: string;
  targetName: string;
  field: string;
  before: string | number | null;
  after: string | number;
};

export type PendingAction = {
  id: string;
  title: string;
  operation: ChangeOperation;
  items: PendingItem[];
  expiresAt: number;
  token: string;
};

export type DailyRow = {
  date: string;
  channel: Channel;
  accountId: string;
  spend: number;
  revenue: number;
  conversions: number;
  impressions: number;
  clicks: number;
};

export type ReportResult = {
  since: string;
  until: string;
  rows: DailyRow[];
  errors: Array<{ channel: Channel; accountId: string; message: string }>;
};

export type CreativeRow = {
  id: string;
  channel: Channel;
  accountId: string;
  campaignId?: string;
  name: string;
  campaignName?: string;
  groupName?: string;
  imageUrl?: string;
  landingUrl?: string;
  headline?: string;
  body?: string;
  status?: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
};

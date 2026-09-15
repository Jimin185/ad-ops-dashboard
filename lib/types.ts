export type Channel = "naver_sa" | "naver_gfa" | "meta" | "google_ads";
export type EntityType = "campaign" | "adgroup" | "ad";
export type EntityStatus = "on" | "off";

export type Campaign = {
  id: string;
  channel: Channel;
  name: string;
  dailyBudget: number;
  status: EntityStatus;
  spend: number;
  conversions: number;
  roas: number;
};

export type AdGroup = {
  id: string;
  campaignId: string;
  channel: Channel;
  name: string;
  dailyBudget: number;
  status: EntityStatus;
};

export type Ad = {
  id: string;
  adgroupId: string;
  channel: Channel;
  name: string;
  status: EntityStatus;
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

export type ChangeOperation =
  | { kind: "update_budget"; channel: Channel; entityType: EntityType; id: string; dailyBudget: number }
  | { kind: "set_status"; channel: Channel; entityType: EntityType; id: string; status: EntityStatus }
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

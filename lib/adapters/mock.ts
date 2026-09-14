import type { Ad, AdGroup, Campaign, Channel, ChangeOperation, EntityType, StatsRow } from "@/lib/types";

const campaigns: Campaign[] = [
  { id: "sa-c1", channel: "naver_sa", name: "브랜드 캠페인", dailyBudget: 30000, status: "on", spend: 1240000, conversions: 54, roas: 482 },
  { id: "sa-c2", channel: "naver_sa", name: "B2B 일반검색", dailyBudget: 80000, status: "on", spend: 2380000, conversions: 31, roas: 321 },
  { id: "gfa-c1", channel: "naver_gfa", name: "GFA 리타겟팅", dailyBudget: 120000, status: "on", spend: 3650000, conversions: 47, roas: 518 },
  { id: "meta-c1", channel: "meta", name: "메타 협력광고", dailyBudget: 150000, status: "on", spend: 4120000, conversions: 83, roas: 607 },
];

const adgroups: AdGroup[] = [
  { id: "sa-g1", campaignId: "sa-c1", channel: "naver_sa", name: "브랜드_PC", dailyBudget: 15000, status: "on" },
  { id: "sa-g2", campaignId: "sa-c1", channel: "naver_sa", name: "브랜드_MO", dailyBudget: 15000, status: "on" },
  { id: "sa-g3", campaignId: "sa-c2", channel: "naver_sa", name: "B2B_MO", dailyBudget: 40000, status: "on" },
  { id: "gfa-g1", campaignId: "gfa-c1", channel: "naver_gfa", name: "방문자_MO", dailyBudget: 120000, status: "on" },
  { id: "meta-g1", campaignId: "meta-c1", channel: "meta", name: "협력광고_구매", dailyBudget: 150000, status: "on" },
];

const ads: Ad[] = [
  { id: "sa-a1", adgroupId: "sa-g1", channel: "naver_sa", name: "공식몰 혜택", status: "on" },
  { id: "sa-a2", adgroupId: "sa-g2", channel: "naver_sa", name: "모바일 브랜드", status: "on" },
  { id: "meta-a1", adgroupId: "meta-g1", channel: "meta", name: "협력광고 영상 A", status: "on" },
];

function channelMatches(value: Channel, filter?: Channel) {
  return !filter || value === filter;
}

export const mockAdapter = {
  async listCampaigns(channel?: Channel, includeOff = false) {
    return campaigns.filter((row) => channelMatches(row.channel, channel) && (includeOff || row.status === "on"));
  },
  async listAdgroups(channel: Channel, campaignId: string) {
    return adgroups.filter((row) => row.channel === channel && row.campaignId === campaignId);
  },
  async listAds(channel: Channel, adgroupId: string) {
    return ads.filter((row) => row.channel === channel && row.adgroupId === adgroupId);
  },
  async getStats(channel?: Channel, _level = "campaign", ids?: string[]): Promise<StatsRow[]> {
    return campaigns
      .filter((row) => channelMatches(row.channel, channel) && (!ids?.length || ids.includes(row.id)))
      .map((row, index) => {
        const impressions = 240000 + index * 51000;
        const clicks = 5100 + index * 720;
        const revenue = Math.round(row.spend * row.roas / 100);
        return {
          id: row.id,
          name: row.name,
          channel: row.channel,
          spend: row.spend,
          impressions,
          clicks,
          conversions: row.conversions,
          revenue,
          ctr: Number(((clicks / impressions) * 100).toFixed(2)),
          cpc: Math.round(row.spend / clicks),
          roas: row.roas,
        };
      });
  },
  async resolveEntity(channel: Channel, entityType: EntityType, id: string) {
    const collection = entityType === "campaign" ? campaigns : entityType === "adgroup" ? adgroups : ads;
    return collection.find((row) => row.channel === channel && row.id === id) ?? null;
  },
  async apply(operation: ChangeOperation) {
    if (operation.kind === "create_text_ad") {
      const created = operation.adgroupIds.map((adgroupId, index) => ({
        id: `created-${Date.now()}-${index}`,
        adgroupId,
        channel: "naver_sa" as const,
        name: operation.headline,
        status: "on" as const,
      }));
      ads.push(...created);
      return { success: true, changed: created.length, data: created };
    }
    const collection = operation.entityType === "campaign" ? campaigns : operation.entityType === "adgroup" ? adgroups : ads;
    const entity = collection.find((row) => row.id === operation.id && row.channel === operation.channel);
    if (!entity) throw new Error("변경 대상을 찾을 수 없습니다.");
    if (operation.kind === "update_budget") {
      if (!("dailyBudget" in entity)) throw new Error("해당 대상은 예산 변경을 지원하지 않습니다.");
      entity.dailyBudget = operation.dailyBudget;
    } else {
      entity.status = operation.status;
    }
    return { success: true, changed: 1, data: entity };
  },
};

import { naverRequest } from "@/lib/adapters/live";
import { withNaverSaAccounts } from "@/lib/naver-sa-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CID = 1922718;
const pick = (src: any, keys: string[]) => Object.fromEntries(keys.filter((k) => src[k] !== undefined && src[k] !== null).map((k) => [k, src[k]]));

// 5060 테스트: 기존 SA 캠페인을 복제해 45~59 전용 캠페인을 만든다 (1회성 작업용).
// body: { srcCampaignId, name, periodStartDt, periodEndDt, ageTarget? (검증된 AGE_TARGET JSON), powerlinkAds? [{headline,description}] , onlyActiveGroups? }
export async function POST(request: Request) {
  return withNaverSaAccounts(request, async () => {
    const log: any[] = [];
    try {
      const body = (await request.json()) as any;
      const { srcCampaignId, name } = body;
      if (!srcCampaignId || !name) return Response.json({ error: "srcCampaignId와 name이 필요합니다." }, { status: 400 });

      const campaigns = (await naverRequest("GET", "/ncc/campaigns", undefined, String(CID))) as any[];
      const src = campaigns.find((c) => c.nccCampaignId === srcCampaignId);
      if (!src) return Response.json({ error: "원본 캠페인을 찾을 수 없습니다." }, { status: 404 });

      // 1) 캠페인 생성 (userLock: true 로 만들어 세팅 끝날 때까지 노출 안 되게)
      const campaignBody: any = {
        campaignTp: src.campaignTp, customerId: CID, name,
        useDailyBudget: false, userLock: true,
        deliveryMethod: src.deliveryMethod, trackingMode: src.trackingMode,
        ...(body.periodStartDt && body.periodEndDt ? { usePeriod: true, periodStartDt: body.periodStartDt, periodEndDt: body.periodEndDt } : {}),
      };
      const created = await naverRequest("POST", "/ncc/campaigns", campaignBody, String(CID));
      const newCampaignId = (created as any)?.nccCampaignId;
      log.push({ step: "campaign", ok: true, id: newCampaignId, name });

      // 2) 광고그룹 복사 (기본: 운영 중(userLock=false) 그룹만)
      const groups = ((await naverRequest("GET", `/ncc/adgroups?nccCampaignId=${srcCampaignId}`, undefined, String(CID))) as any[])
        .filter((g) => !g.delFlag && (body.onlyActiveGroups === false || !g.userLock));
      for (const g of groups) {
        const targets = (g.targets || [])
          .filter((t: any) => !t.delFlag && t.targetTp !== "AGE_TARGET")
          .map((t: any) => ({ targetTp: t.targetTp, target: t.target }));
        if (body.ageTarget) targets.push({ targetTp: "AGE_TARGET", target: body.ageTarget });
        const groupBody: any = {
          nccCampaignId: newCampaignId, customerId: CID, name: g.name,
          ...pick(g, ["bidAmt", "contentsNetworkBidAmt", "useCntsNetworkBidAmt", "dailyBudget", "useDailyBudget", "mobileChannelId", "pcChannelId",
            "mobileNetworkBidWeight", "pcNetworkBidWeight", "adgroupType", "adRollingType", "useExpSearch", "aiAdsOptIn", "expSearchBudgetRatio"]),
          userLock: false, targets,
        };
        let newGroup: any;
        try {
          newGroup = await naverRequest("POST", "/ncc/adgroups", groupBody, String(CID));
        } catch (error) {
          // AGE_TARGET 형식이 거절되면 타겟 없이 재시도해 어디까지 되는지 남긴다
          if (body.ageTarget) {
            groupBody.targets = targets.filter((t: any) => t.targetTp !== "AGE_TARGET");
            try { newGroup = await naverRequest("POST", "/ncc/adgroups", groupBody, String(CID)); log.push({ step: "group-age-rejected", src: g.name, error: String((error as Error).message).slice(0, 300) }); }
            catch (err2) { log.push({ step: "group", src: g.name, ok: false, error: String((err2 as Error).message).slice(0, 300) }); continue; }
          } else { log.push({ step: "group", src: g.name, ok: false, error: String((error as Error).message).slice(0, 300) }); continue; }
        }
        const newGroupId = newGroup?.nccAdgroupId;
        log.push({ step: "group", src: g.name, ok: true, id: newGroupId });
        if (!newGroupId) continue;

        // 3) 키워드 복사 (100개씩)
        try {
          const kws = ((await naverRequest("GET", `/ncc/keywords?nccAdgroupId=${g.nccAdgroupId}`, undefined, String(CID))) as any[]).filter((k) => !k.delFlag);
          let copied = 0;
          for (let i = 0; i < kws.length; i += 100) {
            const chunk = kws.slice(i, i + 100).map((k) => ({ keyword: k.keyword, ...pick(k, ["bidAmt", "useGroupBidAmt", "userLock", "links"]) }));
            const res = (await naverRequest("POST", `/ncc/keywords?nccAdgroupId=${newGroupId}`, chunk, String(CID))) as any[];
            copied += Array.isArray(res) ? res.length : 0;
          }
          log.push({ step: "keywords", group: g.name, total: kws.length, copied });
        } catch (error) {
          log.push({ step: "keywords", group: g.name, ok: false, error: String((error as Error).message).slice(0, 300) });
        }

        // 4) 소재: 파워링크는 5060 문안으로 새로 등록, 쇼핑검색은 원본 소재 구조 복사 시도
        try {
          const srcAds = ((await naverRequest("GET", `/ncc/ads?nccAdgroupId=${g.nccAdgroupId}`, undefined, String(CID))) as any[]).filter((a) => !a.delFlag);
          if (g.adgroupType === "WEB_SITE" && Array.isArray(body.powerlinkAds) && body.powerlinkAds.length) {
            const landing = srcAds.find((a) => a.ad?.pc?.final)?.ad;
            for (const copy of body.powerlinkAds.slice(0, 5)) {
              await naverRequest("POST", "/ncc/ads", { nccAdgroupId: newGroupId, type: "TEXT_45",
                ad: { headline: copy.headline, description: copy.description, pc: { final: landing?.pc?.final }, mobile: { final: landing?.mobile?.final || landing?.pc?.final } } }, String(CID));
            }
            log.push({ step: "ads", group: g.name, created: Math.min(body.powerlinkAds.length, 5), landing: landing?.pc?.final });
          } else if (g.adgroupType === "SHOPPING") {
            let okCount = 0, firstError = "";
            for (const a of srcAds.slice(0, 50)) {
              try { await naverRequest("POST", "/ncc/ads", { nccAdgroupId: newGroupId, type: a.type, ad: a.ad, adAttr: a.adAttr }, String(CID)); okCount++; }
              catch (error) { if (!firstError) firstError = String((error as Error).message).slice(0, 200); }
            }
            log.push({ step: "ads(shopping)", group: g.name, src: srcAds.length, created: okCount, ...(firstError ? { firstError } : {}) });
          }
        } catch (error) {
          log.push({ step: "ads", group: g.name, ok: false, error: String((error as Error).message).slice(0, 300) });
        }
      }
      return Response.json({ newCampaignId, log });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "복제 실패", log }, { status: 500 });
    }
  });
}

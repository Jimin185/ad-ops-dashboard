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

      // 빈 광고그룹 삭제 (소재·키워드가 없는 그룹만 지워준다 — 안전장치)
      if (body.action === "delete_adgroup") {
        const adgroupId = String(body.adgroupId || "");
        if (!adgroupId.startsWith("grp-")) return Response.json({ error: "adgroupId가 필요합니다." }, { status: 400 });
        const ads = ((await naverRequest("GET", `/ncc/ads?nccAdgroupId=${adgroupId}`, undefined, String(CID))) as any[]).filter((a) => !a.delFlag);
        const kws = ((await naverRequest("GET", `/ncc/keywords?nccAdgroupId=${adgroupId}`, undefined, String(CID))) as any[]).filter((k) => !k.delFlag);
        if (ads.length || kws.length) return Response.json({ error: `빈 그룹이 아닙니다 (소재 ${ads.length}, 키워드 ${kws.length}) — 삭제 중단` }, { status: 400 });
        await naverRequest("DELETE", `/ncc/adgroups/${adgroupId}`, undefined, String(CID));
        return Response.json({ ok: true, deleted: adgroupId });
      }

      // 보정: 생성 시 targets가 무시되는 문제 → 기존 타겟 행은 PUT으로 값 교체, 없는 타입(AGE 등)은 광고그룹 PUT으로 추가 시도
      if (body.action === "fix_targets") {
        const { adgroupId, targets } = body as { adgroupId: string; targets: Array<{ targetTp: string; target: any }> };
        if (!adgroupId || !Array.isArray(targets)) return Response.json({ error: "adgroupId와 targets가 필요합니다." }, { status: 400 });
        const existing = (await naverRequest("GET", `/ncc/targets?ownerId=${adgroupId}`, undefined, String(CID))) as any[];
        for (const want of targets) {
          const row = existing.find((t) => t.targetTp === want.targetTp && !t.delFlag);
          try {
            if (row) {
              await naverRequest("PUT", `/ncc/targets/${row.nccTargetId}`, { nccTargetId: row.nccTargetId, ownerId: adgroupId, targetTp: want.targetTp, target: want.target }, String(CID));
              log.push({ step: "target-put", targetTp: want.targetTp, ok: true });
            } else {
              const group = (await naverRequest("GET", `/ncc/adgroups/${adgroupId}`, undefined, String(CID))) as any;
              const keep = (group.targets || []).filter((t: any) => !t.delFlag).map((t: any) => ({ nccTargetId: t.nccTargetId, ownerId: adgroupId, targetTp: t.targetTp, target: t.target }));
              const payload = { ...group, targets: [...keep, { ownerId: adgroupId, targetTp: want.targetTp, target: want.target }] };
              await naverRequest("PUT", `/ncc/adgroups/${adgroupId}?fields=targets`, payload, String(CID))
                .catch(() => naverRequest("PUT", `/ncc/adgroups/${adgroupId}`, payload, String(CID)));
              log.push({ step: "target-add-via-group", targetTp: want.targetTp, ok: true });
            }
          } catch (error) {
            log.push({ step: "target", targetTp: want.targetTp, ok: false, error: String((error as Error).message).slice(0, 300) });
          }
        }
        const after = (await naverRequest("GET", `/ncc/targets?ownerId=${adgroupId}`, undefined, String(CID))) as any[];
        return Response.json({ log, after: after.map((t) => ({ targetTp: t.targetTp, target: t.target })) });
      }

      // 쇼핑검색 소재 복사 재시도: referenceKey(상품) 포함해서 기존 그룹에 추가
      if (body.action === "copy_shopping_ads") {
        const { srcAdgroupId, dstAdgroupId } = body;
        if (!srcAdgroupId || !dstAdgroupId) return Response.json({ error: "srcAdgroupId, dstAdgroupId가 필요합니다." }, { status: 400 });
        const srcAds = ((await naverRequest("GET", `/ncc/ads?nccAdgroupId=${srcAdgroupId}`, undefined, String(CID))) as any[]).filter((a) => !a.delFlag);
        let ok = 0; const errors: string[] = [];
        for (const a of srcAds.slice(0, 100)) {
          try {
            await naverRequest("POST", "/ncc/ads", { nccAdgroupId: dstAdgroupId, type: a.type, referenceKey: a.referenceKey, ad: a.ad || {}, adAttr: pick(a.adAttr || {}, ["bidAmt", "useGroupBidAmt"]), userLock: a.userLock }, String(CID));
            ok++;
          } catch (error) { errors.push(String((error as Error).message).slice(0, 180)); }
        }
        return Response.json({ src: srcAds.length, created: ok, errors: errors.slice(0, 3) });
      }

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

        // 생성 시 targets가 무시되므로, 기본 생성된 타겟 행을 원본 값으로 교체한다 (AGE는 API 불가 → UI 작업)
        try {
          const srcDetail = (await naverRequest("GET", `/ncc/adgroups/${g.nccAdgroupId}`, undefined, String(CID))) as any;
          const newRows = (await naverRequest("GET", `/ncc/targets?ownerId=${newGroupId}`, undefined, String(CID))) as any[];
          for (const st of (srcDetail.targets || []).filter((t: any) => !t.delFlag)) {
            const row = newRows.find((t) => t.targetTp === st.targetTp && !t.delFlag);
            if (!row) { log.push({ step: "target-missing", group: g.name, targetTp: st.targetTp }); continue; }
            await naverRequest("PUT", `/ncc/targets/${row.nccTargetId}`, { nccTargetId: row.nccTargetId, ownerId: newGroupId, targetTp: st.targetTp, target: st.target }, String(CID));
          }
          log.push({ step: "targets-synced", group: g.name });
        } catch (error) {
          log.push({ step: "targets-synced", group: g.name, ok: false, error: String((error as Error).message).slice(0, 200) });
        }

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

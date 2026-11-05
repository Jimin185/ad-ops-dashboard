// 임시 조사용(research/desker-desk 브랜치 미리보기 전용, main에 합치지 않음).
// 데스커 책상세트 A/B 표본 추정: Meta·GFA 소재 단위 월별 성과 조회만 한다. 광고 계정은 바꾸지 않는다.
import { researchApi } from "@/lib/adapters/live";
import { cacheGet, cacheSet } from "@/lib/cache";
import * as XLSX from "xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const { metaGet, jsonFetch, gfaGet, gfaPaged } = researchApi;
const META = ["257564553970351", "997939412007167", "3766748316936261", "1260892628213172", "523357897181117", "1548674285778021"];
const GFA = ["2092921", "44324"];
const MONTHS: Array<{ m: string; since: string; until: string }> = [];
for (let d = new Date(Date.UTC(2025, 9, 1)); d <= new Date(Date.UTC(2026, 10, 1)); d.setUTCMonth(d.getUTCMonth() + 1)) {
  const m = d.toISOString().slice(0, 7);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  MONTHS.push({ m, since: `${m}-01`, until: m === "2026-11" ? "2026-11-04" : end });
}
const TTL = Date.now() + 30 * 86400_000;
const num = (v: unknown) => Number(v) || 0;
const KEEP = /purchase|add_to_cart|landing_page_view|view_content/;

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>) {
  const out: R[] = []; let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
const pickMonths = (q: string | null) => q ? MONTHS.filter((x) => q.split(",").includes(x.m)) : MONTHS;

// ---------- Meta ----------
const STATUSES = ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "DISAPPROVED", "PENDING_REVIEW", "PREAPPROVED", "PENDING_BILLING_INFO", "WITH_ISSUES", "IN_PROCESS"];
const compactActs = (list: any[] | undefined) => {
  const o: Record<string, [number, number, number]> = {};
  for (const x of list || []) if (KEEP.test(x.action_type)) o[x.action_type] = [num(x.value), num(x["7d_click"]), num(x["1d_view"])];
  return o;
};
async function metaMonth(acct: string, mo: { m: string; since: string; until: string }) {
  const base = { level: "ad", time_range: JSON.stringify({ since: mo.since, until: mo.until }), action_attribution_windows: JSON.stringify(["7d_click", "1d_view"]),
    filtering: JSON.stringify([{ field: "ad.effective_status", operator: "IN", value: STATUSES }]), limit: "500" };
  const f = "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,impressions,clicks,inline_link_clicks,spend,actions,action_values";
  let body: any, catalog = true;
  try { body = await metaGet(`act_${acct}/insights`, { ...base, fields: `${f},catalog_segment_actions,catalog_segment_value` }); }
  catch (e) { catalog = false; body = await metaGet(`act_${acct}/insights`, { ...base, fields: f }); }
  const rows: any[] = [...(body.data || [])];
  for (let p = 0; body.paging?.next && p < 40; p++) { body = await jsonFetch(body.paging.next); rows.push(...(body.data || [])); }
  const out = rows.map((r) => ({ m: mo.m, acct, cid: r.campaign_id, cn: r.campaign_name, sid: r.adset_id, sn: r.adset_name, aid: r.ad_id, an: r.ad_name,
    imp: num(r.impressions), clk: num(r.clicks), lclk: num(r.inline_link_clicks), spend: num(r.spend),
    a: compactActs(r.actions), av: compactActs(r.action_values), cs: compactActs(r.catalog_segment_actions), csv: compactActs(r.catalog_segment_value) }));
  await cacheSet(`research:meta:${acct}:${mo.m}`, { rows: out, catalog, at: new Date().toISOString() }, TTL);
  return out;
}

// ---------- GFA ----------
async function gfaMonth(acct: string, mo: { m: string; since: string; until: string }) {
  const range = { startDate: mo.since, endDate: mo.until, timeUnit: "daily" };
  const base = `/adAccounts/${acct}`;
  const [perf, conv] = await Promise.all([gfaPaged(`${base}/performance/past/creatives`, range), gfaPaged(`${base}/performance/conversion/past/creatives`, range)]);
  const agg = new Map<string, any>();
  const get = (r: any) => { const k = String(r.creativeNo ?? r.adNo ?? ""); if (!agg.has(k)) agg.set(k, { m: mo.m, acct, crid: k, cid: String(r.campaignNo ?? ""), sid: String(r.adSetNo ?? ""), imp: 0, clk: 0, spend: 0, conv: {} as Record<string, [number, number]> }); return agg.get(k); };
  for (const r of perf) { const g = get(r); g.imp += num(r.impCount); g.clk += num(r.clickCount); g.spend += num(r.sales); if (!g.sid && r.adSetNo) g.sid = String(r.adSetNo); }
  for (const r of conv) {
    const g = get(r);
    // 전환 구분(공식몰/외부몰 등)이 다른 필드로 오면 키에 붙여 나눠 둔다
    const extra = ["convTrackingType", "conversionType", "convSource", "convMethod", "convChannel", "mallType"].map((k) => r[k]).filter(Boolean).join("|");
    const key = `${r.convType}${extra ? `|${extra}` : ""}`;
    const c = (g.conv[key] ||= [0, 0]); c[0] += num(r.convCount); c[1] += num(r.convSales);
  }
  const out = [...agg.values()];
  await cacheSet(`research:gfa:${acct}:${mo.m}`, { rows: out, perfKeys: Object.keys(perf[0] || {}), convKeys: Object.keys(conv[0] || {}), convSample: conv[0] || null, at: new Date().toISOString() }, TTL);
  return { out, perfKeys: Object.keys(perf[0] || {}), convKeys: Object.keys(conv[0] || {}), convSample: conv[0] || null };
}

async function loadAll(channel: "meta" | "gfa") {
  const accts = channel === "meta" ? META : GFA;
  const rows: any[] = []; const missing: string[] = [];
  await pool(accts.flatMap((a) => MONTHS.map((mo) => [a, mo.m] as const)), 8, async ([a, m]) => {
    const hit = await cacheGet<any>(`research:${channel}:${a}:${m}`);
    if (hit) rows.push(...hit.value.rows); else missing.push(`${a}:${m}`);
  });
  return { rows, missing };
}

// ---------- 소재 ----------
async function metaCreatives(acct: string) {
  const { rows } = await loadAll("meta");
  const ids = [...new Set(rows.filter((r) => r.acct === acct && r.spend > 0).map((r) => r.aid))];
  const prev = (await cacheGet<Record<string, any>>(`research:metacr:${acct}`))?.value || {};
  const todo = ids.filter((id) => !prev[id]);
  const crFields = "creative{id,name,title,body,image_hash,image_url,thumbnail_url,video_id,object_url,link_url,object_story_spec,asset_feed_spec}";
  const started = Date.now();
  for (let i = 0; i < todo.length && Date.now() - started < 40_000; i += 50) {
    const chunk = todo.slice(i, i + 50);
    const body = await metaGet("", { ids: chunk.join(","), fields: `name,${crFields}` }).catch(() => ({}));
    for (const id of chunk) {
      const c = (body as any)[id]?.creative || {};
      const oss = c.object_story_spec || {}, ld = oss.link_data || {}, vd = oss.video_data || {}, afs = c.asset_feed_spec || {};
      const hashes = [c.image_hash, ld.image_hash, vd.image_hash, ...(ld.child_attachments || []).map((x: any) => x.image_hash), ...(afs.images || []).map((x: any) => x.hash)].filter(Boolean);
      const urls = [c.image_url, ld.picture, vd.image_url, ...(ld.child_attachments || []).map((x: any) => x.picture)].filter(Boolean);
      const videos = [c.video_id, vd.video_id, ...(afs.videos || []).map((x: any) => x.video_id)].filter(Boolean);
      const text = [c.title, c.body, ld.message, ld.name, ld.description, vd.message, vd.title, ...(afs.titles || []).map((x: any) => x.text), ...(afs.bodies || []).map((x: any) => x.text)].filter(Boolean).join(" / ").slice(0, 600);
      const link = ld.link || c.object_url || c.link_url || vd.call_to_action?.value?.link || (afs.link_urls || [])[0]?.website_url || "";
      prev[id] = { cr: c.id, hashes: [...new Set(hashes)], urls, videos: [...new Set(videos)], thumb: c.thumbnail_url, text, link, carousel: (ld.child_attachments || []).length, dynamic: Boolean(c.asset_feed_spec) };
    }
  }
  // 해시 → 원본 url
  const needHash = [...new Set(Object.values(prev).flatMap((x: any) => x.hashes))].filter((h) => !(prev.__hash || {})[h]);
  prev.__hash ||= {};
  for (let i = 0; i < needHash.length && Date.now() - started < 50_000; i += 40) {
    const chunk = needHash.slice(i, i + 40);
    const b = await metaGet(`act_${acct}/adimages`, { hashes: JSON.stringify(chunk), fields: "hash,url,permalink_url,width,height" }).catch(() => ({ data: [] }));
    for (const im of (b as any).data || []) prev.__hash[im.hash] = im.url || im.permalink_url;
    for (const h of chunk) prev.__hash[h] ||= "";
  }
  const needVid = [...new Set(Object.values(prev).flatMap((x: any) => x?.videos || []))].filter((v) => !(prev.__video || {})[v]);
  prev.__video ||= {};
  for (let i = 0; i < needVid.length && Date.now() - started < 55_000; i += 40) {
    const chunk = needVid.slice(i, i + 40);
    const b = await metaGet("", { ids: chunk.join(","), fields: "picture,thumbnails{uri,is_preferred}" }).catch(() => ({}));
    for (const v of chunk) { const x = (b as any)[v]; prev.__video[v] = (x?.thumbnails?.data || []).find((t: any) => t.is_preferred)?.uri || x?.thumbnails?.data?.[0]?.uri || x?.picture || ""; }
  }
  await cacheSet(`research:metacr:${acct}`, prev, TTL);
  return { total: ids.length, done: ids.filter((id) => prev[id]).length, hashes: Object.keys(prev.__hash).length, videos: Object.keys(prev.__video).length };
}

async function gfaMeta(acct: string) {
  const base = `/adAccounts/${acct}`;
  const prev = (await cacheGet<any>(`research:gfacr:${acct}`))?.value || { cr: {}, camp: {}, set: {} };
  const started = Date.now();
  if (!Object.keys(prev.camp).length) {
    for (let p = 0; p < 50; p++) { const b = await gfaGet(`${base}/campaigns`, { page: String(p), size: "100" }); const items = Array.isArray(b) ? b : b.content || []; for (const c of items) prev.camp[c.no] = c.name; if (items.length < 100) break; }
  }
  const { rows } = await loadAll("gfa");
  const mine = rows.filter((r) => r.acct === acct && r.spend > 0);
  const sets = [...new Set(mine.map((r) => r.sid).filter(Boolean))].filter((s) => !(s in prev.set));
  await pool(sets, 8, async (s) => { if (Date.now() - started > 25_000) return; try { const b = await gfaGet(`${base}/adSets/${s}`); prev.set[s] = b.name; } catch { prev.set[s] = ""; } });
  const crs = [...new Set(mine.map((r) => r.crid))].filter((c) => !(c in prev.cr));
  await pool(crs, 8, async (c) => {
    if (Date.now() - started > 50_000) return;
    try {
      const b = await gfaGet(`${base}/creatives/${c}`);
      const medias = [b.image, b.media, ...(b.medias || []), ...(b.images || []), ...(b.slides || [])].filter(Boolean);
      prev.cr[c] = { name: b.name, sid: String(b.adSetNo ?? ""), urls: medias.map((m: any) => m.imageUrl || m.url || m.thumbnailUrl).filter(Boolean).concat(b.imageUrl ? [b.imageUrl] : []), text: [b.title, b.headline, b.description, b.body].filter(Boolean).join(" / ").slice(0, 600), link: b.landingUrl || b.linkUrl || b.url || "", keys: Object.keys(b).join(",") };
    } catch (e) { prev.cr[c] = { error: String(e).slice(0, 200) }; }
  });
  await cacheSet(`research:gfacr:${acct}`, prev, TTL);
  return { creatives: crs.length, have: Object.keys(prev.cr).length, sets: Object.keys(prev.set).length, camps: Object.keys(prev.camp).length, sample: Object.values(prev.cr)[0] };
}

// ---------- 이미지 해시(dHash 64bit) ----------
async function dhash(url: string): Promise<string> {
  const sharp = (await import("sharp")).default;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const px = await sharp(buf).grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? "1" : "0";
  return BigInt("0b" + bits).toString(16).padStart(16, "0");
}
async function imageList() {
  const items: Array<{ key: string; channel: string; id: string; urls: string[]; hashes: string[] }> = [];
  for (const a of META) {
    const cr = (await cacheGet<any>(`research:metacr:${a}`))?.value || {};
    for (const [id, x] of Object.entries<any>(cr)) {
      if (id.startsWith("__")) continue;
      const urls = [...(x.hashes || []).map((h: string) => cr.__hash?.[h]).filter(Boolean), ...(x.videos || []).map((v: string) => cr.__video?.[v]).filter(Boolean), ...(x.urls || [])];
      if (!urls.length && x.thumb) urls.push(x.thumb);
      items.push({ key: `meta_${id}`, channel: "meta", id, urls: [...new Set(urls)] as string[], hashes: x.hashes || [] });
    }
  }
  for (const a of GFA) {
    const g = (await cacheGet<any>(`research:gfacr:${a}`))?.value || { cr: {} };
    for (const [id, x] of Object.entries<any>(g.cr)) items.push({ key: `gfa_${id}`, channel: "gfa", id, urls: x.urls || [], hashes: [] });
  }
  return items;
}
async function hashImages() {
  const prev = (await cacheGet<Record<string, string>>("research:dhash"))?.value || {};
  const items = await imageList();
  const urls = [...new Set(items.flatMap((i) => i.urls.slice(0, 10)))].filter((u) => !(u in prev));
  const started = Date.now();
  await pool(urls, 12, async (u) => { if (Date.now() - started > 45_000) return; try { prev[u] = await dhash(u); } catch { prev[u] = ""; } });
  await cacheSet("research:dhash", prev, TTL);
  return { total: [...new Set(items.flatMap((i) => i.urls.slice(0, 10)))].length, remaining: urls.filter((u) => !(u in prev)).length };
}

// ---------- 분류·묶기·집계 ----------
type Cls = "책상세트 확실" | "애매" | "모션데스크" | "아님";
function classify(text: string): Cls {
  const t = text.replace(/\s+/g, "");
  if (/모션|높이조절|스탠딩|전동/.test(t)) return "모션데스크";
  const set = /책상세트|데스크세트|책상\+책장|책상책장|학생책상세트/.test(t);
  const kid = /학생|아이방|키즈|입학|신학기|공부방|초등|중학|고등|수험|스터디|자녀|어린이|학습/.test(t);
  const desk = /책상|데스크|desk/i.test(t);
  if (set && (kid || desk)) return "책상세트 확실";
  if (kid && desk) return "책상세트 확실";
  if (set || desk || kid) return "애매";
  return "아님";
}
const hamming = (a: string, b: string) => { let x = BigInt("0x" + a) ^ BigInt("0x" + b), n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };

async function build() {
  const overrides: Record<string, Cls> = ((await import("@/lib/research-overrides.json")) as any).default || {};
  const meta = await loadAll("meta"), gfa = await loadAll("gfa");
  const items = await imageList();
  const dh = (await cacheGet<Record<string, string>>("research:dhash"))?.value || {};
  const metaCr: Record<string, any> = {}; for (const a of META) Object.assign(metaCr, (await cacheGet<any>(`research:metacr:${a}`))?.value || {});
  const gfaCr: Record<string, any> = {}; const gfaSet: Record<string, string> = {}; const gfaCamp: Record<string, string> = {};
  for (const a of GFA) { const g = (await cacheGet<any>(`research:gfacr:${a}`))?.value; if (g) { Object.assign(gfaCr, g.cr); Object.assign(gfaSet, g.set); Object.assign(gfaCamp, g.camp); } }

  // 광고(소재)별 정보
  type Ad = { key: string; channel: string; id: string; acct: string; cid: string; cn: string; sid: string; sn: string; name: string; text: string; link: string; urls: string[]; cls: Cls; group?: string };
  const ads = new Map<string, Ad>();
  for (const r of meta.rows) if (!ads.has(`meta_${r.aid}`)) { const c = metaCr[r.aid] || {}; ads.set(`meta_${r.aid}`, { key: `meta_${r.aid}`, channel: "meta", id: r.aid, acct: r.acct, cid: r.cid, cn: r.cn, sid: r.sid, sn: r.sn, name: r.an, text: c.text || "", link: c.link || "", urls: [], cls: "아님" }); }
  for (const r of gfa.rows) if (!ads.has(`gfa_${r.crid}`)) { const c = gfaCr[r.crid] || {}; ads.set(`gfa_${r.crid}`, { key: `gfa_${r.crid}`, channel: "gfa", id: r.crid, acct: r.acct, cid: r.cid, cn: gfaCamp[r.cid] || "", sid: r.sid || c.sid || "", sn: gfaSet[r.sid || c.sid] || "", name: c.name || `소재 ${r.crid}`, text: c.text || "", link: c.link || "", urls: [], cls: "아님" }); }
  for (const it of items) { const a = ads.get(it.key); if (a) a.urls = it.urls; }
  for (const a of ads.values()) a.cls = overrides[a.key] || classify(`${a.cn} ${a.sn} ${a.name} ${a.text} ${a.link}`);

  // 묶기: 같은 이미지 해시(Meta) 또는 dHash 거리 ≤ 8
  const parent = new Map<string, string>(); const find = (x: string): string => { const p = parent.get(x) || x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const byHash = new Map<string, string>();
  for (const it of items) for (const h of it.hashes) { if (byHash.has(h)) union(byHash.get(h)!, it.key); else byHash.set(h, it.key); }
  const sigs: Array<[string, string]> = [];
  for (const it of items) { const s = dh[it.urls[0]]; if (s && s !== "0000000000000000" && s !== "ffffffffffffffff") sigs.push([it.key, s]); }
  for (let i = 0; i < sigs.length; i++) for (let j = i + 1; j < sigs.length; j++) if (hamming(sigs[i][1], sigs[j][1]) <= 8) union(sigs[i][0], sigs[j][0]);
  const groups = new Map<string, Ad[]>();
  for (const a of ads.values()) { const r = find(a.key); (groups.get(r) || groups.set(r, []).get(r)!).push(a); }
  let gi = 0; const groupList = [...groups.values()].map((list) => ({ gid: `G${String(++gi).padStart(4, "0")}`, list }));
  for (const g of groupList) for (const a of g.list) a.group = g.gid;
  // 그룹 분류: 구성원 중 가장 강한 분류
  const rank: Record<Cls, number> = { "책상세트 확실": 3, "모션데스크": 2, "애매": 1, "아님": 0 };
  const gcls = new Map(groupList.map((g) => [g.gid, g.list.reduce<Cls>((best, a) => rank[a.cls] > rank[best] ? a.cls : best, "아님")]));

  // 월별 행
  const pickType = (types: string[]) => ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"].find((t) => types.includes(t));
  const metaTypes = new Set<string>(); for (const r of meta.rows) Object.keys(r.a).forEach((t) => metaTypes.add(t));
  const pur = pickType([...metaTypes]) || "omni_purchase";
  const cart = ["omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"].find((t) => metaTypes.has(t)) || "omni_add_to_cart";
  const lpv = metaTypes.has("landing_page_view") ? "landing_page_view" : "omni_landing_page_view";
  const metaRows = meta.rows.map((r) => {
    const a = ads.get(`meta_${r.aid}`)!; const p = r.a[pur] || [0, 0, 0], pv = r.av[pur] || [0, 0, 0], cs = r.cs[pur] || r.cs.omni_purchase || [0, 0, 0], csv = r.csv[pur] || r.csv.omni_purchase || [0, 0, 0];
    return { 월: r.m, 매체: "meta", 계정: r.acct, 캠페인ID: r.cid, 캠페인: r.cn, 광고그룹ID: r.sid, 광고그룹: r.sn, 광고ID: r.aid, 광고: r.an, 노출: r.imp, 클릭_전체: r.clk, 클릭_링크: r.lclk, 비용: r.spend,
      구매_기본: p[0], 구매_7d클릭: p[1], 구매_1d조회: p[2], 구매금액_기본: pv[0], 구매금액_7d클릭: pv[1], 공유항목구매_기본: cs[0], 공유항목구매_7d클릭: cs[1], 공유항목구매금액_기본: csv[0],
      장바구니_기본: (r.a[cart] || [0])[0], 랜딩조회: (r.a[lpv] || [0])[0], 분류: gcls.get(a.group!) || a.cls, 소재그룹: a.group };
  });
  const gfaConvKeys = new Set<string>(); for (const r of gfa.rows) Object.keys(r.conv).forEach((k) => gfaConvKeys.add(k));
  const gfaRows = gfa.rows.map((r) => {
    const a = ads.get(`gfa_${r.crid}`)!;
    const sum = (re: RegExp, i: number) => Object.entries<any>(r.conv).filter(([k]) => re.test(k)).reduce((s, [, v]) => s + v[i], 0);
    const row: any = { 월: r.m, 매체: "gfa", 계정: r.acct, 캠페인ID: r.cid, 캠페인: a.cn, 광고그룹ID: a.sid, 광고그룹: a.sn, 소재ID: r.crid, 소재: a.name, 노출: r.imp, 클릭: r.clk, 비용: r.spend,
      구매: sum(/^PURCHASE/, 0), 구매금액: sum(/^PURCHASE/, 1), 장바구니: sum(/^ADD_TO_CART|^CART/, 0), 분류: gcls.get(a.group!) || a.cls, 소재그룹: a.group };
    for (const k of gfaConvKeys) if (k.includes("|")) row[`전환_${k}`] = (r.conv[k] || [0])[0];
    return row;
  });

  // 집계 (책상세트 확실)
  const agg = (rows: any[], keyFn: (r: any) => string) => { const m = new Map<string, any>(); for (const r of rows) { const k = keyFn(r); const o = m.get(k) || m.set(k, { key: k, 비용: 0, 노출: 0, 클릭: 0, 구매_기본: 0, 구매_클릭: 0, 구매금액: 0 }).get(k); o.비용 += r.비용; o.노출 += r.노출; o.클릭 += r.클릭_링크 ?? r.클릭; o.구매_기본 += r.구매_기본 ?? r.구매; o.구매_클릭 += r.구매_7d클릭 ?? r.구매; o.구매금액 += r.구매금액_기본 ?? r.구매금액; } return [...m.values()].map((o) => ({ ...o, CPA_기본: o.구매_기본 ? Math.round(o.비용 / o.구매_기본) : null, CPA_클릭: o.구매_클릭 ? Math.round(o.비용 / o.구매_클릭) : null })); };
  const sure = [...metaRows, ...gfaRows].filter((r) => r.분류 === "책상세트 확실");
  const byMonthMedia = agg(sure, (r) => `${r.월}|${r.매체}`);
  const byMonthMediaGroup = agg(sure, (r) => `${r.월}|${r.매체}|${r.소재그룹}`);
  const groupsCsv = groupList.filter((g) => g.list.some((a) => [...metaRows, ...gfaRows].some(() => true))).map((g) => ({ 그룹ID: g.gid, 분류: gcls.get(g.gid), 설명: (g.list[0].text || g.list[0].name).slice(0, 80), 매체: [...new Set(g.list.map((a) => a.channel))].join("+"), 광고ID: g.list.map((a) => a.id).join(" "), 광고명: g.list.map((a) => a.name).join(" | ").slice(0, 1000), 이미지: g.list.flatMap((a) => a.urls.slice(0, 2)).slice(0, 6).join(" ") }));
  const vague = [...ads.values()].filter((a) => (gcls.get(a.group!) || a.cls) === "애매");
  const oct = { meta: metaRows.filter((r) => r.월 === "2026-10").reduce((s, r) => s + r.비용, 0), gfa: gfaRows.filter((r) => r.월 === "2026-10").reduce((s, r) => s + r.비용, 0) };
  return { pur, cart, lpv, metaTypes: [...metaTypes], gfaConvKeys: [...gfaConvKeys], missing: { meta: meta.missing, gfa: gfa.missing }, metaRows, gfaRows, byMonthMedia, byMonthMediaGroup, groupsCsv, groupList, gcls, vague, ads, oct };
}

const csv = (rows: any[]) => { if (!rows.length) return ""; const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))]; const esc = (v: any) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; return "﻿" + [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\n"); };

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const op = q.get("op");
  try {
    if (op === "meta") {
      const acct = q.get("acct")!; const res = await pool(pickMonths(q.get("months")), 3, (mo) => metaMonth(acct, mo).then((r) => ({ m: mo.m, n: r.length, spend: Math.round(r.reduce((s, x) => s + x.spend, 0)) })).catch((e) => ({ m: mo.m, error: String(e).slice(0, 300) })));
      return Response.json(res);
    }
    if (op === "gfa") {
      const acct = q.get("acct")!; const res = await pool(pickMonths(q.get("months")), 3, (mo) => gfaMonth(acct, mo).then((r) => ({ m: mo.m, n: r.out.length, spend: Math.round(r.out.reduce((s, x) => s + x.spend, 0)), perfKeys: r.perfKeys, convKeys: r.convKeys, convSample: r.convSample })).catch((e) => ({ m: mo.m, error: String(e).slice(0, 300) })));
      return Response.json(res);
    }
    if (op === "metacr") return Response.json(await metaCreatives(q.get("acct")!));
    if (op === "gfacr") return Response.json(await gfaMeta(q.get("acct")!));
    if (op === "hash") return Response.json(await hashImages());
    const b = await build();
    if (op === "summary") {
      const pick = (m: string) => b.byMonthMedia.filter((x) => x.key.startsWith(m));
      return Response.json({ pur: b.pur, cart: b.cart, lpv: b.lpv, metaTypes: b.metaTypes, gfaConvKeys: b.gfaConvKeys, missing: b.missing, oct: b.oct,
        counts: { metaRows: b.metaRows.length, gfaRows: b.gfaRows.length, ads: b.ads.size, groups: b.groupList.length, sure: b.groupsCsv.filter((g) => g.분류 === "책상세트 확실").length, vague: b.vague.length },
        byMonthMedia: b.byMonthMedia.sort((x, y) => x.key.localeCompare(y.key)), dec: pick("2025-12"), nov: pick("2026-11") });
    }
    if (op === "names") {
      // 분류 검토용: 비용 있는 광고의 이름·문구·현재 분류
      const spend = new Map<string, number>(); for (const r of [...b.metaRows, ...b.gfaRows]) { const k = r.매체 === "meta" ? `meta_${r.광고ID}` : `gfa_${r.소재ID}`; spend.set(k, (spend.get(k) || 0) + r.비용); }
      const cls = q.get("cls");
      const list = [...b.ads.values()].filter((a) => !cls || (b.gcls.get(a.group!) || a.cls) === cls).map((a) => ({ k: a.key, s: Math.round(spend.get(a.key) || 0), c: b.gcls.get(a.group!) || a.cls, g: a.group, n: `${a.cn} › ${a.sn} › ${a.name}`.slice(0, 160), t: a.text.slice(0, 120), l: a.link.slice(0, 80) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
      const off = Number(q.get("offset") || 0); return Response.json({ total: list.length, items: list.slice(off, off + Number(q.get("limit") || 150)) });
    }
    if (op === "file") {
      const name = q.get("name");
      const headers = (type: string, file: string) => ({ "Content-Type": type, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file)}` });
      if (name === "meta_csv") return new Response(csv(b.metaRows), { headers: headers("text/csv; charset=utf-8", "meta_ads_monthly.csv") });
      if (name === "gfa_csv") return new Response(csv(b.gfaRows), { headers: headers("text/csv; charset=utf-8", "gfa_ads_monthly.csv") });
      if (name === "groups_csv") return new Response(csv(b.groupsCsv), { headers: headers("text/csv; charset=utf-8", "creative_groups.csv") });
      if (name === "xlsx") {
        const wb = XLSX.utils.book_new();
        const add = (rows: any[], n: string) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ 없음: "" }]), n);
        add(b.byMonthMedia.map((x) => { const [월, 매체] = x.key.split("|"); return { 월, 매체, ...x, key: undefined }; }), "월별");
        add(b.byMonthMediaGroup.map((x) => { const [월, 매체, 그룹] = x.key.split("|"); return { 월, 매체, 그룹, ...x, key: undefined }; }), "소재그룹별");
        add(b.vague.map((a) => ({ 키: a.key, 그룹: a.group, 캠페인: a.cn, 광고그룹: a.sn, 광고: a.name, 문구: a.text, 링크: a.link, 이미지: a.urls[0] || "" })), "분류 애매 목록");
        add(b.groupsCsv, "소재그룹");
        add(b.metaRows, "raw_meta"); add(b.gfaRows, "raw_gfa");
        const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
        return new Response(buf, { headers: headers("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "결과.xlsx") });
      }
      if (name === "sheets") {
        // 그룹별 컨택트시트(확인용 HTML). cls=책상세트 확실 등으로 거를 수 있다.
        const cls = q.get("cls");
        const gs = b.groupList.filter((g) => !cls || b.gcls.get(g.gid) === cls);
        const html = `<!doctype html><meta charset="utf-8"><title>소재 그룹 확인</title><style>body{font-family:sans-serif;margin:16px}section{border-bottom:1px solid #ddd;padding:12px 0}img{height:160px;margin:4px;border:1px solid #ccc;object-fit:contain;background:#f6f6f6}small{color:#666}</style>
${gs.map((g) => `<section><b>${g.gid}</b> · ${b.gcls.get(g.gid)} · ${g.list.length}개<br>${g.list.map((a) => `<div><small>${a.channel} ${a.id} · ${(a.cn + " › " + a.sn + " › " + a.name).replace(/</g, "&lt;")}</small></div>${a.urls.slice(0, 4).map((u) => `<img loading="lazy" referrerpolicy="no-referrer" src="${u}">`).join("")}`).join("")}</section>`).join("")}`;
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
    }
    return Response.json({ ops: ["meta&acct", "gfa&acct", "metacr&acct", "gfacr&acct", "hash", "summary", "names", "file&name=meta_csv|gfa_csv|groups_csv|xlsx|sheets"] });
  } catch (error) {
    return Response.json({ error: String(error).slice(0, 500) }, { status: 500 });
  }
}

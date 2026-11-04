// 월별 적재: 매핑된 계정의 올해 1월~전월 캠페인 성과를 Supabase에 저장하고, 매달 마감되면 추가한다.
import { dbReady, storageAvailable } from "@/lib/db";
import { fetchMonthly, type MonthlyRow } from "@/lib/adapters/live";
import { kstToday } from "@/lib/cache";
import type { Channel } from "@/lib/types";

/** 올해 1월 ~ 지난달 (KST) */
export function targetMonths() {
  const today = kstToday();
  const [y, m] = today.split("-").map(Number);
  const out: string[] = [];
  for (let i = 1; i < m; i++) out.push(`${y}-${String(i).padStart(2, "0")}`);
  return out;
}
// 전환이 늦게 잡히므로 월말 + 3일 이후에 수집한 것만 '확정'으로 본다.
const settledAt = (month: string) => { const [y, m] = month.split("-").map(Number); return Date.UTC(y, m, 1) - 9 * 3600_000 + 3 * 86400_000; };

/** 빠진 달을 채운다. 시간이 부족하면 남은 작업 수를 돌려주고, 다시 부르면 이어서 한다. */
export async function ensureMonthly(accountKeys: string[], budgetMs = 45_000) {
  if (!storageAvailable()) throw new Error("Supabase가 연결되어 있어야 월별 데이터를 저장할 수 있습니다.");
  const sql = await dbReady();
  const months = targetMonths();
  if (!months.length) return { pending: 0, done: 0 };
  const started = Date.now();
  let pending = 0, done = 0;
  const errors: Array<{ account: string; message: string }> = [];
  for (const key of [...new Set(accountKeys)]) {
    const [channel, ...rest] = key.split(":");
    const accountId = rest.join(":");
    const rows = await sql`select month, fetched_at from adops_monthly_done where channel = ${channel} and account_id = ${accountId}`;
    const fetched = new Map(rows.map((r: any) => [r.month, new Date(r.fetched_at).getTime()]));
    const missing = months.filter((m) => !fetched.has(m) || fetched.get(m)! < settledAt(m));
    if (!missing.length) { done++; continue; }
    if (Date.now() - started > budgetMs) { pending++; continue; }
    try {
      // GFA·SA는 달마다 호출하므로 한 번에 최대 4개월씩
      const batch = channel === "google_ads" || channel === "meta" ? missing : missing.slice(0, 4);
      const data = await fetchMonthly(channel as Channel, accountId, batch);
      await sql.begin(async (tx) => {
        await tx`delete from adops_monthly where channel = ${channel} and account_id = ${accountId} and month = any(${batch})`;
        for (const r of data) {
          await tx`insert into adops_monthly ${tx({ channel: r.channel, account_id: r.accountId, month: r.month, campaign_id: r.campaignId, campaign_name: r.campaignName.slice(0, 200), product: r.product, imp: Math.round(r.imp), clk: Math.round(r.clk), cost: r.cost, conv: r.conv, revenue: r.revenue })}
            on conflict (channel, account_id, month, campaign_id) do update set imp = excluded.imp, clk = excluded.clk, cost = excluded.cost, conv = excluded.conv, revenue = excluded.revenue, campaign_name = excluded.campaign_name, product = excluded.product, updated_at = now()`;
        }
        for (const m of batch) await tx`insert into adops_monthly_done (channel, account_id, month, fetched_at) values (${channel}, ${accountId}, ${m}, now()) on conflict (channel, account_id, month) do update set fetched_at = now()`;
      });
      if (batch.length < missing.length) pending++; else done++;
    } catch (error) {
      errors.push({ account: key, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { pending, done, errors };
}

export async function queryMonthly(accountKeys?: string[]): Promise<MonthlyRow[]> {
  const sql = await dbReady();
  const year = kstToday().slice(0, 4);
  const rows = accountKeys
    ? await sql`select * from adops_monthly where month >= ${`${year}-01`} and (channel || ':' || account_id) = any(${accountKeys})`
    : await sql`select * from adops_monthly where month >= ${`${year}-01`}`;
  return rows.map((r: any) => ({ channel: r.channel, accountId: r.account_id, month: r.month, campaignId: r.campaign_id, campaignName: r.campaign_name, product: r.product, imp: Number(r.imp), clk: Number(r.clk), cost: Number(r.cost), conv: Number(r.conv), revenue: Number(r.revenue) }));
}

export async function allAdvertiserAccountKeys() {
  const sql = await dbReady();
  const rows = await sql`select account_keys from adops_advertisers`;
  return [...new Set(rows.flatMap((r: any) => r.account_keys || []))] as string[];
}

// ---- 팀 공유 보드 ----
export type BoardPost = { id: string; author: string; advertiser: string; channel: string; product: string; title: string; body: string; metrics?: unknown; createdAt: string };
export async function listPosts(): Promise<BoardPost[]> {
  const sql = await dbReady();
  const rows = await sql`select * from adops_board order by created_at desc limit 200`;
  return rows.map((r: any) => ({ id: r.id, author: r.author, advertiser: r.advertiser, channel: r.channel, product: r.product, title: r.title, body: r.body, metrics: r.metrics, createdAt: new Date(r.created_at).toISOString() }));
}
export async function addPost(post: Omit<BoardPost, "id" | "createdAt">) {
  const sql = await dbReady();
  const id = crypto.randomUUID();
  await sql`insert into adops_board (id, author, advertiser, channel, product, title, body, metrics) values (${id}, ${post.author.slice(0, 40)}, ${post.advertiser.slice(0, 80)}, ${post.channel.slice(0, 30)}, ${post.product.slice(0, 60)}, ${post.title.slice(0, 200)}, ${post.body.slice(0, 4000)}, ${post.metrics ? sql.json(post.metrics as any) : null})`;
  return id;
}
export async function deletePost(id: string) {
  const sql = await dbReady();
  await sql`delete from adops_board where id = ${id}`;
}

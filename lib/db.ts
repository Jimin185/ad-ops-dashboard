import postgres from "postgres";
import type { Advertiser, MediaMix } from "@/lib/mix";

// Supabase(Postgres) 저장소. Vercel의 Supabase 연동이 넣어주는 POSTGRES_URL을 쓴다.
// 연결이 없으면 storageAvailable()이 false이고, 화면은 브라우저 저장소로 동작한다.
const url = () => process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || process.env.DATABASE_URL || "";

export const storageAvailable = () => Boolean(url());

let client: postgres.Sql | null = null;
let migrated: Promise<void> | null = null;

function sql() {
  if (!client) client = postgres(url(), { ssl: "require", max: 3, idle_timeout: 20, prepare: false, onnotice: () => {} });
  return client;
}

async function ready() {
  const db = sql();
  migrated ||= (async () => {
    // 테이블이 모두 있고 RLS도 켜져 있으면 DDL을 건너뛴다. 매 콜드스타트마다 ALTER TABLE을 돌리면
    // 다른 긴 쿼리(월별 적재·크론)와 잠금이 걸려 광고주 목록 조회까지 멈출 수 있다.
    const TABLES = ["adops_advertisers", "adops_mixes", "adops_naver_sa", "adops_cache", "adops_monthly", "adops_monthly_done", "adops_board"];
    const [{ ok }] = await db`select
      (select count(*) filter (where relrowsecurity) from pg_class where relname in ${db(TABLES)} and relkind = 'r') = ${TABLES.length}
      and exists (select 1 from information_schema.columns where table_name = 'adops_mixes' and column_name = 'lines') as ok`;
    if (ok) return;
    await db`set local lock_timeout = '3s'`.catch(() => {});
    await db`create table if not exists adops_advertisers (
      id text primary key, name text not null, account_keys jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
    await db`create table if not exists adops_mixes (
      id text primary key, advertiser_id text not null, month text not null, status text not null default 'draft',
      target_roas integer not null default 0, channels jsonb not null default '{}'::jsonb, notes text not null default '', review text,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique (advertiser_id, month))`;
    // 믹스 라인(믹스구분·캠페인 연결·기간 예산)을 통째로 보존한다. 없으면 매핑 탭이 "아직 믹스가 없어요"로 비어 보인다.
    await db`alter table adops_mixes add column if not exists lines jsonb`;
    await db`create table if not exists adops_naver_sa (
      customer_id text primary key, name text not null, sealed text not null, created_at timestamptz not null default now())`;
    await db`create table if not exists adops_cache (
      key text primary key, value jsonb not null, expires_at timestamptz, updated_at timestamptz not null default now())`;
    await db`alter table adops_cache enable row level security`;
    await db`create table if not exists adops_monthly (
      channel text not null, account_id text not null, month text not null, campaign_id text not null,
      campaign_name text not null default '', product text not null default '', imp bigint not null default 0, clk bigint not null default 0,
      cost double precision not null default 0, conv double precision not null default 0, revenue double precision not null default 0,
      updated_at timestamptz not null default now(), primary key (channel, account_id, month, campaign_id))`;
    await db`create table if not exists adops_monthly_done (channel text not null, account_id text not null, month text not null, fetched_at timestamptz not null default now(), primary key (channel, account_id, month))`;
    await db`create table if not exists adops_board (
      id text primary key, author text not null, advertiser text not null default '', channel text not null default '', product text not null default '',
      title text not null, body text not null default '', metrics jsonb, created_at timestamptz not null default now())`;
    await db`alter table adops_monthly enable row level security`;
    await db`alter table adops_monthly_done enable row level security`;
    await db`alter table adops_board enable row level security`;
    // 브라우저에서 직접 접근하지 못하도록 RLS를 켜 둔다 (서버는 service 연결로 접근).
    await db`alter table adops_advertisers enable row level security`;
    await db`alter table adops_mixes enable row level security`;
    await db`alter table adops_naver_sa enable row level security`;
  })().catch((error) => { migrated = null; throw error; });
  await migrated;
  return db;
}

const toMix = (row: any): MediaMix => ({
  id: row.id, advertiserId: row.advertiser_id, month: row.month, status: row.status, targetRoas: row.target_roas,
  channels: row.channels || {}, notes: row.notes || "", review: row.review || undefined,
  lines: Array.isArray(row.lines) && row.lines.length ? row.lines : undefined,
  createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
});

export async function listAdvertisers(): Promise<Advertiser[]> {
  const db = await ready();
  const rows = await db`select id, name, account_keys from adops_advertisers order by name`;
  return rows.map((row: any) => ({ id: row.id, name: row.name, accountKeys: row.account_keys || [] }));
}
export async function saveAdvertisers(list: Advertiser[]) {
  const db = await ready();
  await db.begin(async (tx) => {
    const ids = list.map((a) => a.id);
    if (ids.length) await tx`delete from adops_advertisers where id <> all(${ids})`;
    else await tx`delete from adops_advertisers`;
    for (const a of list) {
      await tx`insert into adops_advertisers (id, name, account_keys) values (${a.id}, ${a.name}, ${tx.json(a.accountKeys)})
        on conflict (id) do update set name = excluded.name, account_keys = excluded.account_keys, updated_at = now()`;
    }
  });
}

export async function listMixes(advertiserId?: string): Promise<MediaMix[]> {
  const db = await ready();
  const rows = advertiserId
    ? await db`select * from adops_mixes where advertiser_id = ${advertiserId} order by month desc`
    : await db`select * from adops_mixes order by month desc`;
  return rows.map(toMix);
}
export async function upsertMix(mix: MediaMix): Promise<MediaMix> {
  const db = await ready();
  const [row] = await db`insert into adops_mixes (id, advertiser_id, month, status, target_roas, channels, notes, review, lines)
    values (${mix.id}, ${mix.advertiserId}, ${mix.month}, ${mix.status}, ${mix.targetRoas}, ${db.json(mix.channels as any)}, ${mix.notes}, ${mix.review || null}, ${mix.lines?.length ? db.json(mix.lines as any) : null})
    on conflict (advertiser_id, month) do update set status = excluded.status, target_roas = excluded.target_roas, channels = excluded.channels,
      notes = excluded.notes, review = excluded.review, lines = excluded.lines, updated_at = now()
    returning *`;
  return toMix(row);
}
export async function deleteMix(id: string) {
  const db = await ready();
  await db`delete from adops_mixes where id = ${id}`;
}

export async function listNaverSaSealed(): Promise<Array<{ customerId: string; name: string; sealed: string }>> {
  const db = await ready();
  const rows = await db`select customer_id, name, sealed from adops_naver_sa order by name`;
  return rows.map((row: any) => ({ customerId: row.customer_id, name: row.name, sealed: row.sealed }));
}
export async function saveNaverSaSealed(customerId: string, name: string, sealed: string) {
  const db = await ready();
  await db`insert into adops_naver_sa (customer_id, name, sealed) values (${customerId}, ${name}, ${sealed})
    on conflict (customer_id) do update set name = excluded.name, sealed = excluded.sealed`;
}
export async function deleteNaverSa(customerId: string) {
  const db = await ready();
  await db`delete from adops_naver_sa where customer_id = ${customerId}`;
}

export async function sqlForCache() { return ready(); }

export async function dbReady() { return ready(); }

// ---- 광고주별 설정·예약 (adops_cache 테이블을 키-값 저장소로 쓴다. 메모리 캐시를 거치지 않아 여러 인스턴스에서도 최신값) ----
export async function kvGet<T>(key: string): Promise<T | null> {
  const db = await ready();
  const [row] = await db`select value from adops_cache where key = ${key}`;
  return (row?.value as T) ?? null;
}
export async function kvSet(key: string, value: unknown) {
  const db = await ready();
  await db`insert into adops_cache (key, value, expires_at, updated_at) values (${key}, ${db.json(value as any)}, null, now())
    on conflict (key) do update set value = excluded.value, expires_at = null, updated_at = now()`;
}

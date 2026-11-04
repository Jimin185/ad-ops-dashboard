import postgres from "postgres";
import type { Advertiser, MediaMix } from "@/lib/mix";

// Supabase(Postgres) 저장소. Vercel의 Supabase 연동이 넣어주는 POSTGRES_URL을 쓴다.
// 연결이 없으면 storageAvailable()이 false이고, 화면은 브라우저 저장소로 동작한다.
const url = () => process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || process.env.DATABASE_URL || "";

export const storageAvailable = () => Boolean(url());

let client: postgres.Sql | null = null;
let migrated: Promise<void> | null = null;

function sql() {
  if (!client) client = postgres(url(), { ssl: "require", max: 3, idle_timeout: 20, prepare: false });
  return client;
}

async function ready() {
  const db = sql();
  migrated ||= (async () => {
    await db`create table if not exists adops_advertisers (
      id text primary key, name text not null, account_keys jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
    await db`create table if not exists adops_mixes (
      id text primary key, advertiser_id text not null, month text not null, status text not null default 'draft',
      target_roas integer not null default 0, channels jsonb not null default '{}'::jsonb, notes text not null default '', review text,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique (advertiser_id, month))`;
    await db`create table if not exists adops_naver_sa (
      customer_id text primary key, name text not null, sealed text not null, created_at timestamptz not null default now())`;
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
  const [row] = await db`insert into adops_mixes (id, advertiser_id, month, status, target_roas, channels, notes, review)
    values (${mix.id}, ${mix.advertiserId}, ${mix.month}, ${mix.status}, ${mix.targetRoas}, ${db.json(mix.channels as any)}, ${mix.notes}, ${mix.review || null})
    on conflict (advertiser_id, month) do update set status = excluded.status, target_roas = excluded.target_roas, channels = excluded.channels,
      notes = excluded.notes, review = excluded.review, updated_at = now()
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

import { AsyncLocalStorage } from "node:async_hooks";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// 대시보드에서 직접 등록한 네이버 SA 계정 인증정보.
// 서버 키로 암호화한 토큰만 브라우저에 저장하고, 요청마다 헤더로 받아 이 요청 안에서만 복호화해 쓴다.
// (평문 API 키·시크릿은 브라우저에 남지 않는다.)
export type NaverSaCredential = { customerId: string; name: string; apiKey: string; secret: string };

export const NAVER_SA_HEADER = "x-naver-sa-accounts";
const MAX_ACCOUNTS = 100;

function key() {
  const base = process.env.DATA_ENCRYPTION_KEY || process.env.PENDING_ACTION_SECRET || "local-development-only-secret";
  return createHash("sha256").update(`naver-sa-credentials:${base}`).digest();
}

export function sealCredential(credential: NaverSaCredential) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(credential), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
}

export function openCredential(token: string): NaverSaCredential | null {
  try {
    const [iv, tag, data] = token.split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    const value = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
    return value?.customerId && value?.apiKey && value?.secret ? value : null;
  } catch {
    return null;
  }
}

const storage = new AsyncLocalStorage<NaverSaCredential[]>();

function parseHeader(request: Request): NaverSaCredential[] {
  const raw = request.headers.get(NAVER_SA_HEADER);
  if (!raw) return [];
  try {
    const tokens = JSON.parse(raw);
    if (!Array.isArray(tokens)) return [];
    return tokens.slice(0, MAX_ACCOUNTS).map((token) => typeof token === "string" ? openCredential(token) : null).filter((item): item is NaverSaCredential => Boolean(item));
  } catch {
    return [];
  }
}

/** 요청 헤더(브라우저 저장)와 Supabase에 저장된 등록 계정을 이 요청 처리 동안 어댑터가 쓸 수 있게 한다. */
export async function withNaverSaAccounts<T>(request: Request, run: () => Promise<T>): Promise<T> {
  const list = parseHeader(request);
  try {
    const { storageAvailable, listNaverSaSealed } = await import("@/lib/db");
    if (storageAvailable()) {
      for (const row of await listNaverSaSealed()) {
        const credential = openCredential(row.sealed);
        if (credential && !list.some((item) => item.customerId === credential.customerId)) list.push(credential);
      }
    }
  } catch { /* 저장소 오류여도 헤더 계정으로 계속 */ }
  return storage.run(list, run);
}

export function registeredNaverSa(): NaverSaCredential[] {
  return storage.getStore() || [];
}

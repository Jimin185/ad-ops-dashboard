import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChangeOperation, PendingAction, PendingItem } from "@/lib/types";

const TTL_MS = 10 * 60 * 1000;

function secret() {
  return process.env.PENDING_ACTION_SECRET || "local-development-only-secret";
}

function encode(value: object) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createPendingAction(title: string, operation: ChangeOperation, items: PendingItem[]): PendingAction {
  const data = { id: crypto.randomUUID(), title, operation, items, expiresAt: Date.now() + TTL_MS };
  const payload = encode(data);
  return { ...data, token: `${payload}.${sign(payload)}` };
}

export function verifyPendingAction(token: string): Omit<PendingAction, "token"> {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new Error("유효하지 않은 승인 요청입니다.");
  const expected = sign(payload);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error("승인 요청의 서명이 올바르지 않습니다.");
  }
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (Date.now() > data.expiresAt) throw new Error("승인 요청이 만료되었습니다. 다시 요청해 주세요.");
  return data;
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Advertiser, MediaMix } from "@/lib/mix";
import { matchMix, mixTotalBudget } from "@/lib/mix";
import { ReportView } from "./report-view";
import { MixView } from "./mix-view";
import { CreativeView } from "./creative-view";
import { SaView } from "./sa-view";
import { MarketView } from "./market-view";
import { InsightsView } from "./insights-view";
import { EMPTY_FILTER, FilterBar, lineCampaignIds, passes, type Filter } from "./filter-bar";
import type { Ad, AdAccount, AdGroup, Campaign, ChangeOperation, Channel, ConnectionStatus, PendingAction } from "@/lib/types";

type Attachment = { name: string; kind: "text" | "pdf" | "image"; data: string; mediaType?: string };
type ChatMessage = { role: "user" | "assistant"; content: string; attachments?: string[]; pendingActions?: PendingAction[]; mixDrafts?: MediaMix[]; usage?: { input: number; output: number; cached: number } };
type DashTab = "report" | "mix" | "ops" | "detail";
const MIX_STORAGE = "adops-mixes";

type RegisteredNaverSa = { id: string; name: string; token: string };
const NAVER_SA_STORAGE = "adops-naver-sa";

function loadRegisteredNaverSa(): RegisteredNaverSa[] {
  try { return JSON.parse(localStorage.getItem(NAVER_SA_STORAGE) || "[]"); } catch { return []; }
}

// 대시보드에서 등록한 네이버 SA 계정(암호화 토큰)을 모든 API 요청에 함께 보낸다.
function apiFetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const tokens = loadRegisteredNaverSa().map((item) => item.token);
  if (tokens.length) headers.set("x-naver-sa-accounts", JSON.stringify(tokens));
  return fetch(url, { ...init, headers });
}

const mappingTabs: Array<{ key: "all" | Channel; label: string }> = [
  { key: "all", label: "전체" }, { key: "naver_gfa", label: "네이버 GFA" }, { key: "google_ads", label: "Google Ads" }, { key: "meta", label: "Meta" }, { key: "naver_sa", label: "네이버 SA" },
];

const won = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
const channelLabel = { naver_sa: "네이버 SA", naver_gfa: "네이버 GFA", meta: "Meta", google_ads: "Google Ads" } as const;

function MarkdownLite({ value }: { value: string }) {
  const lines = value.split("\n");
  const tableStart = lines.findIndex((line, index) => line.includes("|") && lines[index + 1]?.includes("---"));
  if (tableStart < 0) return <div className="message-text">{value}</div>;
  const before = lines.slice(0, tableStart).join("\n");
  const tableLines = lines.slice(tableStart).filter((line) => line.includes("|"));
  const rows = tableLines.filter((_, index) => index !== 1).map((line) => line.split("|").map((cell) => cell.trim()).filter(Boolean));
  return (
    <div className="message-text">
      {before && <div>{before}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr>{rows[0]?.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
          <tbody>{rows.slice(1).map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function ConfirmCard({ action, onDone }: { action: PendingAction; onDone: (message: string) => void }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "cancelled">("idle");

  async function apply() {
    setState("loading");
    const response = await apiFetch("/api/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: action.token }) });
    const data = await response.json();
    if (!response.ok) {
      setState("idle");
      onDone(data.error || "변경에 실패했습니다.");
      return;
    }
    setState("done");
    // 매체 세팅 결과(생성된 ID 등)를 대화에 남겨서 AI가 다음 작업에 이어 쓸 수 있게 한다
    const results = data.result?.results;
    const detail = Array.isArray(results) && results.length ? `\n실행 결과: ${JSON.stringify(results).slice(0, 1500)}` : "";
    onDone(`${data.message}${detail}`);
  }

  return (
    <div className="confirm-card">
      <strong>{action.title}</strong>
      {action.operation.kind === "media_plan" ? <ol className="plan-steps">{action.items.map((item) => (
        <li key={item.targetId} className={String(item.field).startsWith("DELETE") ? "danger" : ""}>
          <b>{item.targetName.replace(/^\d+\.\s*/, "")}</b>
          <code>{item.field} {String(item.before)}</code>
          {item.after ? <details><summary>요청 내용</summary><pre>{String(item.after)}</pre></details> : null}
        </li>))}</ol> : action.items.map((item) => (
        <div className="change-row" key={`${item.targetId}-${item.field}`}>
          <span>{item.targetName}</span>
          <span>{item.field}: <del>{String(item.before ?? "없음")}</del> → <b>{String(item.after)}</b></span>
        </div>
      ))}
      <div className="confirm-actions">
        <button className="secondary" disabled={state !== "idle"} onClick={() => setState("cancelled")}>{state === "cancelled" ? "취소됨" : "취소"}</button>
        <button className="primary" disabled={state !== "idle"} onClick={apply}>{state === "loading" ? "실행 중…" : state === "done" ? "실행 완료" : action.operation.kind === "media_plan" ? `${action.items.length}단계 실행` : "적용"}</button>
      </div>
    </div>
  );
}

function MixDraftCard({ mix, onApply }: { mix: MediaMix; onApply: (mix: MediaMix) => Promise<void> }) {
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">("idle");
  return (
    <div className="confirm-card">
      <strong>{mix.month} 미디어 믹스 초안 · 총 {won.format(mixTotalBudget(mix))} · 목표 ROAS {mix.targetRoas}%</strong>
      {Object.entries(mix.channels).map(([channel, plan]) => <div className="change-row" key={channel}><span>{channelLabel[channel as Channel]}</span><span>{won.format(plan?.budget || 0)} · ROAS {plan?.targetRoas || 0}%</span></div>)}
      <div className="confirm-actions">
        <button className="primary" disabled={state === "saving" || state === "done"} onClick={async () => { setState("saving"); try { await onApply(mix); setState("done"); } catch { setState("error"); } }}>{state === "done" ? "믹스에 저장됨" : state === "saving" ? "저장 중…" : state === "error" ? "다시 시도" : "믹스로 저장(초안)"}</button>
      </div>
    </div>
  );
}

const isRunning = (row: { active?: boolean; status: string }) => row.active ?? row.status === "on";

/** ON/OFF 토글: 팝업으로 한 번 확인하고 바로 적용 */
function StatusButton({ status, label, disabled, onToggle }: { status: string; label: string; disabled?: boolean; onToggle: (next: "on" | "off") => void }) {
  const next = status === "on" ? "off" : "on";
  return <button className={`status ${status}`} disabled={disabled} title={disabled ? "이 매체는 화면에서 바로 바꿀 수 없어요 (AI 어시스턴트로 요청)" : undefined}
    onClick={(e) => { e.stopPropagation(); if (window.confirm(`'${label}'을(를) ${next.toUpperCase()} 하시겠습니까?`)) onToggle(next); }}>{status.toUpperCase()}</button>;
}
/** 일예산: 입력 후 확인하면 바로 적용 */
function BudgetButton({ value, disabled, onSave }: { value: number; disabled?: boolean; onSave: (value: number) => void }) {
  return <button className="value-button" disabled={disabled} title={disabled ? "이 매체는 화면에서 예산을 바로 바꿀 수 없어요" : "일예산 변경"}
    onClick={(e) => { e.stopPropagation(); const v = Number((window.prompt("변경할 일예산(원)을 입력하세요.", String(Math.round(value))) || "").replace(/[^0-9]/g, "")); if (v > 0 && v !== Math.round(value) && window.confirm(`일예산을 ${won.format(v)}으로 바꾸시겠습니까?`)) onSave(v); }}>{won.format(value)}</button>;
}

export default function Dashboard() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [mode, setMode] = useState("mock");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [accounts, setAccounts] = useState<AdAccount[]>([]);
  const [accountErrors, setAccountErrors] = useState<Partial<Record<Channel, string>>>({});
  const [advertisers, setAdvertisers] = useState<Advertiser[]>([]);
  const [selectedAdvertiserId, setSelectedAdvertiserId] = useState("");
  const [view, setView] = useState<"select" | "mapping" | "dashboard" | "market" | "insights">("select");
  const [campaignQuery, setCampaignQuery] = useState("");
  const [opsFilter, setOpsFilter] = useState<Filter>(EMPTY_FILTER);
  const [balances, setBalances] = useState<Array<{ customerId: string; bizmoney?: number; budgetLock?: boolean; error?: string }>>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [showInactiveGroups, setShowInactiveGroups] = useState(false);
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [adgroups, setAdgroups] = useState<AdGroup[]>([]);
  const [adsByGroup, setAdsByGroup] = useState<Record<string, Ad[]>>({});
  const [detailError, setDetailError] = useState("");
  const [mappingTab, setMappingTab] = useState<"all" | Channel>("all");
  const [accountQuery, setAccountQuery] = useState("");
  const [registeredSa, setRegisteredSa] = useState<RegisteredNaverSa[]>([]);
  const [saForm, setSaForm] = useState({ name: "", customerId: "", apiKey: "", secretKey: "" });
  const [saStatus, setSaStatus] = useState<{ state: "idle" | "saving" | "error" | "done"; message: string }>({ state: "idle", message: "" });
  const [dashTab, setDashTab] = useState<DashTab>("report");
  const [detailTab, setDetailTab] = useState<"sa" | "creative">("creative");
  const [storageMode, setStorageMode] = useState<"loading" | "supabase" | "local">("loading");
  const [storageError, setStorageError] = useState("");
  const [mixes, setMixes] = useState<MediaMix[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: "안녕하세요. 성과 리포트, 월별 미디어 믹스 초안, 믹스에 맞춘 예산 조정, 소재 카피 시안까지 도와드릴게요. 예산·상태 변경은 확인 후에만 적용됩니다." },
  ]);

  const [campaignsFetchedAt, setCampaignsFetchedAt] = useState("");
  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    setLoadError("");
    const response = await apiFetch(`/api/campaigns${force ? "?refresh=1" : ""}`, { cache: "no-store" });
    const data = await response.json();
    if (data.mode) setMode(data.mode);
    if (response.ok) {
      setCampaigns(data.campaigns);
      setConnections(data.connections || []);
      setCampaignsFetchedAt(data.fetchedAt || "");
    } else {
      setCampaigns([]);
      setLoadError(data.error || "실계정 캠페인을 불러오지 못했습니다.");
    }
    setLoading(false);
  }, []);

  const loadAccounts = useCallback(async () => {
    const response = await apiFetch("/api/accounts", { cache: "no-store" });
    const data = await response.json();
    setAccounts(data.accounts || []);
    setAccountErrors(data.errors || {});
  }, []);

  useEffect(() => {
    setRegisteredSa(loadRegisteredNaverSa());
    void refresh();
    void loadAccounts();
    void (async () => {
      let local: Advertiser[] = [];
      try { local = JSON.parse(localStorage.getItem("adops-advertisers") || "[]"); } catch { local = []; }
      try {
        const status = await (await fetch("/api/storage", { cache: "no-store" })).json();
        if (!status.available) throw new Error("unavailable");
        const response = await fetch("/api/advertisers", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "광고주를 불러오지 못했습니다.");
        // Supabase가 비어 있고 이 브라우저에 기존 데이터가 있으면 한 번 옮긴다.
        if (!data.advertisers.length && local.length) {
          await fetch("/api/advertisers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ advertisers: local }) });
          let localMixes: MediaMix[] = [];
          try { localMixes = JSON.parse(localStorage.getItem(MIX_STORAGE) || "[]"); } catch { localMixes = []; }
          for (const mix of localMixes) await fetch("/api/mixes", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mix) });
          setAdvertisers(local);
        } else setAdvertisers(data.advertisers);
        setStorageMode("supabase");
      } catch (error) {
        if (error instanceof Error && error.message !== "unavailable") setStorageError(error.message);
        setAdvertisers(local);
        setStorageMode("local");
      }
      advertisersLoaded.current = true;
    })();
  }, [refresh, loadAccounts]);

  const advertisersLoaded = useRef(false);
  // 광고주·매핑 저장: Supabase가 있으면 서버에, 없으면 이 브라우저에
  useEffect(() => {
    if (!advertisersLoaded.current || storageMode === "loading") return;
    try { localStorage.setItem("adops-advertisers", JSON.stringify(advertisers)); } catch { /* 저장 불가 */ }
    if (storageMode !== "supabase") return;
    const timer = setTimeout(() => {
      void fetch("/api/advertisers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ advertisers }) })
        .then(async (r) => { if (!r.ok) setStorageError((await r.json()).error || "저장 실패"); else setStorageError(""); });
    }, 600);
    return () => clearTimeout(timer);
  }, [advertisers, storageMode]);

  // 매핑이 바뀐 광고주는 올해 1월~지난달 월별 데이터를 백그라운드로 적재한다 (이미 있는 달은 건너뜀)
  const backfilled = useRef(new Set<string>());
  useEffect(() => {
    if (storageMode !== "supabase") return;
    const keys = [...new Set(advertisers.flatMap((a) => a.accountKeys))].filter((k) => !backfilled.current.has(k));
    if (!keys.length) return;
    const timer = setTimeout(() => {
      keys.forEach((k) => backfilled.current.add(k));
      void (async () => {
        for (let i = 0; i < 20; i++) {
          const r = await apiFetch("/api/monthly", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accounts: keys }) }).catch(() => null);
          const d = await r?.json().catch(() => null);
          if (!d || d.status !== "loading") break;
        }
      })();
    }, 8000);
    return () => clearTimeout(timer);
  }, [advertisers, storageMode]);

  // 선택한 광고주의 믹스
  const loadMixes = useCallback(async (advertiserId: string) => {
    if (!advertiserId) return setMixes([]);
    if (storageMode === "supabase") {
      const response = await fetch(`/api/mixes?advertiserId=${encodeURIComponent(advertiserId)}`, { cache: "no-store" });
      const data = await response.json();
      setMixes(response.ok ? data.mixes : []);
    } else {
      let all: MediaMix[] = [];
      try { all = JSON.parse(localStorage.getItem(MIX_STORAGE) || "[]"); } catch { all = []; }
      setMixes(all.filter((mix) => mix.advertiserId === advertiserId).sort((a, b) => b.month.localeCompare(a.month)));
    }
  }, [storageMode]);
  useEffect(() => { if (storageMode !== "loading") void loadMixes(selectedAdvertiserId); }, [selectedAdvertiserId, storageMode, loadMixes]);

  async function saveMix(mix: MediaMix) {
    if (storageMode === "supabase") {
      const response = await fetch("/api/mixes", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mix) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "믹스를 저장하지 못했습니다.");
    } else {
      let all: MediaMix[] = [];
      try { all = JSON.parse(localStorage.getItem(MIX_STORAGE) || "[]"); } catch { all = []; }
      const next = [...all.filter((m) => !(m.advertiserId === mix.advertiserId && m.month === mix.month)), { ...mix, updatedAt: new Date().toISOString() }];
      localStorage.setItem(MIX_STORAGE, JSON.stringify(next));
    }
    await loadMixes(mix.advertiserId);
  }
  async function removeMix(mix: MediaMix) {
    if (storageMode === "supabase") await fetch(`/api/mixes?id=${encodeURIComponent(mix.id)}`, { method: "DELETE" });
    else {
      let all: MediaMix[] = [];
      try { all = JSON.parse(localStorage.getItem(MIX_STORAGE) || "[]"); } catch { all = []; }
      localStorage.setItem(MIX_STORAGE, JSON.stringify(all.filter((m) => m.id !== mix.id)));
    }
    await loadMixes(mix.advertiserId);
  }

  const selectedAdvertiser = advertisers.find((item) => item.id === selectedAdvertiserId);
  const advertiserCampaigns = useMemo(() => selectedAdvertiser ? campaigns.filter((c) => selectedAdvertiser.accountKeys.includes(`${c.channel}:${c.accountId}`)) : [], [campaigns, selectedAdvertiser]);
  // 이번 달 믹스 라인별 실적 (AI 어시스턴트에 요약만 넘겨 토큰을 아낀다)
  const currentMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
  const mixLineSummary = useMemo(() => {
    const mix = mixes.find((m) => m.month === currentMonth);
    if (!mix?.lines?.length) return undefined;
    const { results, unassigned } = matchMix(mix.lines, advertiserCampaigns.filter((c) => (c.active ?? c.status === "on") || c.spend > 0));
    return {
      month: mix.month,
      lines: results.map((r) => ({ line: r.line.name, channel: r.line.channel, budget: r.line.budget, targetRoas: r.line.targetRoas, spend: Math.round(r.spend), roas: Math.round(r.roas), campaigns: r.campaigns.map((c) => c.id) })),
      unassigned: { count: unassigned.length, spend: Math.round(unassigned.reduce((s, c) => s + c.spend, 0)) },
    };
  }, [mixes, advertiserCampaigns, currentMonth]);

  const currentMixLines = mixes.find((m) => m.month === currentMonth)?.lines;
  const campaignsById = useMemo(() => new Map(advertiserCampaigns.map((c) => [c.id, c])), [advertiserCampaigns]);
  const lineSets = useMemo(() => lineCampaignIds(currentMixLines, advertiserCampaigns), [currentMixLines, advertiserCampaigns]);
  const scopedCampaigns = advertiserCampaigns.filter((campaign) => passes(opsFilter, { ...campaign, campaignId: campaign.id }, campaignsById, lineSets));

  // 네이버 SA 비즈머니 잔액
  const saIds = (selectedAdvertiser?.accountKeys || []).filter((k) => k.startsWith("naver_sa:")).map((k) => k.slice(9));
  useEffect(() => {
    if (view !== "dashboard" || !saIds.length) return; // 대시보드 모든 탭 상단 알림
    void apiFetch(`/api/bizmoney?ids=${saIds.join(",")}`).then((r) => r.json()).then((d) => setBalances(d.balances || []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedAdvertiserId, saIds.join(",")]);
  const hasGfa = (selectedAdvertiser?.accountKeys || []).some((k) => k.startsWith("naver_gfa:"));
  const hasSa = saIds.length > 0;
  const saDaily = (id: string) => advertiserCampaigns.filter((c) => c.channel === "naver_sa" && c.accountId === id).reduce((s, c) => s + c.spend, 0) / Math.max(1, Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", day: "2-digit" }).format(new Date())));

  /** 다른 화면에서 캠페인을 누르면 매체별 데이터의 그 캠페인 상세로 이동 */
  function goToCampaign(campaignId: string) {
    const campaign = advertiserCampaigns.find((c) => c.id === campaignId) || campaigns.find((c) => c.id === campaignId);
    if (!campaign) return window.alert("이 캠페인은 현재 캠페인 목록에 없어요 (삭제됐거나 이번 달 데이터가 없는 캠페인).");
    setDashTab("ops");
    setOpsFilter({ channel: campaign.channel, account: `${campaign.channel}:${campaign.accountId}`, product: "", line: "" });
    setCampaignQuery(campaign.name);
    if (!isRunning(campaign)) setShowInactive(true);
    void openCampaign(campaign);
    setTimeout(() => document.getElementById(`row-${campaign.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 400);
  }

  // 돌아가는 캠페인만 기본 표시. 검색하면 꺼진/종료된 것도 함께 보여준다.
  const query = campaignQuery.trim().toLowerCase();
  const runningCount = scopedCampaigns.filter(isRunning).length;
  const hiddenCount = scopedCampaigns.length - runningCount;
  const visibleCampaigns = scopedCampaigns
    .filter((campaign) => query ? `${campaign.name} ${campaign.accountName || ""}`.toLowerCase().includes(query) : showInactive || isRunning(campaign))
    .sort((a, b) => Number(isRunning(b)) - Number(isRunning(a)) || b.spend - a.spend);

  // 매핑되지 않아 표에서 빠진 캠페인 수 (빈 화면일 때 원인 안내용)
  const unmappedCount = advertiserCampaigns.length ? 0 : campaigns.length;

  const totals = useMemo(() => ({
    spend: scopedCampaigns.reduce((sum, row) => sum + row.spend, 0),
    conversions: scopedCampaigns.reduce((sum, row) => sum + row.conversions, 0),
    active: scopedCampaigns.filter(isRunning).length,
  }), [scopedCampaigns]);

  // 계정 → 이미 매핑된 광고주 이름
  const ownerByAccount = useMemo(() => {
    const map = new Map<string, Advertiser>();
    for (const advertiser of advertisers) for (const key of advertiser.accountKeys) if (!map.has(key)) map.set(key, advertiser);
    return map;
  }, [advertisers]);

  const visibleAccounts = useMemo(() => {
    const query = accountQuery.trim().toLowerCase();
    return accounts.filter((account) => (mappingTab === "all" || account.channel === mappingTab)
      && (!query || account.name.toLowerCase().includes(query) || account.id.includes(query)));
  }, [accounts, mappingTab, accountQuery]);

  // 매핑돼 있지만 더 이상 계정 목록에 없는 계정 (예: 예전 버전에서 매니저 계정 번호를 매핑한 경우)
  const staleKeys = useMemo(() => {
    if (!selectedAdvertiser || !accounts.length) return [];
    const known = new Set(accounts.map((account) => `${account.channel}:${account.id}`));
    return selectedAdvertiser.accountKeys.filter((key) => !known.has(key));
  }, [selectedAdvertiser, accounts]);

  function unmapKey(advertiserId: string, key: string) {
    setAdvertisers((current) => current.map((advertiser) => advertiser.id !== advertiserId ? advertiser : { ...advertiser, accountKeys: advertiser.accountKeys.filter((item) => item !== key) }));
  }

  function saveRegisteredSa(next: RegisteredNaverSa[]) {
    setRegisteredSa(next);
    try { localStorage.setItem(NAVER_SA_STORAGE, JSON.stringify(next)); } catch { /* 저장 불가 환경 */ }
  }

  async function registerNaverSa() {
    setSaStatus({ state: "saving", message: "네이버 API로 키를 확인하는 중…" });
    const response = await fetch("/api/naver-sa/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(saForm) });
    const data = await response.json();
    if (!response.ok) return setSaStatus({ state: "error", message: data.error || "등록에 실패했습니다." });
    saveRegisteredSa([...loadRegisteredNaverSa().filter((item) => item.id !== data.account.id), { id: data.account.id, name: data.account.name, token: data.token }]);
    setSaForm({ name: "", customerId: "", apiKey: "", secretKey: "" });
    setSaStatus({ state: "done", message: `${data.account.name} 등록 완료 · 캠페인 ${data.campaignCount}개 확인` });
    await Promise.all([loadAccounts(), refresh(true)]);
  }

  async function removeNaverSa(id: string) {
    if (!window.confirm("이 네이버 SA 계정 등록을 삭제할까요? 매핑도 함께 해제됩니다.")) return;
    saveRegisteredSa(loadRegisteredNaverSa().filter((item) => item.id !== id));
    setAdvertisers((current) => current.map((advertiser) => ({ ...advertiser, accountKeys: advertiser.accountKeys.filter((key) => key !== `naver_sa:${id}`) })));
    await Promise.all([loadAccounts(), refresh(true)]);
  }

  function createAdvertiser() {
    const name = window.prompt("광고주 이름을 입력하세요.")?.trim();
    if (!name) return;
    const advertiser = { id: crypto.randomUUID(), name, accountKeys: [] };
    setAdvertisers((current) => [...current, advertiser]);
    setSelectedAdvertiserId(advertiser.id);
    setView("mapping");
  }

  function toggleAccount(advertiserId: string, account: AdAccount) {
    const key = `${account.channel}:${account.id}`;
    setAdvertisers((current) => current.map((advertiser) => advertiser.id !== advertiserId ? advertiser : {
      ...advertiser,
      accountKeys: advertiser.accountKeys.includes(key) ? advertiser.accountKeys.filter((item) => item !== key) : [...advertiser.accountKeys, key],
    }));
  }

  async function openCampaign(campaign: Campaign) {
    setSelectedCampaign(campaign); setAdgroups([]); setAdsByGroup({}); setDetailError("");
    const response = await apiFetch(`/api/entities?channel=${campaign.channel}&campaignId=${encodeURIComponent(campaign.id)}`);
    const data = await response.json();
    if (!response.ok) setDetailError(data.error || "광고그룹을 불러오지 못했습니다.");
    else setAdgroups(data.adgroups || []);
  }

  async function loadAds(group: AdGroup) {
    const response = await apiFetch(`/api/entities?channel=${group.channel}&adgroupId=${encodeURIComponent(group.id)}`);
    const data = await response.json();
    if (!response.ok) setDetailError(data.error || "소재를 불러오지 못했습니다.");
    else setAdsByGroup((current) => ({ ...current, [group.id]: data.ads || [] }));
  }

  async function planManual(operation: ChangeOperation) {
    const response = await apiFetch("/api/manual/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(operation) });
    const data = await response.json();
    if (!response.ok) return window.alert(data.error);
    setMessages((current) => [...current, { role: "assistant", content: "아래 변경 내용을 확인해 주세요.", pendingActions: [data.pendingAction] }]);
    setChatOpen(true);
  }

  // ---- 화면에서 직접 하는 ON/OFF·예산 변경 (AI 거치지 않음) ----
  type Selected = { id: string; channel: Channel; entityType: "campaign" | "adgroup" | "ad"; name: string };
  const [selection, setSelection] = useState<Map<string, Selected>>(new Map());
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState("");
  function toggleMany(items: Selected[], checked: boolean) {
    setSelection((cur) => { const next = new Map(cur); for (const item of items) checked ? next.set(item.id, item) : next.delete(item.id); return next; });
  }
  async function applyOps(ops: ChangeOperation[]) {
    setApplying(true);
    try {
      const response = await apiFetch("/api/manual/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operations: ops }) });
      const data = await response.json();
      if (!response.ok) { window.alert(data.error || "적용하지 못했습니다."); return; }
      const ok = new Set((data.results as Array<{ id: string; ok: boolean }>).filter((r) => r.ok).map((r) => r.id));
      // 성공한 것만 화면에 즉시 반영
      const patch = <T extends { id: string; status: string; dailyBudget?: number; active?: boolean }>(row: T): T => {
        const op = ops.find((o) => (o as any).id === row.id);
        if (!op || !ok.has(row.id)) return row;
        if (op.kind === "set_status") return { ...row, status: op.status, active: op.status === "on" ? row.active ?? true : false };
        if (op.kind === "update_budget") return { ...row, dailyBudget: op.dailyBudget };
        return row;
      };
      setCampaigns((cur) => cur.map(patch));
      setAdgroups((cur) => cur.map(patch));
      setAdsByGroup((cur) => Object.fromEntries(Object.entries(cur).map(([k, list]) => [k, list.map(patch)])));
      const failed = (data.results as Array<{ id: string; ok: boolean; error?: string }>).filter((r) => !r.ok);
      setNotice(failed.length ? `${data.applied}건 적용, ${failed.length}건 실패: ${failed[0].error}` : `${data.applied}건 적용했어요.`);
      if (failed.length) window.alert(`${failed.length}건 실패\n${failed.slice(0, 5).map((f) => f.error).join("\n")}`);
      setTimeout(() => setNotice(""), 4000);
    } finally { setApplying(false); }
  }
  async function bulkStatus(status: "on" | "off") {
    const items = [...selection.values()];
    if (!window.confirm(`선택한 ${items.length}개를 ${status.toUpperCase()} 하시겠습니까?`)) return;
    await applyOps(items.map((i) => ({ kind: "set_status", channel: i.channel, entityType: i.entityType, id: i.id, status })));
    setSelection(new Map());
  }
  async function bulkBudget() {
    const items = [...selection.values()].filter((i) => i.entityType !== "ad");
    if (!items.length) return window.alert("소재에는 예산이 없어요. 캠페인이나 광고그룹을 선택해 주세요.");
    const value = Number((window.prompt(`선택한 ${items.length}개의 일예산을 얼마로 바꿀까요? (원)`) || "").replace(/[^0-9]/g, ""));
    if (!value) return;
    if (!window.confirm(`${items.length}개의 일예산을 ${won.format(value)}으로 바꾸시겠습니까?`)) return;
    await applyOps(items.map((i) => ({ kind: "update_budget", channel: i.channel, entityType: i.entityType as "campaign" | "adgroup", id: i.id, dailyBudget: value })));
    setSelection(new Map());
  }

  // ---- 채팅 첨부 파일 (엑셀·CSV는 브라우저에서 표로 변환, PDF·이미지는 Claude가 직접 읽음) ----
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  async function addFiles(files: FileList | null) {
    for (const file of Array.from(files || []).slice(0, 5)) {
      try {
        const lower = file.name.toLowerCase();
        if (file.size > 3 * 1024 * 1024) { window.alert(`${file.name}: 3MB 이하 파일만 첨부할 수 있어요.`); continue; }
        if (/\.(xlsx|xlsm|xls)$/.test(lower)) {
          const XLSX = await import("xlsx");
          const book = XLSX.read(await file.arrayBuffer(), { type: "array" });
          const text = book.SheetNames.map((name) => `## 시트: ${name}\n${XLSX.utils.sheet_to_csv(book.Sheets[name], { blankrows: false })}`).join("\n\n");
          setAttachments((cur) => [...cur, { name: file.name, kind: "text", data: text.slice(0, 60_000) }]);
        } else if (/\.(csv|tsv|txt|md|json)$/.test(lower)) {
          setAttachments((cur) => [...cur, { name: file.name, kind: "text", data: "" }]);
          const text = await file.text();
          setAttachments((cur) => cur.map((a) => a.name === file.name ? { ...a, data: text.slice(0, 60_000) } : a));
        } else if (/\.pdf$/.test(lower) || /^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
          const base64 = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] || ""); r.onerror = reject; r.readAsDataURL(file); });
          setAttachments((cur) => [...cur, { name: file.name, kind: lower.endsWith(".pdf") ? "pdf" : "image", data: base64, mediaType: lower.endsWith(".pdf") ? "application/pdf" : file.type }]);
        } else window.alert(`${file.name}: 엑셀, CSV, TXT, PDF, 이미지 파일만 첨부할 수 있어요.`);
      } catch { window.alert(`${file.name}을(를) 읽지 못했어요.`); }
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  const abortRef = useRef<AbortController | null>(null);
  function stopMessage() {
    abortRef.current?.abort();
  }

  async function sendMessage(preset?: string) {
    const typed = (preset ?? input).trim();
    const files = preset ? [] : attachments;
    if ((!typed && !files.length) || sending) return;
    const text = typed || "첨부한 파일을 확인해줘.";
    const next = [...messages, { role: "user" as const, content: text, attachments: files.map((f) => f.name) }];
    setAttachments([]);
    setMessages(next);
    setInput("");
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const history = next.map(({ role, content }) => ({ role, content }));
      const context = { advertiserId: selectedAdvertiser?.id, advertiserName: selectedAdvertiser?.name, accountKeys: selectedAdvertiser?.accountKeys || [], mixes, mixLineSummary };
      // 긴 작업(세팅 등)은 서버가 60초 안에서 끊어 돌려주므로, 끝날 때까지 이어서 요청한다.
      let continuation: unknown = undefined;
      let data: any = null;
      let ok = false;
      for (let round = 0; round < 10; round += 1) {
        if (round > 0) setProgress(`작업이 길어 이어서 진행 중… (${round + 1}단계)`);
        const response = await apiFetch("/api/assistant", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(continuation ? { continuation, context } : { messages: history, attachments: files, context }) });
        const raw = await response.text();
        try { data = JSON.parse(raw); } catch { data = { error: response.status === 504 || /timeout/i.test(raw) ? "응답 시간이 초과됐어요. 요청을 조금 나눠서 다시 시도해 주세요." : `서버 오류(${response.status})가 발생했어요. 잠시 후 다시 시도해 주세요.` }; }
        ok = response.ok && !data.error;
        if (!ok || !data.continue) break;
        continuation = data.continue;
      }
      if (ok && data?.continue) data = { message: "작업 단계가 너무 많아 중간에 멈췄어요. 이어서 하려면 \"계속해\"라고 보내 주세요.", pendingActions: data.continue.pendingActions, mixDrafts: data.continue.mixDrafts, usage: data.usage };
      setMessages((current) => [...current, { role: "assistant", content: ok ? data.message : data.error, pendingActions: data.pendingActions, mixDrafts: data.mixDrafts, usage: data.usage }]);
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      setMessages((current) => [...current, { role: "assistant", content: aborted ? "응답을 중지했어요." : "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." }]);
    } finally {
      abortRef.current = null;
      setProgress("");
      setSending(false);
    }
  }

  const chatUi = (<>
      <button className="chat-fab" onClick={() => setChatOpen((open) => !open)} aria-label="AI 어시스턴트 열기">✦</button>
      {chatOpen && <aside className="chat-panel">
        <div className="chat-head"><div><b>AI 광고 운영 어시스턴트</b><small>변경은 승인 후 적용됩니다</small></div><button onClick={() => setChatOpen(false)}>×</button></div>
        <div className="messages">
          {messages.map((message, index) => <div className={`message ${message.role}`} key={index}>
            <MarkdownLite value={message.content} />
            {message.attachments?.length ? <small className="attach-note">📎 {message.attachments.join(", ")}</small> : null}
            {message.usage && <small className="usage-note">토큰 입력 {message.usage.input.toLocaleString()}{message.usage.cached ? ` (캐시 ${message.usage.cached.toLocaleString()})` : ""} · 출력 {message.usage.output.toLocaleString()}</small>}
            {message.mixDrafts?.map((mix) => <MixDraftCard key={mix.id + mix.month} mix={mix} onApply={saveMix} />)}
            {message.pendingActions?.map((action) => <ConfirmCard key={action.id} action={action} onDone={(notice) => { setMessages((current) => [...current, { role: "assistant", content: notice }]); void refresh(true); }} />)}
          </div>)}
          {sending && <div className="message assistant"><span className="typing">● ● ●</span>{progress && <small> {progress}</small>} <button className="link-button" onClick={stopMessage}>중지</button></div>}
        </div>
        <div className="suggestions"><button onClick={() => setInput("이번 달 채널별 성과를 믹스 목표와 비교해줘")}>믹스 대비 성과</button><button onClick={() => setInput("다음 달 미디어 믹스 초안 만들어줘")}>다음 달 믹스</button><button onClick={() => setInput("이번 달 믹스대로 남은 기간 일예산 조정안 만들어줘")}>믹스대로 예산 조정</button><button onClick={() => setInput("성과 좋은 소재 기준으로 Meta 카피 시안 3개 써줘")}>카피 시안</button></div>
        {attachments.length > 0 && <div className="attach-chips">{attachments.map((a) => <span key={a.name}>📎 {a.name}<button aria-label={`${a.name} 빼기`} onClick={() => setAttachments((cur) => cur.filter((x) => x.name !== a.name))}>×</button></span>)}</div>}
        <input ref={fileRef} type="file" hidden multiple accept=".xlsx,.xlsm,.xls,.csv,.tsv,.txt,.md,.json,.pdf,image/png,image/jpeg,image/webp" onChange={(e) => void addFiles(e.target.files)} />
        <div className="composer"><button className="attach-button" title="파일 첨부 (엑셀·CSV·PDF·이미지)" onClick={() => fileRef.current?.click()}>📎</button><textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }} placeholder="예: 브랜드 캠페인 일예산 5만원으로 올려줘" />{sending ? <button className="stop-button" onClick={stopMessage}>■ 중지</button> : <button disabled={!input.trim() && !attachments.length} onClick={() => void sendMessage()}>전송</button>}</div>
      </aside>}
  </>);

  if (view === "market") return (
    <main>
      <header><div><span className="eyebrow">CREATIP · MARKET INSIGHT</span><h1>시장 인사이트</h1><p>키워드 검색량·트렌드와 뉴스·블로그·카페 반응으로 시장 상황을 확인합니다.</p></div><button className="secondary" onClick={() => setView("select")}>광고주 선택으로</button></header>
      <MarketView onAsk={(prompt) => { setChatOpen(true); void sendMessage(prompt); }} />
      {chatUi}
    </main>
  );

  if (view === "insights") return (
    <main>
      <header><div><span className="eyebrow">CREATIP · AD INSIGHT</span><h1>광고인사이트</h1><p>광고주 전체의 월별 성과를 광고상품별로 비교하고, 팀이 발견한 인사이트를 공유합니다.</p></div><button className="secondary" onClick={() => setView("select")}>광고주 선택으로</button></header>
      <InsightsView advertisers={advertisers} accounts={accounts} apiFetch={apiFetch} onAsk={(prompt) => { setChatOpen(true); void sendMessage(prompt); }} />
      {chatUi}
    </main>
  );

  if (view === "select") return (
    <main>
      <header><div><span className="eyebrow">CREATIP · AD OPERATIONS</span><h1>광고주 선택</h1><p>운영할 광고주를 선택하면 연결된 매체 계정을 한 번에 불러옵니다.</p></div><div className="header-actions"><button className="secondary" onClick={() => setView("market")}>🔎 시장 인사이트</button><button className="secondary" onClick={() => setView("insights")}>📊 광고인사이트</button><button className="secondary" onClick={() => setView("mapping")}>광고계정 매핑</button></div></header>
      <section className="advertiser-picker">
        <div className="advertiser-grid">{advertisers.map((advertiser) => <button key={advertiser.id} onClick={() => { setSelectedAdvertiserId(advertiser.id); setView("dashboard"); }}><b>{advertiser.name}</b><span>{advertiser.accountKeys.length}개 광고계정</span></button>)}</div>
        {!advertisers.length && <div className="empty-state"><b>등록된 광고주가 없습니다.</b><span>먼저 광고주를 만들고 광고계정을 매핑해 주세요.</span></div>}
        <button className="primary" onClick={createAdvertiser}>+ 광고주 만들기</button>
      </section>
      {chatUi}
    </main>
  );

  if (view === "mapping") return (
    <main>
      <header><div><span className="eyebrow">ADMIN · ACCOUNT MAPPING</span><h1>광고계정 매핑</h1><p>매체별 관리자 계정에서 발견된 광고계정을 광고주에 연결합니다. 다른 광고주에 연결된 계정은 선택할 수 없습니다.</p></div><button className="secondary" onClick={() => setView("select")}>광고주 선택으로</button></header>
      <section className="mapping-panel">
        <div className="mapping-toolbar"><select value={selectedAdvertiserId} onChange={(event) => setSelectedAdvertiserId(event.target.value)}><option value="">광고주 선택</option>{advertisers.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.accountKeys.length})</option>)}</select><button className="secondary" onClick={createAdvertiser}>+ 광고주</button></div>

        <nav className="channel-tabs">{mappingTabs.map((tab) => {
          const count = tab.key === "all" ? accounts.length : accounts.filter((account) => account.channel === tab.key).length;
          return <button key={tab.key} className={mappingTab === tab.key ? "active" : ""} onClick={() => setMappingTab(tab.key)}>{tab.label} <span className="tab-count">{count}</span></button>;
        })}</nav>

        {mappingTab === "naver_sa" && <div className="sa-register">
          <div><b>네이버 SA 계정 직접 등록</b><span>검색광고 › 도구 › API 사용 관리에서 CUSTOMER_ID, 액세스 라이선스, 비밀키를 복사해 넣어주세요. 키는 네이버 API로 확인한 뒤 서버 키로 암호화해 이 브라우저에 저장됩니다.</span></div>
          <div className="sa-form">
            <input placeholder="계정 이름 (예: 데스커 SA)" value={saForm.name} onChange={(event) => setSaForm({ ...saForm, name: event.target.value })} />
            <input placeholder="CUSTOMER_ID" inputMode="numeric" value={saForm.customerId} onChange={(event) => setSaForm({ ...saForm, customerId: event.target.value })} />
            <input placeholder="액세스 라이선스 (API Key)" value={saForm.apiKey} onChange={(event) => setSaForm({ ...saForm, apiKey: event.target.value })} autoComplete="off" />
            <input placeholder="비밀키 (Secret Key)" type="password" value={saForm.secretKey} onChange={(event) => setSaForm({ ...saForm, secretKey: event.target.value })} autoComplete="new-password" />
            <button className="primary" disabled={saStatus.state === "saving" || !saForm.customerId || !saForm.apiKey || !saForm.secretKey} onClick={() => void registerNaverSa()}>{saStatus.state === "saving" ? "확인 중…" : "등록"}</button>
          </div>
          {saStatus.message && <small className={`sa-status ${saStatus.state}`}>{saStatus.message}</small>}
          {!!registeredSa.length && <div className="sa-registered">{registeredSa.map((item) => <span key={item.id}>{item.name} <small>{item.id}</small><button aria-label={`${item.name} 삭제`} onClick={() => void removeNaverSa(item.id)}>×</button></span>)}</div>}
        </div>}

        <input className="account-search" type="search" placeholder="계정 이름 또는 ID로 검색" value={accountQuery} onChange={(event) => setAccountQuery(event.target.value)} />

        {selectedAdvertiser && staleKeys.length > 0 && <div className="stale-box">
          <b>목록에 없는 계정이 {selectedAdvertiser.name}에 매핑돼 있어요</b>
          <span>매니저(대행사) 계정 번호이거나 접근 권한이 없어진 계정이라 조회되지 않습니다. 해제한 뒤 실제 광고계정을 다시 체크해 주세요.</span>
          <div>{staleKeys.map((key) => { const [channel, id] = key.split(":"); return <span className="stale-chip" key={key}><span className={`channel ${channel}`}>{channelLabel[channel as Channel] || channel}</span>{id}<button onClick={() => unmapKey(selectedAdvertiser.id, key)}>매핑 해제</button></span>; })}</div>
        </div>}

        <div className="account-list">{visibleAccounts.map((account) => {
          const key = `${account.channel}:${account.id}`;
          const owner = ownerByAccount.get(key);
          const mappedElsewhere = Boolean(owner && owner.id !== selectedAdvertiser?.id);
          const checked = Boolean(selectedAdvertiser?.accountKeys.includes(key));
          return <label key={key} className={mappedElsewhere ? "taken" : ""}>
            <input type="checkbox" disabled={!selectedAdvertiser || mappedElsewhere} checked={checked} onChange={() => selectedAdvertiser && toggleAccount(selectedAdvertiser.id, account)} />
            <span className={`channel ${account.channel}`}>{channelLabel[account.channel]}</span>
            <b>{account.name}{mappedElsewhere && <em className="owner-tag">{owner!.name}에 매핑됨</em>}</b>
            <small>{account.id}</small>
          </label>;
        })}</div>
        {!visibleAccounts.length && <div className="empty-state"><b>{accountQuery ? "검색 결과가 없습니다." : mappingTab === "naver_sa" ? "등록된 네이버 SA 계정이 없습니다." : "발견된 광고계정이 없습니다."}</b><span>{accountQuery ? "다른 이름이나 ID로 검색해 보세요." : mappingTab === "naver_sa" ? "위에서 계정을 등록해 주세요." : "연결 상태의 오류와 환경변수를 확인해 주세요."}</span></div>}
        {Object.entries(accountErrors).filter(([channel]) => mappingTab === "all" || mappingTab === channel).map(([channel, message]) => <div className="connection-error" key={channel}><b>{channelLabel[channel as Channel]} 계정 조회 오류</b><span>{message}</span></div>)}
        {selectedAdvertiser && <button className="primary" onClick={() => setView("dashboard")}>{selectedAdvertiser.name} 대시보드 열기</button>}
      </section>
    </main>
  );

  return (
    <main>
      <header>
        <div><span className="eyebrow">CREATIP · AD OPERATIONS</span><h1>{selectedAdvertiser?.name || "광고 운영"} 대시보드</h1><p>수동 조작과 자연어 운영을 한 화면에서 관리합니다.</p></div>
        <div className="header-actions"><button className="secondary" onClick={() => setView("select")}>광고주 변경</button><button className="secondary" onClick={() => setView("mapping")}>계정 매핑</button><div className={`mode ${mode === "mock" ? "demo" : "live"}`}><span />{mode === "mock" ? "DEMO DATA" : "LIVE API"}</div></div>
      </header>

      <nav className="view-tabs" aria-label="화면 전환">
        {([["report", "대시보드"], ["ops", "매체별 데이터"], ["detail", "세부 성과분석"]] as Array<[DashTab, string]>).map(([key, label]) => <button key={key} className={dashTab === key || (key === "report" && dashTab === "mix") ? "active" : ""} onClick={() => setDashTab(key)}>{label}</button>)}
        <span className={`storage-badge ${storageMode}`} title={storageError || undefined}>{storageMode === "supabase" ? "Supabase 저장" : storageMode === "local" ? "이 브라우저에만 저장" : "…"}</span>
      </nav>
      {storageError && <div className="connection-error"><b>저장소 오류</b><span>{storageError}</span></div>}
      {saIds.length > 0 && <div className="balance-alert">
        {saIds.map((id) => { const b = balances.find((x) => x.customerId === id); const daily = saDaily(id); const days = b?.bizmoney !== undefined && daily ? Math.floor(b.bizmoney / daily) : undefined;
          return <span key={id} className={days !== undefined && days < 7 ? "low" : ""}>네이버 SA 비즈머니{saIds.length > 1 ? ` (${accounts.find((a) => a.channel === "naver_sa" && a.id === id)?.name || id})` : ""} <b>{b?.error ? "조회 실패" : b?.bizmoney !== undefined ? won.format(b.bizmoney) : "…"}</b>{days !== undefined ? ` · 약 ${days}일분` : ""}{days !== undefined && days < 7 ? " · 충전 필요" : ""}</span>; })}
        {hasGfa && <span className="muted">GFA 잔액은 API 미제공</span>}
      </div>}
      {notice && <div className="toast">{notice}</div>}
      {staleKeys.length > 0 && <div className="stale-box"><b>조회되지 않는 계정이 매핑돼 있어요: {staleKeys.join(", ")}</b><span>매니저 계정 번호이거나 접근 권한이 없어진 계정입니다. <button className="link-button" onClick={() => setView("mapping")}>계정 매핑에서 정리하기</button></span></div>}

      {dashTab === "report" && <ReportView onOpenCampaign={goToCampaign} accountKeys={selectedAdvertiser?.accountKeys || []} campaigns={campaigns} mixes={mixes} onOpenMix={() => setDashTab("mix")} apiFetch={apiFetch} />}
      {dashTab === "mix" && selectedAdvertiser && <MixView onOpenCampaign={goToCampaign} campaigns={advertiserCampaigns} advertiserId={selectedAdvertiser.id} advertiserName={selectedAdvertiser.name} accountKeys={selectedAdvertiser.accountKeys} mixes={mixes} onSave={saveMix} onDelete={removeMix} onAskAi={(prompt) => { setChatOpen(true); void sendMessage(prompt); }} apiFetch={apiFetch} />}
      {dashTab === "mix" && <button className="link-button back-link" onClick={() => setDashTab("report")}>← 대시보드로</button>}
      {dashTab === "detail" && <nav className="segmented" aria-label="세부 성과분석">
        {hasSa && <button className={detailTab === "sa" ? "active" : ""} onClick={() => setDetailTab("sa")}>SA 분석</button>}
        <button className={detailTab === "creative" || !hasSa ? "active" : ""} onClick={() => setDetailTab("creative")}>DA 소재성과</button>
      </nav>}
      {dashTab === "detail" && detailTab === "sa" && hasSa && <SaView onOpenCampaign={goToCampaign} apiFetch={apiFetch} accountIds={(selectedAdvertiser?.accountKeys || []).filter((k) => k.startsWith("naver_sa:")).map((k) => { const id = k.slice("naver_sa:".length); return { id, name: accounts.find((a) => a.channel === "naver_sa" && a.id === id)?.name || `네이버 SA ${id}` }; })} />}
      {dashTab === "detail" && (detailTab === "creative" || !hasSa) && <CreativeView onOpenCampaign={goToCampaign} accountKeys={selectedAdvertiser?.accountKeys || []} apiFetch={apiFetch} accounts={accounts} campaigns={advertiserCampaigns} lines={currentMixLines} />}
      {dashTab === "ops" && <>
        <section className="metrics">
          <article><span>이번 달 광고비</span><strong>{won.format(totals.spend)}</strong><small>연결 채널 통합</small></article>
          <article><span>전환</span><strong>{totals.conversions.toLocaleString()}건</strong><small>이번 달 누적</small></article>
          <article><span>활성 캠페인</span><strong>{totals.active}개</strong><small>전체 {advertiserCampaigns.length}개</small></article>
        </section>
        {connections.filter((c) => c.status === "error").map((c) => <div key={c.channel} className="connection-error"><b>{channelLabel[c.channel]} 연결 오류</b><span>{c.message}</span></div>)}

        <FilterBar value={opsFilter} onChange={setOpsFilter} accountKeys={selectedAdvertiser?.accountKeys || []} accounts={accounts} campaigns={advertiserCampaigns} lines={currentMixLines} />

        <section className="panel">
          <div className="panel-head"><div><h2>캠페인</h2><p>운영 중인 캠페인 {runningCount.toLocaleString()}개{hiddenCount ? ` · 꺼짐/종료 ${hiddenCount.toLocaleString()}개 숨김` : ""}. 캠페인을 누르면 바로 아래에 광고그룹이 열려요.</p></div><span className="fetched-at">{campaignsFetchedAt ? `${new Date(campaignsFetchedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 기준` : ""}</span><button className="secondary" onClick={() => void refresh(true)}>새로고침</button></div>
          <div className="campaign-filter">
            <input className="account-search" type="search" placeholder="캠페인·계정 이름으로 검색 (꺼진/종료 캠페인 포함)" value={campaignQuery} onChange={(e) => setCampaignQuery(e.target.value)} />
            <label className="toggle"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> 꺼짐/종료 포함</label>
          </div>
          {selection.size > 0 && <div className="bulk-bar">
            <b>{selection.size}개 선택</b>
            <button className="secondary" disabled={applying} onClick={() => void bulkStatus("on")}>ON</button>
            <button className="secondary" disabled={applying} onClick={() => void bulkStatus("off")}>OFF</button>
            <button className="secondary" disabled={applying} onClick={() => void bulkBudget()}>일예산 변경</button>
            <button className="link-button" onClick={() => setSelection(new Map())}>선택 해제</button>
            {applying && <span className="viz-sub">적용 중…</span>}
          </div>}
          {loadError && <div className="connection-error"><b>실계정 연결 오류</b><span>{loadError}</span><small>Vercel 환경변수의 계정 ID, 토큰 및 권한을 확인해 주세요.</small></div>}
          <div className="table-wrap">
            <table className="campaign-table ops-table">
              <thead><tr><th className="check-col"><input type="checkbox" aria-label="전체 선택" checked={visibleCampaigns.length > 0 && visibleCampaigns.every((c) => selection.has(c.id))} onChange={(e) => toggleMany(visibleCampaigns.map((c) => ({ id: c.id, channel: c.channel, entityType: "campaign" as const, name: c.name })), e.target.checked)} /></th><th>채널</th><th>캠페인</th><th>일예산</th><th>광고비</th><th>ROAS</th><th>상태</th></tr></thead>
              <tbody>
                {loading ? <tr><td colSpan={7}>불러오는 중…</td></tr> : !loadError && visibleCampaigns.length === 0 ? <tr><td colSpan={7}>{scopedCampaigns.length ? (query ? "검색 결과가 없습니다." : `운영 중인 캠페인이 없습니다. 꺼짐/종료 ${hiddenCount}개는 '꺼짐/종료 포함'을 켜면 보여요.`) : advertiserCampaigns.length ? "선택한 필터에 맞는 캠페인이 없습니다." : unmappedCount > 0
                  ? <>캠페인 {unmappedCount.toLocaleString()}개가 있지만 이 광고주에 매핑된 계정이 없습니다. <button className="secondary" onClick={() => setView("mapping")}>계정 매핑하기</button></>
                  : "이 광고주에 매핑된 캠페인이 없습니다."}</td></tr> : visibleCampaigns.map((campaign) => [
                  <tr key={campaign.id} id={`row-${campaign.id}`} className={`${isRunning(campaign) ? "" : "inactive-row"} ${selectedCampaign?.id === campaign.id ? "open-row" : ""}`} onClick={() => selectedCampaign?.id === campaign.id ? setSelectedCampaign(null) : void openCampaign(campaign)}>
                    <td className="check-col" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selection.has(campaign.id)} onChange={(e) => toggleMany([{ id: campaign.id, channel: campaign.channel, entityType: "campaign", name: campaign.name }], e.target.checked)} /></td>
                    <td><span className={`channel ${campaign.channel}`}>{channelLabel[campaign.channel]}</span></td>
                    <td><b>{selectedCampaign?.id === campaign.id ? "▾ " : "▸ "}{campaign.name}</b><small className="id">{campaign.accountName}{campaign.product ? ` · ${campaign.product}` : ""}</small></td>
                    <td onClick={(e) => e.stopPropagation()}><BudgetButton value={campaign.dailyBudget} disabled={campaign.channel === "naver_gfa"} onSave={(v) => void applyOps([{ kind: "update_budget", channel: campaign.channel, entityType: "campaign", id: campaign.id, dailyBudget: v }])} /></td>
                    <td>{won.format(campaign.spend)}</td><td>{campaign.roas}%</td>
                    <td onClick={(e) => e.stopPropagation()}><StatusButton status={campaign.status} label={campaign.name} disabled={campaign.channel === "naver_gfa"} onToggle={(next) => void applyOps([{ kind: "set_status", channel: campaign.channel, entityType: "campaign", id: campaign.id, status: next }])} /></td>
                  </tr>,
                  selectedCampaign?.id === campaign.id && <tr key={`${campaign.id}-detail`} className="detail-row"><td colSpan={7}>
                    {detailError && <div className="connection-error">{detailError}</div>}
                    {!adgroups.length && !detailError && <span className="viz-sub">광고그룹 불러오는 중…</span>}
                    {adgroups.some((group) => !isRunning(group)) && <label className="toggle entity-toggle"><input type="checkbox" checked={showInactiveGroups} onChange={(e) => setShowInactiveGroups(e.target.checked)} /> 꺼짐/종료 광고그룹 {adgroups.filter((group) => !isRunning(group)).length}개 보기</label>}
                    <div className="entity-list">{adgroups.filter((group) => showInactiveGroups || isRunning(group)).map((group) => <div className={`entity-group ${isRunning(group) ? "" : "inactive-row"}`} key={group.id}>
                      <div className="entity-head">
                        <input type="checkbox" checked={selection.has(group.id)} onChange={(e) => toggleMany([{ id: group.id, channel: group.channel, entityType: "adgroup", name: group.name }], e.target.checked)} />
                        <button className="entity-name" onClick={() => adsByGroup[group.id] ? setAdsByGroup((cur) => { const next = { ...cur }; delete next[group.id]; return next; }) : void loadAds(group)}><b>{adsByGroup[group.id] ? "▾ " : "▸ "}{group.name}</b></button>
                        <BudgetButton value={group.dailyBudget} disabled={group.channel === "naver_gfa" || group.channel === "google_ads"} onSave={(v) => void applyOps([{ kind: "update_budget", channel: group.channel, entityType: "adgroup", id: group.id, dailyBudget: v }])} />
                        <StatusButton status={group.status} label={group.name} disabled={group.channel === "naver_gfa"} onToggle={(next) => void applyOps([{ kind: "set_status", channel: group.channel, entityType: "adgroup", id: group.id, status: next }])} />
                      </div>
                      {adsByGroup[group.id]?.map((ad) => <div className={`ad-row ${ad.active === false ? "inactive-row" : ""}`} key={ad.id}>
                        <input type="checkbox" checked={selection.has(ad.id)} onChange={(e) => toggleMany([{ id: ad.id, channel: ad.channel, entityType: "ad", name: ad.name }], e.target.checked)} />
                        {ad.imageUrl ? <img className="ad-thumb" src={ad.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="ad-thumb empty" />}
                        <b>{ad.name}</b>
                        <StatusButton status={ad.status} label={ad.name} disabled={ad.channel === "naver_gfa"} onToggle={(next) => void applyOps([{ kind: "set_status", channel: ad.channel, entityType: "ad", id: ad.id, status: next }])} />
                      </div>)}
                    </div>)}</div>
                  </td></tr>,
                ])}
              </tbody>
            </table>
          </div>
        </section>
      </>}

      {chatUi}
    </main>
  );
}

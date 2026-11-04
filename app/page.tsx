"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Advertiser, MediaMix } from "@/lib/mix";
import { matchMix, mixTotalBudget } from "@/lib/mix";
import { ReportView } from "./report-view";
import { MixView } from "./mix-view";
import { CreativeView } from "./creative-view";
import { SaView } from "./sa-view";
import type { Ad, AdAccount, AdGroup, Campaign, ChangeOperation, Channel, ConnectionStatus, PendingAction } from "@/lib/types";

type ChatMessage = { role: "user" | "assistant"; content: string; pendingActions?: PendingAction[]; mixDrafts?: MediaMix[]; usage?: { input: number; output: number; cached: number } };
type DashTab = "report" | "mix" | "creative" | "sa" | "ops";
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
    onDone(data.message);
  }

  return (
    <div className="confirm-card">
      <strong>{action.title}</strong>
      {action.items.map((item) => (
        <div className="change-row" key={`${item.targetId}-${item.field}`}>
          <span>{item.targetName}</span>
          <span>{item.field}: <del>{String(item.before ?? "없음")}</del> → <b>{String(item.after)}</b></span>
        </div>
      ))}
      <div className="confirm-actions">
        <button className="secondary" disabled={state !== "idle"} onClick={() => setState("cancelled")}>{state === "cancelled" ? "취소됨" : "취소"}</button>
        <button className="primary" disabled={state !== "idle"} onClick={apply}>{state === "loading" ? "적용 중…" : state === "done" ? "적용 완료" : "적용"}</button>
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
  const [view, setView] = useState<"select" | "mapping" | "dashboard">("select");
  const [selectedChannel, setSelectedChannel] = useState<Channel | "all">("all");
  const [campaignQuery, setCampaignQuery] = useState("");
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
  const [storageMode, setStorageMode] = useState<"loading" | "supabase" | "local">("loading");
  const [storageError, setStorageError] = useState("");
  const [mixes, setMixes] = useState<MediaMix[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
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

  const scopedCampaigns = campaigns.filter((campaign) => {
    if (!selectedAdvertiser) return false;
    const mapped = selectedAdvertiser.accountKeys.includes(`${campaign.channel}:${campaign.accountId}`);
    return mapped && (selectedChannel === "all" || campaign.channel === selectedChannel);
  });

  // 돌아가는 캠페인만 기본 표시. 검색하면 꺼진/종료된 것도 함께 보여준다.
  const query = campaignQuery.trim().toLowerCase();
  const runningCount = scopedCampaigns.filter(isRunning).length;
  const hiddenCount = scopedCampaigns.length - runningCount;
  const visibleCampaigns = scopedCampaigns
    .filter((campaign) => query ? `${campaign.name} ${campaign.accountName || ""}`.toLowerCase().includes(query) : showInactive || isRunning(campaign))
    .sort((a, b) => Number(isRunning(b)) - Number(isRunning(a)) || b.spend - a.spend);

  // 매핑되지 않아 표에서 빠진 캠페인 수 (빈 화면일 때 원인 안내용)
  const unmappedCount = campaigns.filter((campaign) => selectedChannel === "all" || campaign.channel === selectedChannel).length - scopedCampaigns.length;

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

  const abortRef = useRef<AbortController | null>(null);
  function stopMessage() {
    abortRef.current?.abort();
  }

  async function sendMessage(preset?: string) {
    const text = (preset ?? input).trim();
    if (!text || sending) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setInput("");
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const history = next.map(({ role, content }) => ({ role, content }));
      const response = await apiFetch("/api/assistant", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: history, context: { advertiserId: selectedAdvertiser?.id, advertiserName: selectedAdvertiser?.name, accountKeys: selectedAdvertiser?.accountKeys || [], mixes, mixLineSummary } }) });
      const data = await response.json();
      setMessages((current) => [...current, { role: "assistant", content: response.ok ? data.message : data.error, pendingActions: data.pendingActions, mixDrafts: data.mixDrafts, usage: data.usage }]);
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      setMessages((current) => [...current, { role: "assistant", content: aborted ? "응답을 중지했어요." : "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." }]);
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  }

  if (view === "select") return (
    <main>
      <header><div><span className="eyebrow">CREATIP · AD OPERATIONS</span><h1>광고주 선택</h1><p>운영할 광고주를 선택하면 연결된 매체 계정을 한 번에 불러옵니다.</p></div><button className="secondary" onClick={() => setView("mapping")}>광고계정 매핑</button></header>
      <section className="advertiser-picker">
        <div className="advertiser-grid">{advertisers.map((advertiser) => <button key={advertiser.id} onClick={() => { setSelectedAdvertiserId(advertiser.id); setView("dashboard"); }}><b>{advertiser.name}</b><span>{advertiser.accountKeys.length}개 광고계정</span></button>)}</div>
        {!advertisers.length && <div className="empty-state"><b>등록된 광고주가 없습니다.</b><span>먼저 광고주를 만들고 광고계정을 매핑해 주세요.</span></div>}
        <button className="primary" onClick={createAdvertiser}>+ 광고주 만들기</button>
      </section>
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
        {([["report", "리포트"], ["mix", "미디어 믹스"], ["creative", "소재 성과"], ["sa", "SA 분석"], ["ops", "운영 설정"]] as Array<[DashTab, string]>).filter(([key]) => key !== "sa" || selectedAdvertiser?.accountKeys.some((k) => k.startsWith("naver_sa:"))).map(([key, label]) => <button key={key} className={dashTab === key ? "active" : ""} onClick={() => setDashTab(key)}>{label}</button>)}
        <span className={`storage-badge ${storageMode}`} title={storageError || undefined}>{storageMode === "supabase" ? "Supabase 저장" : storageMode === "local" ? "이 브라우저에만 저장" : "…"}</span>
      </nav>
      {storageError && <div className="connection-error"><b>저장소 오류</b><span>{storageError}</span></div>}
      {staleKeys.length > 0 && <div className="stale-box"><b>조회되지 않는 계정이 매핑돼 있어요: {staleKeys.join(", ")}</b><span>매니저 계정 번호이거나 접근 권한이 없어진 계정입니다. <button className="link-button" onClick={() => setView("mapping")}>계정 매핑에서 정리하기</button></span></div>}

      {dashTab === "report" && <ReportView accountKeys={selectedAdvertiser?.accountKeys || []} campaigns={campaigns} mixes={mixes} onOpenMix={() => setDashTab("mix")} apiFetch={apiFetch} />}
      {dashTab === "mix" && selectedAdvertiser && <MixView campaigns={advertiserCampaigns} advertiserId={selectedAdvertiser.id} advertiserName={selectedAdvertiser.name} accountKeys={selectedAdvertiser.accountKeys} mixes={mixes} onSave={saveMix} onDelete={removeMix} onAskAi={(prompt) => { setChatOpen(true); void sendMessage(prompt); }} apiFetch={apiFetch} />}
      {dashTab === "sa" && <SaView apiFetch={apiFetch} accountIds={(selectedAdvertiser?.accountKeys || []).filter((k) => k.startsWith("naver_sa:")).map((k) => { const id = k.slice("naver_sa:".length); return { id, name: accounts.find((a) => a.channel === "naver_sa" && a.id === id)?.name || `네이버 SA ${id}` }; })} />}
      {dashTab === "creative" && <CreativeView accountKeys={selectedAdvertiser?.accountKeys || []} apiFetch={apiFetch} />}
      {dashTab === "ops" && <>
      <section className="metrics">
          <article><span>이번 달 광고비</span><strong>{won.format(totals.spend)}</strong><small>연결 채널 통합</small></article>
          <article><span>전환</span><strong>{totals.conversions.toLocaleString()}건</strong><small>이번 달 누적</small></article>
          <article><span>활성 캠페인</span><strong>{totals.active}개</strong><small>전체 {campaigns.length}개</small></article>
        </section>
  
        {mode === "live" && <section className="connections">
          {connections.map((connection) => <article key={connection.channel} className={`connection ${connection.status}`}>
            <div><span className="connection-dot" /><b>{channelLabel[connection.channel]}</b><em>{connection.status === "connected" ? "연결됨" : connection.status === "error" ? "오류" : connection.status === "not_configured" ? "미설정" : "준비 중"}</em></div>
            <strong>{connection.campaignCount}개</strong>
            <small title={connection.message}>{connection.message}</small>
          </article>)}
        </section>}
  
        <nav className="channel-tabs"><button className={selectedChannel === "all" ? "active" : ""} onClick={() => setSelectedChannel("all")}>전체</button>{(Object.keys(channelLabel) as Channel[]).map((channel) => <button key={channel} className={selectedChannel === channel ? "active" : ""} onClick={() => setSelectedChannel(channel)}>{channelLabel[channel]}</button>)}</nav>
  
        <section className="panel">
          <div className="panel-head"><div><h2>캠페인</h2><p>운영 중인 캠페인 {runningCount.toLocaleString()}개{hiddenCount ? ` · 꺼짐/종료 ${hiddenCount.toLocaleString()}개 숨김` : ""}. 검색하면 숨긴 캠페인도 찾을 수 있어요.</p></div><span className="fetched-at">{campaignsFetchedAt ? `${new Date(campaignsFetchedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 기준` : ""}</span><button className="secondary" onClick={() => void refresh(true)}>새로고침</button></div>
          <div className="campaign-filter">
            <input className="account-search" type="search" placeholder="캠페인·계정 이름으로 검색 (꺼진/종료 캠페인 포함)" value={campaignQuery} onChange={(e) => setCampaignQuery(e.target.value)} />
            <label className="toggle"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> 꺼짐/종료 포함</label>
          </div>
          {loadError && <div className="connection-error"><b>실계정 연결 오류</b><span>{loadError}</span><small>Vercel 환경변수의 계정 ID, 토큰 및 권한을 확인해 주세요.</small></div>}
          <div className="table-wrap">
            <table className="campaign-table">
              <thead><tr><th>채널</th><th>캠페인</th><th>일예산</th><th>광고비</th><th>ROAS</th><th>상태</th></tr></thead>
              <tbody>
                {loading ? <tr><td colSpan={6}>불러오는 중…</td></tr> : !loadError && visibleCampaigns.length === 0 ? <tr><td colSpan={6}>{scopedCampaigns.length ? (query ? "검색 결과가 없습니다." : `운영 중인 캠페인이 없습니다. 꺼짐/종료 ${hiddenCount}개는 '꺼짐/종료 포함'을 켜면 보여요.`) : unmappedCount > 0
                  ? <>{selectedChannel === "all" ? "" : `${channelLabel[selectedChannel]} `}캠페인 {unmappedCount.toLocaleString()}개가 있지만 이 광고주에 매핑된 계정이 없습니다. <button className="secondary" onClick={() => setView("mapping")}>계정 매핑하기</button></>
                  : "이 광고주에 매핑된 캠페인이 없습니다."}</td></tr> : visibleCampaigns.map((campaign) => (
                  <tr key={campaign.id} className={isRunning(campaign) ? "" : "inactive-row"} onClick={() => void openCampaign(campaign)}>
                    <td><span className={`channel ${campaign.channel}`}>{channelLabel[campaign.channel]}</span></td>
                    <td><b>{campaign.name}</b><small className="id">{campaign.accountName} · {campaign.id}</small></td>
                    <td><button className="value-button" onClick={() => {
                      const value = window.prompt("변경할 일예산을 입력하세요.", String(campaign.dailyBudget));
                      if (value && Number(value) > 0) void planManual({ kind: "update_budget", channel: campaign.channel, entityType: "campaign", id: campaign.id, dailyBudget: Number(value) });
                    }}>{won.format(campaign.dailyBudget)}</button></td>
                    <td>{won.format(campaign.spend)}</td><td>{campaign.roas}%</td>
                    <td><button className={`status ${campaign.status}`} onClick={() => void planManual({ kind: "set_status", channel: campaign.channel, entityType: "campaign", id: campaign.id, status: campaign.status === "on" ? "off" : "on" })}>{campaign.status.toUpperCase()}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
  
        {selectedCampaign && <section className="panel detail-panel"><div className="panel-head"><div><h2>{selectedCampaign.name}</h2><p>광고그룹/광고세트를 선택하면 소재를 조회합니다.</p></div><button className="secondary" onClick={() => setSelectedCampaign(null)}>닫기</button></div>{detailError && <div className="connection-error">{detailError}</div>}<div className="entity-list">{adgroups.some((group) => !isRunning(group)) && <label className="toggle entity-toggle"><input type="checkbox" checked={showInactiveGroups} onChange={(e) => setShowInactiveGroups(e.target.checked)} /> 꺼짐/종료 광고그룹 {adgroups.filter((group) => !isRunning(group)).length}개 보기</label>}{adgroups.filter((group) => showInactiveGroups || isRunning(group)).map((group) => <div className={`entity-group ${isRunning(group) ? "" : "inactive-row"}`} key={group.id}><button onClick={() => void loadAds(group)}><b>{group.name}</b><span>{won.format(group.dailyBudget)} · {group.status.toUpperCase()}</span></button>{adsByGroup[group.id]?.map((ad) => <div className="ad-row" key={ad.id}><span>소재</span><b>{ad.name}</b><em>{ad.status.toUpperCase()}</em></div>)}</div>)}</div></section>}
      </>}

      <button className="chat-fab" onClick={() => setChatOpen((open) => !open)} aria-label="AI 어시스턴트 열기">✦</button>
      {chatOpen && <aside className="chat-panel">
        <div className="chat-head"><div><b>AI 광고 운영 어시스턴트</b><small>변경은 승인 후 적용됩니다</small></div><button onClick={() => setChatOpen(false)}>×</button></div>
        <div className="messages">
          {messages.map((message, index) => <div className={`message ${message.role}`} key={index}>
            <MarkdownLite value={message.content} />
            {message.usage && <small className="usage-note">토큰 입력 {message.usage.input.toLocaleString()}{message.usage.cached ? ` (캐시 ${message.usage.cached.toLocaleString()})` : ""} · 출력 {message.usage.output.toLocaleString()}</small>}
            {message.mixDrafts?.map((mix) => <MixDraftCard key={mix.id + mix.month} mix={mix} onApply={saveMix} />)}
            {message.pendingActions?.map((action) => <ConfirmCard key={action.id} action={action} onDone={(notice) => { setMessages((current) => [...current, { role: "assistant", content: notice }]); void refresh(true); }} />)}
          </div>)}
          {sending && <div className="message assistant"><span className="typing">● ● ●</span> <button className="link-button" onClick={stopMessage}>중지</button></div>}
        </div>
        <div className="suggestions"><button onClick={() => setInput("이번 달 채널별 성과를 믹스 목표와 비교해줘")}>믹스 대비 성과</button><button onClick={() => setInput("다음 달 미디어 믹스 초안 만들어줘")}>다음 달 믹스</button><button onClick={() => setInput("이번 달 믹스대로 남은 기간 일예산 조정안 만들어줘")}>믹스대로 예산 조정</button><button onClick={() => setInput("성과 좋은 소재 기준으로 Meta 카피 시안 3개 써줘")}>카피 시안</button></div>
        <div className="composer"><textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }} placeholder="예: 브랜드 캠페인 일예산 5만원으로 올려줘" />{sending ? <button className="stop-button" onClick={stopMessage}>■ 중지</button> : <button disabled={!input.trim()} onClick={() => void sendMessage()}>전송</button>}</div>
      </aside>}
    </main>
  );
}

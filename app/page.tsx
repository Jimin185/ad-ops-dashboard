"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Ad, AdAccount, AdGroup, Campaign, ChangeOperation, Channel, ConnectionStatus, PendingAction } from "@/lib/types";

type ChatMessage = { role: "user" | "assistant"; content: string; pendingActions?: PendingAction[] };
type Advertiser = { id: string; name: string; accountKeys: string[] };

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
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [adgroups, setAdgroups] = useState<AdGroup[]>([]);
  const [adsByGroup, setAdsByGroup] = useState<Record<string, Ad[]>>({});
  const [detailError, setDetailError] = useState("");
  const [mappingTab, setMappingTab] = useState<"all" | Channel>("all");
  const [accountQuery, setAccountQuery] = useState("");
  const [registeredSa, setRegisteredSa] = useState<RegisteredNaverSa[]>([]);
  const [saForm, setSaForm] = useState({ name: "", customerId: "", apiKey: "", secretKey: "" });
  const [saStatus, setSaStatus] = useState<{ state: "idle" | "saving" | "error" | "done"; message: string }>({ state: "idle", message: "" });
  const [chatOpen, setChatOpen] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: "안녕하세요. 캠페인 조회, 성과 요약, 예산·상태 변경을 도와드릴게요. 변경은 확인 후에만 적용됩니다." },
  ]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const response = await apiFetch("/api/campaigns", { cache: "no-store" });
    const data = await response.json();
    if (data.mode) setMode(data.mode);
    if (response.ok) {
      setCampaigns(data.campaigns);
      setConnections(data.connections || []);
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
    try { setAdvertisers(JSON.parse(localStorage.getItem("adops-advertisers") || "[]")); } catch { setAdvertisers([]); }
  }, [refresh, loadAccounts]);

  useEffect(() => { localStorage.setItem("adops-advertisers", JSON.stringify(advertisers)); }, [advertisers]);

  const selectedAdvertiser = advertisers.find((item) => item.id === selectedAdvertiserId);
  const scopedCampaigns = campaigns.filter((campaign) => {
    if (!selectedAdvertiser) return false;
    const mapped = selectedAdvertiser.accountKeys.includes(`${campaign.channel}:${campaign.accountId}`);
    return mapped && (selectedChannel === "all" || campaign.channel === selectedChannel);
  });

  // 매핑되지 않아 표에서 빠진 캠페인 수 (빈 화면일 때 원인 안내용)
  const unmappedCount = campaigns.filter((campaign) => selectedChannel === "all" || campaign.channel === selectedChannel).length - scopedCampaigns.length;

  const totals = useMemo(() => ({
    spend: scopedCampaigns.reduce((sum, row) => sum + row.spend, 0),
    conversions: scopedCampaigns.reduce((sum, row) => sum + row.conversions, 0),
    active: scopedCampaigns.filter((row) => row.status === "on").length,
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
    await Promise.all([loadAccounts(), refresh()]);
  }

  async function removeNaverSa(id: string) {
    if (!window.confirm("이 네이버 SA 계정 등록을 삭제할까요? 매핑도 함께 해제됩니다.")) return;
    saveRegisteredSa(loadRegisteredNaverSa().filter((item) => item.id !== id));
    setAdvertisers((current) => current.map((advertiser) => ({ ...advertiser, accountKeys: advertiser.accountKeys.filter((key) => key !== `naver_sa:${id}`) })));
    await Promise.all([loadAccounts(), refresh()]);
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

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setInput("");
    setSending(true);
    try {
      const history = next.map(({ role, content }) => ({ role, content }));
      const response = await apiFetch("/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: history }) });
      const data = await response.json();
      setMessages((current) => [...current, { role: "assistant", content: response.ok ? data.message : data.error, pendingActions: data.pendingActions }]);
    } catch {
      setMessages((current) => [...current, { role: "assistant", content: "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." }]);
    } finally {
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
        <div className="panel-head"><div><h2>캠페인</h2><p>예산과 상태를 직접 수정하거나 AI에게 요청할 수 있습니다.</p></div><button className="secondary" onClick={refresh}>새로고침</button></div>
        {loadError && <div className="connection-error"><b>실계정 연결 오류</b><span>{loadError}</span><small>Vercel 환경변수의 계정 ID, 토큰 및 권한을 확인해 주세요.</small></div>}
        <div className="table-wrap">
          <table className="campaign-table">
            <thead><tr><th>채널</th><th>캠페인</th><th>일예산</th><th>광고비</th><th>ROAS</th><th>상태</th></tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={6}>불러오는 중…</td></tr> : !loadError && scopedCampaigns.length === 0 ? <tr><td colSpan={6}>{unmappedCount > 0
                ? <>{selectedChannel === "all" ? "" : `${channelLabel[selectedChannel]} `}캠페인 {unmappedCount.toLocaleString()}개가 있지만 이 광고주에 매핑된 계정이 없습니다. <button className="secondary" onClick={() => setView("mapping")}>계정 매핑하기</button></>
                : "이 광고주에 매핑된 캠페인이 없습니다."}</td></tr> : scopedCampaigns.map((campaign) => (
                <tr key={campaign.id} onClick={() => void openCampaign(campaign)}>
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

      {selectedCampaign && <section className="panel detail-panel"><div className="panel-head"><div><h2>{selectedCampaign.name}</h2><p>광고그룹/광고세트를 선택하면 소재를 조회합니다.</p></div><button className="secondary" onClick={() => setSelectedCampaign(null)}>닫기</button></div>{detailError && <div className="connection-error">{detailError}</div>}<div className="entity-list">{adgroups.map((group) => <div className="entity-group" key={group.id}><button onClick={() => void loadAds(group)}><b>{group.name}</b><span>{won.format(group.dailyBudget)} · {group.status.toUpperCase()}</span></button>{adsByGroup[group.id]?.map((ad) => <div className="ad-row" key={ad.id}><span>소재</span><b>{ad.name}</b><em>{ad.status.toUpperCase()}</em></div>)}</div>)}</div></section>}

      <button className="chat-fab" onClick={() => setChatOpen((open) => !open)} aria-label="AI 어시스턴트 열기">✦</button>
      {chatOpen && <aside className="chat-panel">
        <div className="chat-head"><div><b>AI 광고 운영 어시스턴트</b><small>변경은 승인 후 적용됩니다</small></div><button onClick={() => setChatOpen(false)}>×</button></div>
        <div className="messages">
          {messages.map((message, index) => <div className={`message ${message.role}`} key={index}>
            <MarkdownLite value={message.content} />
            {message.pendingActions?.map((action) => <ConfirmCard key={action.id} action={action} onDone={(notice) => { setMessages((current) => [...current, { role: "assistant", content: notice }]); void refresh(); }} />)}
          </div>)}
          {sending && <div className="message assistant"><span className="typing">● ● ●</span></div>}
        </div>
        <div className="suggestions"><button onClick={() => setInput("이번 달 광고비 TOP5를 표로 보여줘")}>광고비 TOP5</button><button onClick={() => setInput("MO 광고그룹을 모두 찾아서 꺼줘")}>MO 그룹 OFF</button></div>
        <div className="composer"><textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }} placeholder="예: 브랜드 캠페인 일예산 5만원으로 올려줘" /><button disabled={sending || !input.trim()} onClick={sendMessage}>전송</button></div>
      </aside>}
    </main>
  );
}

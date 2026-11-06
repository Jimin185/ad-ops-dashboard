// 계정별 전환 기준(KPI) 정의. 광고주·믹스마다 보는 전환이 달라서 (구매/장바구니/회원가입/잠재고객 …)
// 계정 단위로 어떤 전환을 '전환' 칸에 집계할지 고른다. 값은 adops_cache 의 kpi_prefs 키에 저장된다.
export type KpiPrefs = Record<string, string>; // "채널:계정ID" → metric id

export const KPI_OPTIONS: Record<string, Array<{ id: string; label: string }>> = {
  meta: [
    { id: "purchase", label: "구매" },
    { id: "add_to_cart", label: "장바구니" },
    { id: "initiate_checkout", label: "결제 시작" },
    { id: "complete_registration", label: "회원가입" },
    { id: "lead", label: "잠재고객" },
  ],
  naver_gfa: [
    { id: "PURCHASE", label: "구매" },
    { id: "ALL", label: "전체 전환" },
    { id: "CART", label: "장바구니" },
    { id: "JOIN", label: "회원가입" },
    { id: "DB", label: "DB(잠재고객)" },
  ],
};

/** Meta 인사이트 actions 에서 metric 별로 집계할 action_type 목록 (앞선 것 하나만 쓴다) */
export const META_KPI_ACTIONS: Record<string, string[]> = {
  purchase: ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"],
  add_to_cart: ["omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"],
  initiate_checkout: ["omni_initiated_checkout", "initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout"],
  complete_registration: ["omni_complete_registration", "complete_registration", "offsite_conversion.fb_pixel_complete_registration"],
  lead: ["lead", "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped"],
};

export const kpiLabel = (channel: string, id?: string) => KPI_OPTIONS[channel]?.find((o) => o.id === id)?.label;

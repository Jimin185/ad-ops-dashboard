# 데스커/크리에이팁 광고 운영 대시보드 — Claude 운영 런북

이 레포는 네이버 SA·GFA·메타·구글애즈를 한 화면에서 운영하는 Next.js 대시보드다.
Claude(또는 운영자)가 실제 광고 세팅을 바꾸는 도구이므로, **모든 변경은 돌이킬 수 있는지 먼저 생각하고 실행한다.**

## 기본 정보

- 프로덕션: https://ad-ops-dashboard-mu.vercel.app — `main` 푸시 시 Vercel 자동 배포 (약 1~2분)
- 매체 API 키는 전부 Vercel 환경변수에 있다 (레포에 없음). 네이버 SA 추가 계정은 Supabase에 암호화 저장.
- 인증: 환경변수 `DASHBOARD_PASSWORD` 설정 시 전체 잠김. 브라우저는 `/login`, **스크립트/Claude는 모든 요청에 `x-dashboard-key: <비밀번호>` 헤더**를 붙인다. `/api/cron/*`은 인증 제외.
- 빌드 확인 없이 main에 푸시하지 말 것: `npm run build` 통과 확인 후 push.

## 금액 환산 규칙 (틀리면 실제 돈이 잘못 나간다)

- 믹스 금액 = **마크업 포함** (광고주 보고 기준). 매체별 마크업: 메타·구글 14%, 네이버 SA·GFA 0%.
  - 매체 집행액 = 믹스 ÷ 1.14 (마크업 매체만)
- **네이버 SA·GFA 예산 입력칸은 VAT 포함**: 매체 집행액 × 1.1 로 입력. 메타·구글은 그대로.
- 일예산 500,000원 이상 입력 시 자릿수 실수 의심 (과거 85,957 → 8,595,700 사고 있었음).
- 브랜드검색 정액은 리포트 소진이 0으로 잡힘 → 계약 API(신형 `/ncc/brand-new/contracts`, 구형 `/ncc/time-contracts`)로 자동 일할 계산됨.

## 주요 API (모두 프로덕션 URL 기준, 변경류는 실행 전 사용자 확인)

- `GET /api/campaigns` (?refresh=1 캐시 무시) — 전 매체 캠페인+월 소진. id는 packed 형식 `채널|계정ID|매체ID` (예: `naver_sa|1922718|cmp-...`)
- `GET /api/entities?channel=&campaignId=` 그룹, `?adgroupId=` 소재 (packed id 사용)
- `POST /api/manual/apply` body `{operations:[{kind:"set_status"|"update_budget"|"update_landing", channel, entityType, id(packed), ...}]}` — ON/OFF·예산·랜딩 일괄 적용
- `GET/POST /api/sa/ads` — 파워링크 소재 조회/B방식 교체(선삭제→등록, `deleteAdId` 옵션). 제목 15자·설명 45자({키워드:기본값}은 기본값 길이로 셈)
- `GET /api/sa/probe?customerId=&path=/ncc/...` — 네이버 SA 원본 객체 읽기 전용 조회
- `POST /api/sa/clone5060` — 캠페인 복제(1회성 작업용): 그룹·키워드·타겟 복사, `action:"fix_targets"`, `action:"copy_shopping_ads"` 포함
- `GET/PUT /api/mixes?advertiserId=` — 월 믹스(lines 포함). PUT은 전체 mix 객체를 보냄 (lines 필드 생략 시 기존 유지, [] 는 삭제)
- `GET/PUT /api/schedules` — ON/OFF 예약. 크론: OFF는 전날 23:30경, ON은 당일 00:10경 KST (Hobby 플랜이라 해당 '시' 안에서 지연 가능). 수동 실행: `GET /api/cron/schedules`
- `GET/PUT /api/kpi`, `/api/brandsearch-contracts` — 계정별 전환지표 선택, 정액 계약 수기 입력
- `POST /api/gfa/ops` body `{method, path:"adAccounts/...", payload}` — GFA 원본 API passthrough (JSON)
- `POST /api/gfa/upload` multipart `accountId, creativeTemplateCode, file` — GFA 소재 이미지 업로드 → 응답의 imageNo로 `/api/gfa/ops`에서 소재 생성 (4MB 이하)
- `POST /api/report` body `{accounts:["meta:123",...], since, until}` — 일자별 매체 실적

## 매체별 제약 (전부 실제로 부딪혀 확인한 것)

- **네이버 SA**: 소재(TEXT_45)는 수정 불가 → 삭제 후 재등록(검수 재시작). 그룹당 파워링크 소재 5개 제한. **쇼핑검색 소재 등록·연령 타겟 생성은 오픈API 미지원** (UI 전용; 기존 타겟 행 수정은 `PUT /ncc/targets/{id}` 가능). 캠페인 기간은 `T15:00:00.000Z`(KST 자정)만 허용. 그룹 생성 시 `targets` 배열은 무시됨 → 생성 후 기본 타겟 행을 PUT으로 교체.
- **GFA**: 예산 수정은 `POST /adAccounts/{acct}/adSets/edit` + `{editType:"AdSetEditBudgetParam", adSetNos, budgetType:"DAILY", budgetAmount}` discriminator 필수. 병렬 조회 시 429 → 동시 3개 제한.
- **메타**: CBO 캠페인은 광고세트 예산 수정 불가(subcode 1885621) → 캠페인 예산으로. 크리에이티브 수정 불가 → object_story_spec 복사 후 새로 생성. 협력광고(CPAS) 캔버스는 외부 URL이 없어 카탈로그 상품 URL로 랜딩 해석.
- **구글애즈**: 캠페인별 EU 정치광고 선언 없으면 모든 mutate 차단(계정 선언을 자동 전파하는 로직 있음). VIDEO·DEMAND_GEN 캠페인은 API 수정 불가. 랜딩은 ads:mutate finalUrls로 수정 가능.

## 트래킹(NT) 체계 — 스마트스토어 유입분석은 경로 2단계까지만 바로 보임

- `nt_source` = `{캠페인}_{목적}_{매체유형}_{매체}` 예: `5060campaign_purchase_SA_PWL`
- `nt_medium` = `{제품}_{소재}` 예: `motionpremium_01gunupapane`, `layoutA_message3_1200x1200`, `computerdesk_organize`
- 비네이버 매체는 스마트스토어 **마케팅 링크**(mkt.shopping.naver.com) + NT 파라미터. 네이버 매체(SA·GFA)는 상품/카테고리 URL에 직접 NT.
- 쇼핑검색은 랜딩 설정이 없어 NT 불가(매체 리포트로 확인).

## 작업 원칙

1. 삭제·교체·예산 변경은 실행 전에 대상 목록을 사용자에게 보여주고 확인받는다. 소재 교체는 검수가 다시 돌아간다는 것을 알린다.
2. 실행 후에는 반드시 API로 결과를 재조회해 검증하고 보고한다 (성공 응답 ≠ 실제 반영: 네이버 타겟처럼 조용히 무시되는 경우 있음).
3. 캠페인 신규 생성은 OFF(userLock) 상태로 만들고, 세팅 완료 확인 후 ON.
4. 대시보드 믹스를 수정하면 "일예산 맞추기" 계산에 바로 반영된다 — 이관은 빼는 쪽과 넣는 쪽을 같은 커밋으로.
5. 민감정보(주민번호·연락처·API 키)는 레포·로그·링크에 절대 넣지 않는다.

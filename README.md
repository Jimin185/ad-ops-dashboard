# AdOps Control Center

네이버 SA, 네이버 GFA, Meta 광고를 수동 UI와 한국어 자연어 명령으로 함께 운영하기 위한 대시보드입니다.

## 현재 제공 기능

- 캠페인 목록, 예산, 상태, 주요 성과 확인
- 화면에서 일예산 및 ON/OFF 변경안 생성
- Claude Opus 5 기반 자연어 조회·성과 분석·변경안 생성
- 모든 변경에 서명된 10분 만료 승인 토큰 적용
- 사용자가 **적용**을 누른 경우에만 광고 어댑터 실행
- API 키가 없으면 채팅 패널에 `API 키 등록 필요` 표시
- 기본 Mock 데이터로 안전한 UI/승인 흐름 테스트

> 현재 커밋은 안전한 MVP 골격입니다. 실제 광고계정 변경을 위해서는 각 채널의 계정 매핑과 운영 규칙을 확인한 뒤 `lib/adapters`에 실연동 어댑터를 추가해야 합니다.

## 시작하기

Node.js 20.9 이상이 필요합니다.

```bash
cp .env.example .env.local
npm install
npm run dev
```

브라우저에서 `http://localhost:3000`을 엽니다. 초기값 `ADAPTER_MODE=mock`에서는 실제 광고계정이 변경되지 않습니다.

## Claude API 키

1. [Anthropic Console](https://console.anthropic.com/)에서 API 키를 발급합니다.
2. `.env.local`에 아래 값을 등록합니다.

```dotenv
ANTHROPIC_API_KEY=your_key_here
PENDING_ACTION_SECRET=long_random_secret
```

Claude 구독료와 API 사용료는 별개입니다. 이 앱은 사용한 입력·출력 토큰만큼 과금되는 Anthropic API를 사용하며, 모델은 요구사항에 따라 정확히 `claude-opus-5`로 지정돼 있습니다. 최신 단가는 [Anthropic 공식 가격표](https://docs.anthropic.com/en/docs/about-claude/pricing)를 확인하세요.

## 광고 API 키 보안

- `.env`, `.env.local`은 Git에서 제외됩니다.
- 브라우저 코드에 광고 API 키를 넣지 않습니다.
- 키는 배포 서비스의 서버 환경변수에만 저장합니다.
- 실제 운영 전 사용자 인증, 역할별 권한, 감사 로그 저장소를 추가해야 합니다.

## 구조

```text
app/                    화면 및 서버 Route Handlers
  api/assistant/        Claude tool-use 루프 (최대 10회)
  api/confirm/          승인 후 변경 실행
  api/manual/plan/      수동 UI 변경안 생성
lib/adapters/           채널 어댑터 계층
lib/assistant-tools.ts  Claude 도구 정의 및 실행 라우팅
lib/pending.ts          승인 요청 서명·만료 검증
```

## 실연동 전 필수 작업

1. 네이버 SA, GFA, Meta 계정 및 캠페인 매핑 확정
2. 채널별 조회·변경 가능 기능 검증
3. 서버 전용 인증 서명 및 토큰 갱신 구현
4. 사용자 로그인과 역할별 계정 접근 제한
5. 변경 감사 로그와 실패 재처리 정책
6. 스테이징 광고계정에서 통합 테스트

절대로 Mock 어댑터를 실계정 어댑터로 단순 교체한 뒤 검증 없이 운영하지 마세요.

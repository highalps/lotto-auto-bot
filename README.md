# lotto-auto-bot

동행복권 자동 구매/주간 당첨 확인 봇입니다.  

## 1) GitHub Actions로만 사용하는 방법 (권장)

로컬 개발 환경(Node.js, pnpm) 없이도 사용할 수 있습니다.

1. 이 저장소를 `Fork` 합니다.
2. Fork한 내 저장소로 이동합니다.
3. 아래 경로에서 값들을 등록합니다.

- Secrets 설정 화면: `https://github.com/<OWNER>/<REPO>/settings/secrets/actions`
- Variables 설정 화면: `https://github.com/<OWNER>/<REPO>/settings/variables/actions`
- GitHub 공식 가이드(Secrets): `https://docs.github.com/en/actions/security-guides/encrypted-secrets`
- GitHub 공식 가이드(Variables): `https://docs.github.com/en/actions/learn-github-actions/variables`

직접 클릭 경로:
- 저장소 `Settings` -> `Secrets and variables` -> `Actions`
- `Secrets` 탭에서 민감정보 등록
- `Variables` 탭에서 일반 설정값 등록

### 1-1) 꼭 만들어야 하는 Secrets

- `LOTTO_USER_ID`: 동행복권 아이디
- `LOTTO_USER_PASSWORD`: 동행복권 비밀번호

### 1-2) 꼭 만들어야 하는 Variables

- `LOTTO_BUY_MODE`: `STOP` | `LOTTO_ONLY` | `PENSION_ONLY` | `BOTH`
- `LOTTO_COUNT`: 로또 구매 수량(최대 5)
- `PENSION_COUNT`: 연금복권 구매 수량

### 1-3) 실행 방법

1. 저장소 `Actions` 탭으로 이동
2. `Buy Lotto` 또는 `Check Weekly Winning` 워크플로우 선택
3. `Run workflow` 클릭
   - `target`: `LOTTO_ONLY`, `PENSION_ONLY`, `BOTH` 선택
   - `lotto_count`, `pension_count`: 각 상품별 구매 수량(1~5) 선택
   - 수동 입력은 Variables보다 우선합니다. 자동 실행은 기존 Variables를 사용합니다.
4. 실행 완료 후 해당 Run을 클릭하고 `Summary`에서 결과 확인

### 1-4) 자동 스케줄

- 로또 구매: 매주 일요일 12:00 KST (UTC `0 3 * * 0`)
- 연금복권 구매: 매주 금요일 12:00 KST (UTC `0 3 * * 5`)
- 구매 워크플로우: `.github/workflows/buy-lotto.yml`
- GitHub 예약 실행은 혼잡 시 지연될 수 있습니다.
- 주간 당첨 체크:
- 연금복권(pension): 매주 목요일 22:00 KST
- 로또6/45(lotto365): 매주 토요일 22:00 KST
- 워크플로우 파일: `.github/workflows/check-weekly.yml`

## 2) Actions Summary에서 보이는 상태값

### 중복 구매 방지와 재시도

- 실제 동행복권 구매내역을 확인합니다. 로또는 KST 일요일 00:00~토요일, 연금복권은 금요일 00:00~목요일을 한 구매 주기로 봅니다.
- 해당 상품의 주기 내 구매가 한 건이라도 있으면 `SKIPPED`로 정상 종료합니다. 수동/자동 실행 모두 적용하며, 이미 일부 수량을 구매한 경우 추가 구매하지 않습니다.
- `BOTH`는 상품별로 검사하므로 로또만 이미 샀다면 연금복권만 구매합니다. 직접 사이트에서 구매한 내역도 포함됩니다.
- 수동/자동 구매 워크플로우를 동시에 실행하지 않도록 concurrency를 설정했습니다.
- 로그인/구매내역 조회 및 결제 전 타임아웃·일시적 네트워크 오류는 최대 3회 시도합니다(추가 재시도 2회, 10/20초 간격).
- 결제 전송 후 오류는 10초 간격으로 구매내역을 최대 3회 확인합니다. 구매가 확인되면 `RECOVERED`로 정상 처리합니다.
- 결제 여부를 확인할 수 없으면 자동 재결제하지 않고 실패로 알립니다. 이 경우 구매내역을 직접 확인한 뒤 재실행하세요. 러너 강제 종료/잡 전체 타임아웃은 내부 재시도 대상이 아닙니다.
- 구매 후 잔액 조회나 세션 저장 실패는 구매 성공 결과를 바꾸지 않습니다.

구매(`buy`) 결과:
- `FAILED (환경변수/설정 오류)`
- `SUCCESS (구매 정상 완료)`
- `SKIPPED (STOP 모드)`
- `FAILED (기타 오류)`

주간 체크(`check:weekly`) 결과:
- `SKIPPED (해당 주간 구매 없음)`
- `SUCCESS (당첨 있음)`
- `SUCCESS (당첨 없음)`
- `FAILED (환경변수/설정 오류)`
- `FAILED (기타 오류)`

## 3) 로컬 실행 방법 (필요한 경우만)

로컬에서 직접 테스트/디버깅할 때만 사용하세요.

사전 요구사항:
- Node.js `22+`
- pnpm
- 동행복권 계정

1. 저장소 clone
2. 의존성 설치

```bash
pnpm install
```

3. `.env.example`를 복사해 `.env` 생성 후 값 입력
4. 타입체크

```bash
pnpm run check
```

5. 구매 실행

```bash
pnpm run buy
```

6. 주간 체크 실행

```bash
pnpm run check:weekly
```

## 4) 로컬 환경변수(.env)

```env
# 필수
LOTTO_USER_ID=your_id
LOTTO_USER_PASSWORD=your_password

# 구매 모드
# STOP | LOTTO_ONLY | PENSION_ONLY | BOTH
# aliases: NONE | LOTTO | PENSION | ALL
LOTTO_BUY_MODE=LOTTO_ONLY

# 구매 수량(각 1~5)
LOTTO_COUNT=5
PENSION_COUNT=1

# Playwright
PLAYWRIGHT_HEADLESS=true
PLAYWRIGHT_STORAGE_STATE_PATH=.auth/storage-state.json

# 주간 체크 대상
# lotto365 | pension
# legacy aliases: LO40 | LP72
CHECK_TARGET=lotto365

# 선택: 기간 강제 지정(YYYYMMDD)
# CHECK_FROM_YMD=20260208
# CHECK_TO_YMD=20260214
```

## 5) 기능 요약

- 로그인: Playwright로 `https://www.dhlottery.co.kr/login` 실제 입력/로그인
- 구매:
- 로또6/45 자동 구매
- 연금복권720+ 자동 구매
- 모드 제어: 멈춤/로또만/연금만/둘다
- 당첨 체크:
- 주간 구매내역 조회
- 구매 없으면 스킵 표시
- 당첨 여부/당첨금 합계 표시

## 6) 트러블슈팅

- `Login failed: 아이디 또는 비밀번호가 일치하지 않습니다.`
- 아이디/비밀번호 오입력 확인
- `Balance check unauthorized (401)`
- 로그인 세션 생성 실패 또는 실행 환경 접근 제한 가능성
- 구매 실패/점검 메시지
- 동행복권 점검 시간, 판매 마감 시간, 예치금 부족 확인

## 7) 주의사항

- 서비스 정책/약관 및 관련 법규를 준수해서 사용하세요.
- 과도한 요청/비정상 사용은 계정 제한을 유발할 수 있습니다.

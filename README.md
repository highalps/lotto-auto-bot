# lotto-auto-bot

동행복권 자동 구매/주간 당첨 확인 봇입니다.  

조회·리포트와 구매 구성은 **`config/report.json`**으로 관리할 수 있습니다.
[조회 설정 빠른 시작](#report-config)에서 설정 파일 예시, 환경변수에서 전환하는 방법,
로그인 없는 미리보기 명령을 확인하세요. 기존 환경변수 방식도 계속 지원합니다.

## 1) GitHub Actions로만 사용하는 방법 (권장)

로컬 개발 환경(Node.js, pnpm) 없이도 사용할 수 있습니다.

1. 이 저장소를 `Fork` 합니다.
2. Fork한 내 저장소로 이동합니다.
3. 아래 경로에서 값들을 등록합니다.

- Secrets 설정 화면: `https://github.com/<OWNER>/<REPO>/settings/secrets/actions`
- GitHub 공식 가이드(Secrets): `https://docs.github.com/en/actions/security-guides/encrypted-secrets`

직접 클릭 경로:
- 저장소 `Settings` -> `Secrets and variables` -> `Actions`
- `Secrets` 탭에서 민감정보 등록

### 1-1) 꼭 만들어야 하는 Secrets

- `LOTTO_USER_ID`: 동행복권 아이디
- `LOTTO_USER_PASSWORD`: 동행복권 비밀번호

### 1-2) 구매 설정

GitHub Actions Variables는 필요하지 않습니다. 구매 활성화 여부, 게임 수, 수동 번호는
[`config/report.json`](config/report.json)의 `purchase`에서 관리합니다. 아이디와 비밀번호만 Secrets에 둡니다.

### 1-3) 실행 방법

1. 저장소 `Actions` 탭으로 이동
2. `Buy Lotto` 또는 `Check Weekly Winning` 워크플로우 선택
3. `Run workflow` 클릭
   - `target`: `LOTTO_ONLY`, `PENSION_ONLY`, `BOTH` 선택
   - `target`: 이번 실행 대상만 선택합니다. 실제 구매 구성은 JSON을 사용합니다.
   - `dry_run` 체크: 로그인 및 구매내역 조회 후 상품별 구매 예정 수량·예상 금액·스킵 여부만 확인합니다. 번호 선택이나 결제는 실행하지 않습니다.
   - dry-run 기본값은 꺼짐이며 예약 실행은 기존대로 실제 구매합니다. 로컬에서는 `LOTTO_DRY_RUN=true pnpm run buy` (PowerShell: `$env:LOTTO_DRY_RUN='true'; pnpm run buy`)로 실행합니다. 로컬 실제 구매 전에는 해당 환경변수를 제거하거나 `false`로 변경하세요.
   - dry-run도 로그인 Secrets가 필요하며, 조회 실패 시 오류로 종료합니다. 이미 구매한 상품은 예정 수량과 금액에서 제외됩니다. 잔액·번호 재고 확인이나 예약은 수행하지 않습니다.
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

설정 미리보기(`config:preview`)만 실행할 때는 계정과 브라우저 설치가 필요하지 않습니다.

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

# 이번 실행 대상. 구매 활성화·수량·번호는 JSON에서 관리
LOTTO_BUY_MODE=LOTTO_ONLY
PURCHASE_CONFIG_PATH=config/report.json

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

# 선택: 조회·리포트 JSON 설정과 프로필
# 파일의 target을 사용하려면 위 CHECK_TARGET을 주석 처리하세요.
# CHECK_CONFIG_PATH=config/report.example.json
# CHECK_PROFILE=weekly
# CHECK_RESULT_PATH=./report-result.json
```

<a id="report-config"></a>

### 조회·리포트 및 구매 설정 파일

`check:weekly`의 조회 프로필과 `buy`의 구매 구성을 한 JSON 파일에서 관리합니다.
추가 패키지 없이 JSON을 검증하고, 알 수 없는 키나 잘못된 조합은 조회 전에 오류로 처리합니다.

[config/report.example.json](config/report.example.json)을 참고해 설정 파일을 작성합니다.
파일은 자동 탐색하지 않으며 `--config` 또는 `CHECK_CONFIG_PATH`로 명시합니다.

**기존 환경변수에서 전환하기**

1. 조회 대상과 기간 등 반복 사용하는 값을 JSON의 `defaults` 또는 `profiles`로 옮깁니다.
2. `.env`에서 옮긴 `CHECK_TARGET`, `CHECK_FROM_YMD`, `CHECK_TO_YMD`, `CHECK_RESULT_PATH`를 제거하거나 주석 처리합니다. 셸에 설정한 같은 환경변수도 확인하세요.
3. `CHECK_CONFIG_PATH`로 파일을 지정하고, 필요하면 `CHECK_PROFILE`로 프로필을 선택합니다.
4. `pnpm run config:preview`로 최종 값과 `sources`를 확인합니다.

인증정보는 기존 Secrets/환경변수에 유지합니다. `purchase`가 있는 version 2 파일에서는
구매 설정 전체를 JSON에서 읽습니다. `purchase`가 없는 version 1 파일만 기존
`LOTTO_BUY_MODE`, `LOTTO_COUNT`, `PENSION_COUNT` 환경변수 방식으로 동작합니다.

```json
{
  "version": 2,
  "defaults": {
    "target": "lotto365",
    "range": { "days": 7 }
  },
  "defaultProfile": "weekly",
  "profiles": {
    "weekly": {},
    "pension-weekly": { "target": "pension" },
    "archive": {
      "range": { "from": "20260101", "to": "20260131" },
      "resultPath": "./report-result.json"
    }
  },
  "purchase": {
    "enabled": true,
    "lotto645": {
      "enabled": true,
      "games": [
        { "mode": "manual", "numbers": [3, 11, 19, 27, 34, 42] },
        { "mode": "auto", "count": 4 }
      ]
    },
    "pension720": { "enabled": false, "count": 1 }
  }
}
```

위 예시는 수동 1게임과 자동 4게임을 한 요청으로 구매합니다. 수동 번호는 1~45의 서로 다른
정수 6개여야 하며, 로또 전체 게임 수는 1~5여야 합니다. `purchase.enabled`는 전체 구매,
상품별 `enabled`는 해당 상품만 중지합니다. 잘못된 JSON은 환경변수 구매로 대체하지 않고 종료합니다.

로그인이나 브라우저 없이 구매 계획을 확인할 수 있습니다.

```bash
pnpm run purchase:preview
```

로그인·브라우저·네트워크 요청 없이 최종 설정을 확인합니다. 결과 파일도 생성하지 않습니다.
인증정보는 필요 없으며 출력에도 포함되지 않습니다.

```bash
pnpm run config:preview --config config/report.example.json
pnpm run config:preview --config config/report.example.json --profile pension-weekly
pnpm run config:preview --config config/report.example.json --profile archive --from 20260201 --to 20260228
```

검증한 설정으로 조회할 때는 같은 인자를 `check:weekly`에 전달합니다.
조회 실행에는 기존 로그인 Secrets가 필요합니다.

```bash
pnpm run check:weekly --config config/report.example.json --profile pension-weekly
```

설정 우선순위(뒤쪽이 우선): **내장 기본값 → 파일 defaults → 선택한 프로필 → 환경변수 → 실행 옵션**.
미리보기의 `sources` 필드에서 각 값의 출처를 확인할 수 있습니다.

| 명령 | 역할 | 로그인 필요 |
|---|---|---|
| `pnpm run config:preview` | 조회 설정 검증과 최종 값 출력 | 아니요 |
| `pnpm run purchase:preview` | 구매 설정·수량·예상 금액 출력 | 아니요 |
| `pnpm run check:weekly` | 설정을 적용한 내역·당첨 조회 | 예 |
| `pnpm run check` | TypeScript 타입 검사 | 아니요 |
| `pnpm test` | 테스트 실행 | 아니요 |

| 설정 | 환경변수 | 실행 옵션 |
|---|---|---|
| 설정 파일 | `CHECK_CONFIG_PATH` | `--config` |
| 프로필 | `CHECK_PROFILE` | `--profile` |
| 조회 대상 | `CHECK_TARGET` | `--target` |
| 시작일 | `CHECK_FROM_YMD` | `--from` |
| 종료일 | `CHECK_TO_YMD` | `--to` |
| 결과 JSON 경로 | `CHECK_RESULT_PATH` | `--result-path` |

- 프로필 선택 순서는 `--profile` → `CHECK_PROFILE` → 파일의 `defaultProfile`입니다.
- 파일이나 프로필을 지정하지 않으면 기존 환경변수 방식으로 동작합니다. 대상은 반드시 지정해야 합니다.
- 기존 `.env`의 `CHECK_TARGET`도 프로필보다 우선합니다. 파일로 옮긴 설정의 환경변수는 제거하거나, 실행 옵션으로 명시적으로 덮어쓰세요.
- `range`는 전체 교체하며 부분 병합하지 않습니다. `days`와 `from`/`to`를 함께 지정할 수 없습니다.
- `days`는 1~3660의 정수입니다. `7`은 기존과 동일하게 KST 오늘에서 7일 전부터 오늘까지의 날짜 범위입니다(양 끝 포함).
- 고정 기간은 실제 달력에 존재하는 `YYYYMMDD` 날짜여야 합니다. 시작일과 종료일은 같은 출처에서 한 쌍으로 지정해야 합니다.
- 빈 환경변수는 미지정으로 취급합니다. JSON의 `null`이나 빈 문자열은 설정 삭제가 아니라 오류입니다.
- 설정 파일과 결과 파일의 상대 경로는 모두 **명령을 실행한 디렉터리** 기준입니다. 결과 파일의 부모 디렉터리는 미리 존재해야 합니다.
- 사용하지 않는 프로필도 검증합니다. 오타, 지원하지 않는 버전, 없는 프로필, 읽을 수 없는 파일은 오류로 종료합니다.
- 비밀번호·토큰은 JSON에 넣지 않고 기존 Secrets/환경변수로 유지합니다.

주간 조회 Actions는 [config/report.json](config/report.json)을 사용합니다.
기존 cron 시간(연금복권 목요일 22:00 KST, 로또 토요일 22:00 KST)은 그대로이며,
각 잡에서 `pension-weekly`, `lotto-weekly` 프로필을 선택합니다.
`CHECK_TARGET`은 워크플로우에서 지정하지 않으므로 파일의 대상이 적용됩니다.
`CHECK_RESULT_PATH`는 후속 결과 읽기 단계와 경로를 맞추기 위해 워크플로우에서 지정합니다.
프로필의 조회 기간을 바꾸려면 `config/report.json`을 수정하세요.
구매 Actions도 같은 파일의 `purchase`를 사용합니다. 예약일과 headless 실행 여부는 워크플로우에 유지됩니다.

## 5) 기능 요약

- 로그인: Playwright로 `https://www.dhlottery.co.kr/login` 실제 입력/로그인
- 구매:
- 로또6/45 수동·자동 혼합 구매(한 요청, 최대 5게임)
- 연금복권720+ 자동 구매
- 모드 제어: 멈춤/로또만/연금만/둘다
- 당첨 체크:
- 주간 구매내역 조회
- 구매 없으면 스킵 표시
- 당첨 여부/당첨금 합계 표시
- 조회·리포트 JSON 설정, 이름 있는 프로필, 실행 옵션 지원
- 로그인 없는 설정 검증·미리보기 및 값의 출처 표시

## 6) 트러블슈팅

조회 설정 관련 문제:

| 증상 | 확인할 내용 |
|---|---|
| 프로필을 바꿔도 대상이 그대로임 | `sources.target`을 확인하고, 프로필보다 우선하는 `CHECK_TARGET` 또는 `--target`을 확인합니다. |
| `Missing report target` | 파일의 `target`, `CHECK_TARGET`, `--target` 중 하나를 지정합니다. |
| `Cannot read report config file` | 실행 디렉터리 기준으로 설정 파일 경로가 맞는지 확인합니다. |
| `Selected profile does not exist` | 선택한 이름이 파일의 `profiles`에 있는지 확인합니다. |
| `from/to must be provided together` | 시작일과 종료일을 같은 출처에서 함께 지정합니다. |
| `contains an unsupported key` | 오류에 표시된 허용 키와 JSON의 철자를 비교합니다. |

로그인·서비스 관련 문제:

- `Login failed: 아이디 또는 비밀번호가 일치하지 않습니다.`
- 아이디/비밀번호 오입력 확인
- `Balance check unauthorized (401)`
- 로그인 세션 생성 실패 또는 실행 환경 접근 제한 가능성
- 구매 실패/점검 메시지
- 동행복권 점검 시간, 판매 마감 시간, 예치금 부족 확인

## 7) 주의사항

- 서비스 정책/약관 및 관련 법규를 준수해서 사용하세요.
- 과도한 요청/비정상 사용은 계정 제한을 유발할 수 있습니다.

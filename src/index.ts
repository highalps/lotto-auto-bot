import "dotenv/config";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { getUserBalance, loginToDhlottery } from "./lotto/auth.js";
import { buyLotto645Auto } from "./lotto/lotto645.js";
import { buyPension720Auto } from "./lotto/pension720.js";
import { browserFingerprint, userAgent } from "./lotto/constants.js";
import { selectMyLotteryledger } from "./lotto/ledger.js";
import { guardedPurchase, purchaseRange, readDryRun, type Product } from "./lotto/purchase-policy.js";

type BuyMode = "STOP" | "LOTTO_ONLY" | "PENSION_ONLY" | "BOTH";

function readBooleanEnv(envValue: string | undefined, defaultValue: boolean): boolean {
  // 환경변수가 비어 있으면 기본값을 사용하고,
  // 문자열 "false"만 명시적 false로 처리한다.
  if (envValue === undefined) {
    return defaultValue;
  }

  return envValue.toLowerCase() !== "false";
}

function readBuyModeEnv(envValue: string | undefined): BuyMode {
  const normalized = (envValue ?? "LOTTO_ONLY").trim().toUpperCase();
  const aliasMap: Record<string, BuyMode> = {
    STOP: "STOP",
    NONE: "STOP",
    LOTTO_ONLY: "LOTTO_ONLY",
    LOTTO: "LOTTO_ONLY",
    PENSION_ONLY: "PENSION_ONLY",
    PENSION: "PENSION_ONLY",
    BOTH: "BOTH",
    ALL: "BOTH"
  };

  const mapped = aliasMap[normalized];
  if (!mapped) {
    throw new Error(
      "LOTTO_BUY_MODE must be one of STOP | LOTTO_ONLY | PENSION_ONLY | BOTH (aliases: NONE | LOTTO | PENSION | ALL)."
    );
  }

  return mapped;
}

function readCountEnv(envKey: string, rawValue: string | undefined): number {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    throw new Error(`${envKey} must be an integer between 1 and 5.`);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isConfigError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("Missing LOTTO_USER_ID or LOTTO_USER_PASSWORD") ||
    message.includes("LOTTO_BUY_MODE must be one of") ||
    message.includes("LOTTO_DRY_RUN must be") ||
    message.includes("must be an integer between 1 and 5")
  );
}

async function writeGithubSummary(markdown: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  await appendFile(summaryPath, `${markdown}\n`, "utf8");
}

async function main(): Promise<void> {
  // 실행 엔트리:
  // 1) 환경변수 검증
  // 2) Playwright 브라우저/컨텍스트 생성
  // 3) 로그인 -> 로또 구매 -> 잔액 조회
  // 4) 세션 상태 저장 및 결과 출력
  const userId = process.env.LOTTO_USER_ID?.trim();
  const userPassword = process.env.LOTTO_USER_PASSWORD?.trim();
  const buyMode = readBuyModeEnv(process.env.LOTTO_BUY_MODE);
  const dryRun = readDryRun(process.env.LOTTO_DRY_RUN);
  const lottoCount = readCountEnv("LOTTO_COUNT", process.env.LOTTO_COUNT ?? "5");
  const pensionCount = readCountEnv("PENSION_COUNT", process.env.PENSION_COUNT ?? "1");

  if (!userId || !userPassword) {
    throw new Error("Missing LOTTO_USER_ID or LOTTO_USER_PASSWORD in environment variables.");
  }

  const headless = readBooleanEnv(process.env.PLAYWRIGHT_HEADLESS, true);
  const storageStatePath = process.env.PLAYWRIGHT_STORAGE_STATE_PATH ?? ".auth/storage-state.json";
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent,
    locale: browserFingerprint.locale,
    timezoneId: browserFingerprint.timezoneId,
    viewport: browserFingerprint.viewport,
    deviceScaleFactor: browserFingerprint.deviceScaleFactor,
    extraHTTPHeaders: browserFingerprint.extraHTTPHeaders
  });

  try {
    if (buyMode === "STOP") {
      const stoppedOutput = {
        success: true,
        stopped: true,
        buyMode
      };
      console.log(JSON.stringify(stoppedOutput, null, 2));
      await writeGithubSummary(
        [
          "## 구매 실행 결과",
          "- 상태: SKIPPED (STOP 모드)",
          `- LOTTO_BUY_MODE: ${buyMode}`,
          "- 메시지: STOP 모드라 구매를 수행하지 않음"
        ].join("\n")
      );
      return;
    }

    await loginToDhlottery(context, { userId, userPassword, validateWithBalance: false });
    let lottoResponse: Awaited<ReturnType<typeof buyLotto645Auto>> | null = null;
    let pensionResponse: Awaited<ReturnType<typeof buyPension720Auto>> | null = null;
    const statuses: Partial<Record<Product, string>> = {};
    const hasPurchase = (product: Product) => async () => {
      const ledger = await selectMyLotteryledger(context, {
        ...purchaseRange(product), ltGdsCd: product, recordCountPerPage: 1
      });
      return ledger.total > 0 || ledger.list.length > 0;
    };
    const reportProduct = async (product: Product, status: string) => {
      statuses[product] = status;
      const description = status === "DRY_RUN"
        ? `구매 예정: ${product === "LO40" ? lottoCount : pensionCount}게임 (실제 구매 없음)`
        : status === "SKIPPED" ? "이번 구매 주기에 이미 구매한 내역이 있어 건너뜀"
        : status === "RECOVERED" ? "응답 오류 후 구매내역에서 구매 완료 확인" : "구매 완료";
      await writeGithubSummary(`### ${product === "LO40" ? "로또6/45" : "연금복권720+"}\n- 상태: ${status}\n- ${description}`);
    };

    if (buyMode === "LOTTO_ONLY" || buyMode === "BOTH") {
      const result = await guardedPurchase({
        dryRun,
        hasPurchase: hasPurchase("LO40"),
        buy: onSubmit => buyLotto645Auto(context, { gameCount: lottoCount, onSubmit })
      });
      lottoResponse = result.response ?? null;
      await reportProduct("LO40", result.status);
    }

    if (buyMode === "PENSION_ONLY" || buyMode === "BOTH") {
      const result = await guardedPurchase({
        dryRun,
        hasPurchase: hasPurchase("LP72"),
        buy: onSubmit => buyPension720Auto(context, { gameCount: pensionCount, onSubmit })
      });
      pensionResponse = result.response ?? null;
      await reportProduct("LP72", result.status);
    }

    if (dryRun) {
      const plannedLottoCount = statuses.LO40 === "DRY_RUN" ? lottoCount : 0;
      const plannedPensionCount = statuses.LP72 === "DRY_RUN" ? pensionCount : 0;
      const plannedAmount = (plannedLottoCount + plannedPensionCount) * 1000;
      console.log(JSON.stringify({ success: true, dryRun, buyMode, statuses,
        plannedLottoCount, plannedPensionCount, plannedAmount, purchasedCount: 0 }, null, 2));
      await writeGithubSummary([
        "## DRY-RUN 결과 (실제 구매 없음)",
        `- LOTTO_BUY_MODE: ${buyMode}`,
        `- 로또 구매 예정: ${plannedLottoCount}게임`,
        `- 연금복권 구매 예정: ${plannedPensionCount}게임`,
        `- 예상 결제금액: ${plannedAmount.toLocaleString("ko-KR")}원`,
        "- 번호 선택 및 결제 요청을 수행하지 않았습니다.",
        "- 실제 구매 시점의 잔액과 번호 재고에 따라 결과가 달라질 수 있습니다."
      ].join("\n"));
      return;
    }

    const balance = await getUserBalance(context).catch(error => {
      console.warn(`Balance unavailable after purchase: ${String(error)}`);
      return "조회 불가 (구매 결과에 영향 없음)";
    });

    try {
      await mkdir(dirname(storageStatePath), { recursive: true });
      await context.storageState({ path: storageStatePath });
    } catch (error) { console.warn(`Session storage unavailable: ${String(error)}`); }

    const successOutput = {
      success: true,
      buyMode,
      statuses,
      lottoCount: lottoResponse ? lottoCount : null,
      pensionCount: pensionResponse ? pensionCount : null,
      balance,
      lottoResultCode: lottoResponse?.result?.resultCode ?? null,
      lottoResultMessage: lottoResponse?.result?.resultMsg ?? null,
      pensionSelectedCount: pensionResponse?.selectedGameCount ?? null,
      pensionOrderNo: pensionResponse?.orderNo ?? null
    };

    console.log(JSON.stringify(successOutput, null, 2));
    await writeGithubSummary(
      [
        "## 구매 실행 결과",
        Object.values(statuses).every(status => status === "SKIPPED")
          ? "- 상태: SKIPPED (이번 구매 주기에 이미 구매함)"
          : "- 상태: SUCCESS (상품별 결과 참조)",
        `- LOTTO_BUY_MODE: ${buyMode}`,
        `- 로또 신규 구매 수량: ${statuses.LO40 === "RECOVERED" ? "구매내역 참조" : successOutput.lottoCount ?? 0}`,
        `- 연금복권 신규 구매 수량: ${statuses.LP72 === "RECOVERED" ? "구매내역 참조" : successOutput.pensionCount ?? 0}`,
        `- 잔액: ${balance}`,
        `- 로또 응답: ${successOutput.lottoResultCode ?? "-"} / ${successOutput.lottoResultMessage ?? "-"}`,
        `- 연금복권 주문번호: ${successOutput.pensionOrderNo ?? "-"}`
      ].join("\n")
    );

    return;
  } finally {
    await context.close();
    await browser.close();
  }
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error: unknown) {
    const message = errorMessage(error);
    const summaryLines = ["## 구매 실행 결과"];
    if (isConfigError(error)) {
      summaryLines.push("- 상태: FAILED (환경변수/설정 오류)");
    } else {
      summaryLines.push("- 상태: FAILED (기타 오류)");
    }
    summaryLines.push(`- 오류 메시지: ${message}`);
    await writeGithubSummary(summaryLines.join("\n"));
    throw error;
  }
}

run().catch((error: unknown) => {
  console.error("[lotto-auto-bot] buy failed:", error);
  process.exitCode = 1;
});

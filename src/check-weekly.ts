import "dotenv/config";
import { appendFile } from "node:fs/promises";
import { chromium } from "playwright";
import { loginToDhlottery } from "./lotto/auth.js";
import { selectMyLotteryledger, type LedgerItem } from "./lotto/ledger.js";
import { userAgent } from "./lotto/constants.js";

type CheckTarget = "LO40" | "LP72";

function toYmdInKst(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}${month}${day}`;
}

function subtractDays(date: Date, days: number): Date {
  const target = new Date(date);
  target.setDate(target.getDate() - days);
  return target;
}

function readTargetEnv(): CheckTarget {
  const raw = (process.env.CHECK_TARGET ?? "").trim().toUpperCase();
  if (raw === "LO40" || raw === "LP72") {
    return raw;
  }
  throw new Error("CHECK_TARGET must be LO40 or LP72.");
}

function isValidYmd(value: string): boolean {
  return /^\d{8}$/.test(value);
}

function readRangeEnv(now: Date): { fromYmd: string; toYmd: string } {
  const fromRaw = process.env.CHECK_FROM_YMD?.trim();
  const toRaw = process.env.CHECK_TO_YMD?.trim();

  if (!fromRaw && !toRaw) {
    return {
      fromYmd: toYmdInKst(subtractDays(now, 7)),
      toYmd: toYmdInKst(now)
    };
  }

  if (!fromRaw || !toRaw) {
    throw new Error("CHECK_FROM_YMD and CHECK_TO_YMD must be provided together.");
  }
  if (!isValidYmd(fromRaw) || !isValidYmd(toRaw)) {
    throw new Error("CHECK_FROM_YMD and CHECK_TO_YMD must be in YYYYMMDD format.");
  }
  if (fromRaw > toRaw) {
    throw new Error("CHECK_FROM_YMD must be less than or equal to CHECK_TO_YMD.");
  }

  return { fromYmd: fromRaw, toYmd: toRaw };
}

function parseAmount(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? NaN)) {
    return 0;
  }
  return Number(value);
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
    message.includes("CHECK_TARGET must be LO40 or LP72") ||
    message.includes("Missing LOTTO_USER_ID or LOTTO_USER_PASSWORD") ||
    message.includes("CHECK_FROM_YMD and CHECK_TO_YMD") ||
    message.includes("CHECK_FROM_YMD must be less than or equal to CHECK_TO_YMD")
  );
}

function formatWonAmount(item: LedgerItem): string {
  if (item.ltGdsCd === "LP72" && item.lramSmamTypeCd === "H" && item.wnRnk === 1) {
    return "700만원 x 240개월";
  }
  if (item.ltGdsCd === "LP72" && item.lramSmamTypeCd === "H" && (item.wnRnk === 2 || item.wnRnk === 21)) {
    return "100만원 x 120개월";
  }
  if (!item.ltWnAmt) {
    return "-";
  }
  return `${item.ltWnAmt.toLocaleString("ko-KR")}원`;
}

function buildSummaryMarkdown(args: {
  target: CheckTarget;
  fromYmd: string;
  toYmd: string;
  list: LedgerItem[];
  wonList: LedgerItem[];
  unresolvedList: LedgerItem[];
  totalWinAmount: number;
}): string {
  const targetName = args.target === "LO40" ? "로또6/45" : "연금복권720+";
  const period = `${args.fromYmd.slice(0, 4)}-${args.fromYmd.slice(4, 6)}-${args.fromYmd.slice(6, 8)} ~ ${args.toYmd.slice(0, 4)}-${args.toYmd.slice(4, 6)}-${args.toYmd.slice(6, 8)}`;
  const lines: string[] = [];
  lines.push(`## ${targetName} 주간 당첨 체크`);
  lines.push(`- 기간(KST): ${period}`);

  if (args.list.length === 0) {
    lines.push("- 상태: SKIPPED (해당 주간 구매 없음)");
    lines.push("- 결과: 이번 주 구매 내역이 없어 체크를 건너뜀");
    return `${lines.join("\n")}\n`;
  }

  if (args.wonList.length > 0) {
    lines.push("- 상태: SUCCESS (당첨 있음)");
  } else {
    lines.push("- 상태: SUCCESS (당첨 없음)");
  }
  lines.push(`- 구매건수: ${args.list.length}건`);
  lines.push(`- 당첨건수: ${args.wonList.length}건`);
  lines.push(`- 미추첨/미확인: ${args.unresolvedList.length}건`);
  lines.push(`- 당첨금 합계: ${args.totalWinAmount.toLocaleString("ko-KR")}원`);
  lines.push("");
  lines.push("| 구입일자 | 상품 | 회차 | 당첨결과 | 당첨금 | 번호/정보 |");
  lines.push("|---|---|---|---|---|---|");
  for (const item of args.list) {
    lines.push(
      `| ${item.eltOrdrDt} | ${item.ltGdsNm} | ${item.ltEpsdView} | ${item.ltWnResult} | ${formatWonAmount(item)} | ${item.gmInfo ?? "-"} |`
    );
  }
  return `${lines.join("\n")}\n`;
}

async function writeGithubSummary(markdown: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  await appendFile(summaryPath, `${markdown}\n`, "utf8");
}

async function main(): Promise<void> {
  const userId = process.env.LOTTO_USER_ID?.trim();
  const userPassword = process.env.LOTTO_USER_PASSWORD?.trim();
  const target = readTargetEnv();

  if (!userId || !userPassword) {
    throw new Error("Missing LOTTO_USER_ID or LOTTO_USER_PASSWORD in environment variables.");
  }

  const now = new Date();
  const { fromYmd, toYmd } = readRangeEnv(now);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent });
  try {
    await loginToDhlottery(context, { userId, userPassword });
    const response = await selectMyLotteryledger(context, {
      fromYmd,
      toYmd,
      ltGdsCd: target,
      pageNum: 1,
      recordCountPerPage: 200
    });

    const list = response.list;
    const wonList = list.filter((item) => item.ltWnResult === "당첨");
    const unresolvedList = list.filter((item) => item.ltWnResult === "미추첨" || item.ltWnResult === "미확인");
    const totalWinAmount = wonList.reduce((sum, item) => sum + parseAmount(item.ltWnAmt), 0);

    const output = {
      success: true,
      target,
      fromYmd,
      toYmd,
      purchasedCount: list.length,
      wonCount: wonList.length,
      unresolvedCount: unresolvedList.length,
      totalWinAmount
    };
    console.log(JSON.stringify(output, null, 2));

    const summary = buildSummaryMarkdown({
      target,
      fromYmd,
      toYmd,
      list,
      wonList,
      unresolvedList,
      totalWinAmount
    });
    await writeGithubSummary(summary);
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
    const summaryLines = ["## 주간 당첨 체크 결과"];
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
  console.error("[lotto-auto-bot] weekly check failed:", error);
  process.exitCode = 1;
});

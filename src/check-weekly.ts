import "dotenv/config";
import { appendFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { loginToDhlottery } from "./lotto/auth.js";
import { getPurchasedGameCount, selectMyLotteryledger, type LedgerItem } from "./lotto/ledger.js";
import { browserFingerprint, userAgent } from "./lotto/constants.js";

import { loadReportConfig, ReportConfigError, type CheckTarget } from "./report-config.js";

function parseAmount(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? NaN)) {
    return 0;
  }
  return Number(value);
}

function parseRank(value: unknown): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const rank = Number(value);
  if (!Number.isInteger(rank) || rank < 1) {
    return null;
  }
  return rank;
}

function getBestRank(wonList: LedgerItem[]): number | null {
  let bestRank: number | null = null;
  for (const item of wonList) {
    const rank = parseRank(item.wnRnk);
    if (rank === null) {
      continue;
    }
    if (bestRank === null || rank < bestRank) {
      bestRank = rank;
    }
  }
  return bestRank;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isConfigError(error: unknown): boolean {
  return error instanceof ReportConfigError || errorMessage(error).includes("Missing LOTTO_USER_ID or LOTTO_USER_PASSWORD");
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
  purchasedGameCount: number;
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
  lines.push(`- 구매 주문수: ${args.list.length}건`);
  lines.push(`- 구매 게임수: ${args.purchasedGameCount}게임`);
  lines.push(`- 당첨 주문수: ${args.wonList.length}건`);
  lines.push(`- 미추첨/미확인 주문수: ${args.unresolvedList.length}건`);
  lines.push(`- 당첨금 합계: ${args.totalWinAmount.toLocaleString("ko-KR")}원`);
  lines.push("");
  lines.push("| 구입일자 | 상품 | 회차 | 게임수 | 당첨결과 | 당첨금 | 번호/정보 |");
  lines.push("|---|---|---|---:|---|---|---|");
  for (const item of args.list) {
    lines.push(
      `| ${item.eltOrdrDt} | ${item.ltGdsNm} | ${item.ltEpsdView} | ${item.prchsQty} | ${item.ltWnResult} | ${formatWonAmount(item)} | ${item.gmInfo ?? "-"} |`
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

async function writeCheckResultFile(payload: unknown, resultPath?: string): Promise<void> {
  if (!resultPath) {
    return;
  }
  await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const userId = process.env.LOTTO_USER_ID?.trim();
  const userPassword = process.env.LOTTO_USER_PASSWORD?.trim();
  const { target, fromYmd, toYmd, resultPath } = await loadReportConfig({ argv: process.argv.slice(2) });

  if (!userId || !userPassword) {
    throw new Error("Missing LOTTO_USER_ID or LOTTO_USER_PASSWORD in environment variables.");
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent,
    locale: browserFingerprint.locale,
    timezoneId: browserFingerprint.timezoneId,
    viewport: browserFingerprint.viewport,
    deviceScaleFactor: browserFingerprint.deviceScaleFactor,
    extraHTTPHeaders: browserFingerprint.extraHTTPHeaders
  });
  try {
    await loginToDhlottery(context, { userId, userPassword, validateWithBalance: false });
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
    const purchasedGameCount = getPurchasedGameCount(list);
    const totalWinAmount = wonList.reduce((sum, item) => sum + parseAmount(item.ltWnAmt), 0);
    const bestRank = getBestRank(wonList);

    const output = {
      success: true,
      target,
      fromYmd,
      toYmd,
      purchasedCount: list.length,
      purchaseOrderCount: list.length,
      purchasedGameCount,
      wonCount: wonList.length,
      unresolvedCount: unresolvedList.length,
      totalWinAmount,
      bestRank,
      summaryMarkdown: buildSummaryMarkdown({
        target,
        fromYmd,
        toYmd,
        list,
        wonList,
        unresolvedList,
        purchasedGameCount,
        totalWinAmount
      })
    };
    console.log(JSON.stringify(output, null, 2));
    await writeCheckResultFile(output, resultPath);

    await writeGithubSummary(output.summaryMarkdown);
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

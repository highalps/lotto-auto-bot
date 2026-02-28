import type { BrowserContext, Frame } from "playwright";
import { elotteryUrl } from "./constants.js";
import type { BuyPension720Options, BuyPension720Response } from "./types.js";

const pension720Url = `${elotteryUrl}/game/TotalGame.jsp?LottoId=LP72`;
const pension720MobileUrl = pension720Url.replace("https://el.dhlottery.co.kr", "https://m.dhlottery.co.kr");

function isLikelyPension720Url(url: string): boolean {
  return /LP72/i.test(url) || /pension720/i.test(url) || /totalgame/i.test(url);
}

type PensionFrameSignal = {
  frame: Frame;
  score: number;
  buyCntCount: number;
  autoButtonCount: number;
  orderNoCount: number;
};

async function inspectPension720Signals(frame: Frame): Promise<PensionFrameSignal> {
  const frameUrl = frame.url();
  const [buyCntCount, autoButtonCount, orderNoCount] = await Promise.all([
    frame.locator("#frm input[name='BUY_CNT']").count().catch(() => 0),
    frame.locator("a[onclick='doAuto()']").count().catch(() => 0),
    frame.locator("#lotto720_popup_pay .orderNo").count().catch(() => 0)
  ]);

  let score = 0;
  if (isLikelyPension720Url(frameUrl)) {
    score += 4;
  }
  if (buyCntCount > 0) {
    score += 10;
  }
  if (autoButtonCount > 0) {
    score += 10;
  }
  if (orderNoCount > 0) {
    score += 2;
  }

  return { frame, score, buyCntCount, autoButtonCount, orderNoCount };
}

function summarizeFrames(signals: PensionFrameSignal[]): string {
  return signals
    .map(
      (signal) =>
        `${signal.frame.url()} [score=${signal.score}, buyCnt=${signal.buyCntCount}, auto=${signal.autoButtonCount}, order=${signal.orderNoCount}]`
    )
    .join(", ");
}

async function waitForPension720GameFrame(contextFrame: Frame, timeoutMs: number): Promise<Frame> {
  const startedAt = Date.now();
  let triggeredTabView = false;

  while (Date.now() - startedAt < timeoutMs) {
    const frameSignals = await Promise.all(contextFrame.page().frames().map(inspectPension720Signals));
    const candidates = frameSignals.filter((signal) => signal.score >= 10);
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0].frame;
    }

    // 간헐적으로 탭 전환 스크립트가 지연 적용되므로 LP72 탭 이동을 한 번 강제 시도한다.
    if (!triggeredTabView) {
      triggeredTabView = true;
      await contextFrame
        .page()
        .evaluate(() => {
          const tabViewFn = (globalThis as { tabview?: (lottoId: string) => void }).tabview;
          if (typeof tabViewFn === "function") {
            tabViewFn("LP72");
          }
        })
        .catch(() => undefined);
    }

    await contextFrame.page().waitForTimeout(250);
  }

  const frameSummary = summarizeFrames(await Promise.all(contextFrame.page().frames().map(inspectPension720Signals)));
  throw new Error(`Pension720 game frame not found. page=${contextFrame.page().url()} frames=[${frameSummary}]`);
}

async function getBuyCount(frame: Frame): Promise<number> {
  const value = await frame.locator("#frm input[name='BUY_CNT']").inputValue();
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return parsed;
}

async function waitForBuyCountAtLeast(frame: Frame, minimumCount: number, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const currentCount = await getBuyCount(frame);
    if (currentCount >= minimumCount) {
      return currentCount;
    }
    await frame.page().waitForTimeout(200);
  }
  throw new Error(`Timed out while waiting selected pension numbers. minimumCount=${minimumCount}`);
}

async function requestAutoLotNo(frame: Frame, timeoutMs: number): Promise<string> {
  await frame.evaluate(() => {
    (globalThis as { data?: unknown; q?: string }).data = undefined;
    (globalThis as { data?: unknown; q?: string }).q = "";

    const radio = (globalThis as { document?: { querySelector: (selector: string) => { click?: () => void } | null } })
      .document?.querySelector("#lotto720_radio_group_wrapper_num1");
    radio?.click?.();

    const doAutoFn = (globalThis as { doAuto?: () => void }).doAuto;
    if (typeof doAutoFn === "function") {
      doAutoFn();
    }
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const autoState = await frame.evaluate(() => {
      const data = (globalThis as { data?: { resultCode?: string; resultMsg?: string | null; selLotNo?: string } }).data;
      return {
        resultCode: data?.resultCode ?? "",
        resultMsg: data?.resultMsg ?? "",
        selLotNo: data?.selLotNo ?? ""
      };
    });

    if (autoState.resultCode && autoState.resultCode !== "100") {
      throw new Error(`Pension720 auto number request failed. code=${autoState.resultCode} msg=${autoState.resultMsg}`);
    }

    if (autoState.resultCode === "100" && /^\d{6}$/.test(autoState.selLotNo)) {
      return autoState.selLotNo;
    }

    await frame.page().waitForTimeout(200);
  }

  throw new Error("Timed out while requesting pension auto number.");
}

async function appendBuyNumber(frame: Frame, lotNo: string): Promise<void> {
  const appended = await frame.evaluate((value) => {
    const addOneFn = (globalThis as { addBuyDataOne?: (...args: unknown[]) => void }).addBuyDataOne;
    if (typeof addOneFn !== "function") {
      return false;
    }
    addOneFn(`1${value}`, 1, "S", "A", true);
    return true;
  }, lotNo);

  if (!appended) {
    throw new Error("Pension720 addBuyDataOne is not available.");
  }
}

async function waitForOrderNo(frame: Frame, timeoutMs: number): Promise<string | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const orderNo = await frame
      .locator("#lotto720_popup_pay .orderNo")
      .first()
      .textContent()
      .catch(() => null);
    const normalized = orderNo?.trim() ?? "";
    if (normalized.length > 0) {
      return normalized;
    }
    await frame.page().waitForTimeout(200);
  }
  return null;
}

function hasHardFailureDialog(dialogMessages: string[]): string | null {
  const failKeywords = ["실패", "오류", "불가", "해제", "중지", "점검", "제한", "부족", "로그인"];
  for (const message of dialogMessages) {
    const normalized = message.trim();
    if (!normalized) {
      continue;
    }
    if (failKeywords.some((keyword) => normalized.includes(keyword))) {
      return normalized;
    }
  }
  return null;
}

export async function buyPension720Auto(
  context: BrowserContext,
  options: BuyPension720Options
): Promise<BuyPension720Response> {
  // 연금복권 720 자동구매:
  // 1) LP72 게임창 진입
  // 2) iframe에서 자동번호 선택 gameCount회 누적
  // 3) 구매요청 실행(doOrderRequest)
  if (!Number.isInteger(options.gameCount) || options.gameCount < 1 || options.gameCount > 5) {
    throw new Error("PENSION_COUNT must be an integer between 1 and 5.");
  }

  const page = await context.newPage();
  const dialogMessages: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogMessages.push(dialog.message());
    await dialog.accept();
  });

  try {
    const targetUrls = [pension720Url, pension720MobileUrl];
    let gameFrame: Frame | null = null;
    let gameResponseStatus: number | "unknown" = "unknown";
    let lastError: unknown;

    for (const targetUrl of targetUrls) {
      const gameResponse = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      gameResponseStatus = gameResponse?.status() ?? "unknown";
      if (!gameResponse || !gameResponse.ok()) {
        lastError = new Error(`Pension720 page request failed. status=${gameResponseStatus} url=${targetUrl}`);
        continue;
      }

      try {
        gameFrame = await waitForPension720GameFrame(page.mainFrame(), 20000);
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!gameFrame) {
      const message =
        lastError instanceof Error ? lastError.message : `${String(lastError)}`;
      throw new Error(
        `Pension720 game frame not found after URL fallback. status=${gameResponseStatus} urls=[${targetUrls.join(", ")}] lastError=${message}`
      );
    }

    await gameFrame.waitForSelector("#frm input[name='BUY_CNT']", { state: "attached", timeout: 15000 });
    await gameFrame.waitForSelector("a[onclick='doAuto()']", { state: "attached", timeout: 15000 });

    for (let attempt = 0; attempt < options.gameCount; attempt += 1) {
      const beforeCount = await getBuyCount(gameFrame);
      const lotNo = await requestAutoLotNo(gameFrame, 15000);
      await appendBuyNumber(gameFrame, lotNo);
      await waitForBuyCountAtLeast(gameFrame, beforeCount + 1, 15000);
    }

    const selectedGameCount = await getBuyCount(gameFrame);
    if (selectedGameCount < options.gameCount) {
      throw new Error(
        `Pension720 selected count is smaller than requested. selected=${selectedGameCount}, requested=${options.gameCount}`
      );
    }

    await gameFrame.evaluate(() => {
      const doOrderRequestFn = (globalThis as { doOrderRequest?: () => void }).doOrderRequest;
      if (typeof doOrderRequestFn === "function") {
        doOrderRequestFn();
      }
    });

    const failedDialog = hasHardFailureDialog(dialogMessages);
    if (failedDialog) {
      throw new Error(`Pension720 purchase failed: ${failedDialog}`);
    }

    const orderNo = await waitForOrderNo(gameFrame, 20000);
    return {
      requestedGameCount: options.gameCount,
      selectedGameCount,
      orderNo
    };
  } finally {
    await page.close();
  }
}

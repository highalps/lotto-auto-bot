import type { BrowserContext, Frame, Locator, Page } from "playwright";
import { baseUrl, elotteryUrl } from "./constants.js";
import type { BuyPension720Options, BuyPension720Response } from "./types.js";

const pension720Url = `${elotteryUrl}/game/TotalGame.jsp?LottoId=LP72`;
const pension720MobileUrl = pension720Url.replace("https://el.dhlottery.co.kr", "https://m.dhlottery.co.kr");
const pension720WwwUrl = pension720Url.replace("https://el.dhlottery.co.kr", "https://www.dhlottery.co.kr");
const pension720AlternativeUrls = [pension720WwwUrl, `${baseUrl}/game/TotalGame.jsp?LottoId=LP72`];
const buyCountSelectors = [
  "#frm input[name='BUY_CNT']",
  "#frm input[id*='BUY_CNT']",
  "#frm input[name*='BUY_CNT']",
  "#frm input[name='buyCnt']",
  "#frm input[id='buyCnt']",
  "#frm input[name='buy_count']",
  "#frm input[name='sel_cnt']",
  "input[name='BUY_CNT']",
  "input[id='BUY_CNT']",
  "input[name='buyCnt']"
];
const directBuyCountSelectors = ["input[id*='BUY'], input[name*='BUY']", "input[id*='COUNT'], input[name*='COUNT']", "input[id*='CNT'], input[name*='CNT']"];
const autoButtonSelectors = "a[onclick='doAuto()'], button[onclick='doAuto()'], [onclick='doAuto()'], .btn_auto";
const autoButtonTextKeywords = ["자동", "auto", "랜덤", "자동선택"];
const autoFunctionCandidates = ["doAuto", "autoSelect", "doAutoSelect", "auto", "자동선택", "selectAuto"];
const addBuyFunctionCandidates = [
  "addBuyDataOne",
  "appendBuyNumber",
  "appendAutoNumber",
  "addBuy",
  "addAutoBuyNumber",
  "addDataOne",
  "addLotto"
];

function isLikelyPension720Url(url: string): boolean {
  return /LP72/i.test(url) || /pension720/i.test(url) || /totalgame/i.test(url);
}

type PensionFrameSignal = {
  frame: Frame;
  score: number;
  buyCntCount: number;
  autoButtonCount: number;
  orderNoCount: number;
  hasOrderRequestFn: boolean;
  hasAutoFn: boolean;
};

async function findBuyCountLocator(frame: Frame): Promise<Locator | null> {
  for (const selector of buyCountSelectors) {
    const locator = frame.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      return locator;
    }
  }
  return null;
}

function trimFunctionNames(candidates: string[]): string[] {
  return candidates
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

async function findCallableFunctionName(frame: Frame, candidates: string[]): Promise<string | null> {
  const normalized = trimFunctionNames(candidates);
  const directMatch = await frame.evaluate((candidateNames) => {
    const globalWindow = globalThis as Record<string, unknown>;
    for (const name of candidateNames) {
      const value = globalWindow[name];
      if (typeof value === "function") {
        return name;
      }
    }
    return null;
  }, normalized);
  if (directMatch) {
    return directMatch;
  }

  const heuristics = await frame.evaluate((candidateNames) => {
    const globalWindow = globalThis as Record<string, unknown>;
    const lowerCandidates = candidateNames.map((value) => value.toLowerCase());
    for (const key of Object.keys(globalWindow)) {
      if (lowerCandidates.some((candidate) => key.toLowerCase().includes(candidate) || candidate.includes(key.toLowerCase()))) {
        const value = globalWindow[key];
        if (typeof value === "function") {
          return key;
        }
      }
    }
    return null;
  }, normalized);
  return heuristics;
}

async function clickAutoButton(frame: Frame): Promise<boolean> {
  return frame.evaluate((keywordList) => {
    const candidateSelectors = [
      "a[onclick*='auto' i]",
      "a[onclick*='Auto' i]",
      "button[onclick*='auto' i]",
      "button[onclick*='Auto' i]",
      "input[type='button'][onclick*='auto' i]",
      ".btn_auto",
      ".auto_btn",
      "[class*='auto']"
    ];

    for (const selector of candidateSelectors) {
      const candidate = Array.from(document.querySelectorAll(selector)) as Array<HTMLElement>;
      if (candidate.length > 0) {
        candidate[0]?.click();
        return true;
      }
    }

    const allClickable = Array.from(
      document.querySelectorAll("button, a, input[type='button'], input[type='submit']")
    ) as Array<HTMLElement>;
    const keywords = keywordList.map((keyword) => keyword.toLowerCase());
    for (const element of allClickable) {
      const normalizedText = ((element.textContent ?? "") + (element.getAttribute("value") ?? "")).toLowerCase();
      if (keywords.some((keyword) => normalizedText.includes(keyword))) {
        element.click();
        return true;
      }
    }

    return false;
  }, autoButtonTextKeywords);
}

async function inspectPension720Signals(frame: Frame): Promise<PensionFrameSignal> {
  const frameUrl = frame.url();
  const buyCountLocator = await findBuyCountLocator(frame);
  const [buyCntCount, autoButtonCount, orderNoCount] = await Promise.all([
    buyCountLocator ? buyCountLocator.count().catch(() => 0) : Promise.resolve(0),
    frame.locator(autoButtonSelectors).count().catch(() => 0),
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
    const strictCandidates = frameSignals.filter(
      (signal) => signal.buyCntCount > 0 || signal.autoButtonCount > 0 || signal.score >= 14
    );
    const candidates = strictCandidates.length > 0 ? strictCandidates : frameSignals.filter((signal) => signal.score >= 4);

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

async function openWithUiFallback(page: Page): Promise<void> {
  const mainTarget = page;
  await mainTarget.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
  await mainTarget.waitForTimeout(500).catch(() => undefined);

  await mainTarget.evaluate(() => {
    const tabview = (globalThis as { tabview?: (lottoId: string) => void }).tabview;
    if (typeof tabview === "function") {
      tabview("LP72");
      return;
    }

    const anchors = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
    const matchedAnchor = anchors.find((anchor) => anchor.href.includes("LP72"));
    if (matchedAnchor) {
      matchedAnchor.click();
    }
  });

  await mainTarget.waitForTimeout(1500).catch(() => undefined);
}

async function findPensionFrame(page: Page, timeoutMs: number): Promise<Frame | null> {
  try {
    return await waitForPension720GameFrame(page.mainFrame(), timeoutMs);
  } catch {
    return null;
  }
}

async function getBuyCount(frame: Frame): Promise<number | null> {
  const locator = await findBuyCountLocator(frame);
  if (!locator) {
    return null;
  }

  const value = await locator.inputValue().catch(() => "");
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

async function waitForBuyCountAtLeast(frame: Frame, minimumCount: number, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const currentCount = await getBuyCount(frame);
    if (currentCount === null) {
      throw new Error("Pension720 buy count input is no longer available.");
    }
    if (currentCount >= minimumCount) {
      return currentCount;
    }
    await frame.page().waitForTimeout(200);
  }
  throw new Error(`Timed out while waiting selected pension numbers. minimumCount=${minimumCount}`);
}

async function waitForPensionFrameReady(frame: Frame, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const hasBuyCount = (await findBuyCountLocator(frame)) !== null;
    const autoButtonCount = await frame.locator(autoButtonSelectors).count().catch(() => 0);
    const hasOrderArea = await frame.locator("#lotto720_popup_pay").count().catch(() => 0);

    if (hasBuyCount || autoButtonCount > 0 || hasOrderArea > 0) {
      return;
    }

    await frame.page().waitForTimeout(250);
  }

  throw new Error("Pension720 game frame is not ready: missing expected controls.");
}

async function waitForSelectedNumberAppeared(frame: Frame, selectedNumber: string, timeoutMs: number): Promise<void> {
  const prefixed = `1${selectedNumber}`;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const appeared = await frame
      .evaluate((target) => {
        const text = document.body?.textContent ?? "";
        if (text.replace(/\s+/g, "").includes(target)) {
          return true;
        }

        const inputs = Array.from(document.querySelectorAll("input")).filter((element) => {
          const value = (element as HTMLInputElement).value;
          return value.includes(target);
        });
        return inputs.length > 0;
      }, prefixed)
      .catch(() => false);

    if (appeared) {
      return;
    }
    await frame.page().waitForTimeout(200);
  }

  throw new Error(`Timed out while waiting selected number to appear. number=${prefixed}`);
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
    const targetUrls = [pension720Url, pension720MobileUrl, ...pension720AlternativeUrls];
    let gameFrame: Frame | null = null;
    let gameResponseStatus: number | "unknown" = "unknown";
    let gameResponseUrl = "";
    const responseTexts: string[] = [];
    let lastError: unknown;

    for (const targetUrl of targetUrls) {
      gameResponseUrl = targetUrl;
      const gameResponse = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((error) => {
        lastError = error;
        return null;
      });
      gameResponseStatus = gameResponse?.status() ?? "unknown";
      if (gameResponse) {
        try {
          const text = await gameResponse.text().catch(() => null);
          if (text && text.length > 0) {
            responseTexts.push(text.slice(0, 200));
          }
        } catch {
          // no-op
        }
      }

      gameFrame = await findPensionFrame(page, 12000);
      if (gameFrame) {
        break;
      }
      lastError = new Error(`Pension720 frame not found on ${targetUrl} status=${gameResponseStatus}`);
    }

    if (!gameFrame) {
      await openWithUiFallback(page).catch(() => undefined);
      gameFrame = await findPensionFrame(page, 15000);
    }

    if (!gameFrame) {
      await openWithUiFallback(page).catch(() => undefined);
      gameFrame = await findPensionFrame(page, 10000);
    }

    if (!gameFrame) {
      const message =
        lastError instanceof Error ? lastError.message : `${String(lastError)}`;
      throw new Error(
        `Pension720 game frame not found after all fallback steps. status=${gameResponseStatus} lastUrl=${gameResponseUrl} urls=[${targetUrls.join(", ")}] responseSamples=[${responseTexts.join(" | ")}] lastError=${message} page=${page.url()}`
      );
    }

    await waitForPensionFrameReady(gameFrame, 20000);

    const canReadBuyCount = (await findBuyCountLocator(gameFrame)) !== null;
    let selectedGameCount = 0;
    for (let attempt = 0; attempt < options.gameCount; attempt += 1) {
      const beforeCount = canReadBuyCount ? await getBuyCount(gameFrame) : null;
      const lotNo = await requestAutoLotNo(gameFrame, 15000);
      await appendBuyNumber(gameFrame, lotNo);
      if (canReadBuyCount) {
        const nextCount = await waitForBuyCountAtLeast(gameFrame, (beforeCount ?? 0) + 1, 15000);
        selectedGameCount = nextCount;
      } else {
        await waitForSelectedNumberAppeared(gameFrame, lotNo, 15000);
        selectedGameCount += 1;
      }
    }

    if (canReadBuyCount) {
      selectedGameCount = (await getBuyCount(gameFrame)) ?? selectedGameCount;
    }

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

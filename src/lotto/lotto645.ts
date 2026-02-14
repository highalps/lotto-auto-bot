import type { BrowserContext } from "playwright";
import { lotto645Url, lottoSlots, userAgent } from "./constants.js";
import type { BuyLottoOptions, BuyLottoResponse } from "./types.js";

type BuyRequirements = {
  direct: string;
  drawDate: string;
  paymentDeadlineDate: string;
  currentRound: string;
};

function sleep(delayMs: number): Promise<void> {
  // 재시도 사이에 짧게 대기하기 위한 유틸 함수.
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function withRetries<T>(action: () => Promise<T>, maxRetries: number, retryDelayMs: number): Promise<T> {
  // 네트워크 일시 장애를 고려해 동일 요청을 재시도한다.
  // 최종 실패 시 마지막 에러를 그대로 던져 원인 파악이 가능하게 한다.
  let currentError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      currentError = error;
      if (attempt < maxRetries) {
        await sleep(retryDelayMs);
      }
    }
  }

  throw currentError;
}

function extractInputValue(html: string, inputId: string): string | null {
  // 서버 HTML에서 숨김 input 값을 추출한다.
  // 속성 순서가 달라질 수 있어 id->value / value->id 패턴을 모두 지원한다.
  const idFirstRegex = new RegExp(`id=["']${inputId}["'][^>]*value=["']([^"']*)["']`, "i");
  const valueFirstRegex = new RegExp(`value=["']([^"']*)["'][^>]*id=["']${inputId}["']`, "i");

  const idFirstMatch = html.match(idFirstRegex);
  if (idFirstMatch?.[1]) {
    return idFirstMatch[1];
  }

  const valueFirstMatch = html.match(valueFirstRegex);
  if (valueFirstMatch?.[1]) {
    return valueFirstMatch[1];
  }

  return null;
}

function calculateFallbackDrawDate(): string {
  // HTML 파싱 실패 대비용: "다음 토요일"을 추첨일로 계산한다.
  const now = new Date();
  const day = now.getDay();
  const daysUntilSaturday = (6 - day + 7) % 7;
  const nextSaturday = new Date(now);
  nextSaturday.setDate(now.getDate() + daysUntilSaturday);
  return nextSaturday.toISOString().slice(0, 10);
}

function calculateFallbackDeadlineDate(drawDate: string): string {
  // HTML 파싱 실패 대비용: 원본 구현처럼 추첨일 + 366일을 결제마감일로 계산한다.
  const drawDateObject = new Date(drawDate);
  drawDateObject.setDate(drawDateObject.getDate() + 366);
  return drawDateObject.toISOString().slice(0, 10);
}

async function getCurrentRound(context: BrowserContext): Promise<string> {
  // 메인 페이지의 현재 회차(최근 추첨 회차)를 읽어 +1 하여 구매 대상 회차를 만든다.
  // 파싱 실패 시 기준일/기준회차 기반으로 주차 계산 fallback을 사용한다.
  const response = await context.request.get("https://www.dhlottery.co.kr/common.do?method=main", {
    headers: { "User-Agent": userAgent }
  });
  const html = await response.text();
  const match = html.match(/<strong[^>]*id=["']lottoDrwNo["'][^>]*>(\d+)<\/strong>/i);

  if (match?.[1]) {
    return String(Number(match[1]) + 1);
  }

  const baseDate = new Date("2024-12-28T00:00:00+09:00");
  const baseRound = 1152;
  const today = new Date();
  const days = Math.floor((today.getTime() - baseDate.getTime()) / (1000 * 60 * 60 * 24));
  const weeks = Math.max(0, Math.floor(days / 7));
  return String(baseRound + weeks);
}

async function getBuyRequirements(context: BrowserContext): Promise<BuyRequirements> {
  // 구매 전 필수 값 조회:
  // 1) ready socket API에서 direct 값 획득
  // 2) game645 페이지에서 추첨일/마감일/현재회차 input 값 추출
  const readyResponse = await withRetries(
    () =>
      context.request.post(`${lotto645Url}/olotto/game/egovUserReadySocket.json`, {
        headers: {
          "User-Agent": userAgent,
          Origin: lotto645Url,
          Referer: `${lotto645Url}/olotto/game/game645.do`,
          "X-Requested-With": "XMLHttpRequest",
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }),
    5,
    2000
  );

  if (!readyResponse.ok()) {
    throw new Error(`egovUserReadySocket failed. status=${readyResponse.status()}`);
  }

  const readyPayload = (await readyResponse.json()) as { ready_ip?: string };
  const direct = readyPayload.ready_ip;
  if (!direct) {
    throw new Error("ready_ip not found in egovUserReadySocket response.");
  }

  const gamePageResponse = await context.request.get(`${lotto645Url}/olotto/game/game645.do`, {
    headers: {
      "User-Agent": userAgent,
      Referer: "https://www.dhlottery.co.kr/common.do?method=main"
    }
  });

  if (!gamePageResponse.ok()) {
    throw new Error(`game645 page request failed. status=${gamePageResponse.status()}`);
  }

  const html = await gamePageResponse.text();
  const drawDate = extractInputValue(html, "ROUND_DRAW_DATE") ?? calculateFallbackDrawDate();
  const paymentDeadlineDate =
    extractInputValue(html, "WAMT_PAY_TLMT_END_DT") ?? calculateFallbackDeadlineDate(drawDate);
  const currentRound = extractInputValue(html, "curRound") ?? (await getCurrentRound(context));

  return {
    direct,
    drawDate,
    paymentDeadlineDate,
    currentRound
  };
}

function buildAutoPickParam(gameCount: number): string {
  // 자동번호 구매 파라미터를 Python 원본과 동일한 구조(JSON 문자열)로 생성한다.
  // A~E 슬롯 중 구매 매수만큼 사용한다.
  const entries = lottoSlots.slice(0, gameCount).map((slot) => ({
    genType: "0",
    arrGameChoiceNum: null,
    alpabet: slot
  }));

  return JSON.stringify(entries);
}

export async function buyLotto645Auto(context: BrowserContext, options: BuyLottoOptions): Promise<BuyLottoResponse> {
  // 로또 자동구매 메인 함수:
  // - 입력 검증(1~5장)
  // - 구매 요구값 조회
  // - execBuy 호출
  // - 응답의 로그인/성공 여부 검증
  if (!Number.isInteger(options.gameCount) || options.gameCount < 1 || options.gameCount > 5) {
    throw new Error("LOTTO_COUNT must be an integer between 1 and 5.");
  }

  const requirements = await getBuyRequirements(context);
  const response = await withRetries(
    () =>
      context.request.post(`${lotto645Url}/olotto/game/execBuy.do`, {
        headers: {
          "User-Agent": userAgent,
          Origin: lotto645Url,
          Referer: `${lotto645Url}/olotto/game/game645.do`,
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
        },
        form: {
          round: requirements.currentRound,
          direct: requirements.direct,
          nBuyAmount: String(options.gameCount * 1000),
          param: buildAutoPickParam(options.gameCount),
          ROUND_DRAW_DATE: requirements.drawDate,
          WAMT_PAY_TLMT_END_DT: requirements.paymentDeadlineDate,
          gameCnt: String(options.gameCount),
          saleMdaDcd: "10"
        }
      }),
    5,
    2000
  );

  if (!response.ok()) {
    throw new Error(`execBuy failed. status=${response.status()}`);
  }

  const payload = (await response.json()) as BuyLottoResponse;
  const loginResult = payload.loginYn === "Y";
  const resultMessage = String(payload.result?.resultMsg ?? "").toUpperCase();

  if (!loginResult || resultMessage !== "SUCCESS") {
    throw new Error(`Lotto purchase failed. response=${JSON.stringify(payload)}`);
  }

  return payload;
}

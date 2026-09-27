import type { BrowserContext } from "playwright";
import { lotto645Url, lottoSlots, userAgent } from "./constants.js";
import type { BuyLottoOptions, BuyLottoResponse } from "./types.js";

type BuyRequirements = {
  direct: string;
  drawDate: string;
  paymentDeadlineDate: string;
  currentRound: string;
};

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

function toKstCalendarDate(now: Date): Date {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000);
}

function calculateFallbackDrawDate(now = new Date()): string {
  // HTML 파싱 실패 대비용: 한국시간 기준 "다음 토요일"을 추첨일로 계산한다.
  const kstNow = toKstCalendarDate(now);
  const day = kstNow.getUTCDay();
  const daysUntilSaturday = (6 - day + 7) % 7;
  const nextSaturday = new Date(kstNow);
  nextSaturday.setUTCDate(kstNow.getUTCDate() + daysUntilSaturday);
  return nextSaturday.toISOString().slice(0, 10);
}

function calculateFallbackDeadlineDate(drawDate: string): string {
  // HTML 파싱 실패 대비용: 원본 구현처럼 추첨일 + 366일을 결제마감일로 계산한다.
  const drawDateObject = new Date(drawDate);
  drawDateObject.setDate(drawDateObject.getDate() + 366);
  return drawDateObject.toISOString().slice(0, 10);
}

export function calculateFallbackRound(now = new Date()): number {
  // 1152회 추첨일을 기준으로 판매 회차가 일요일 00:00 KST에 넘어가도록 계산한다.
  const kstNow = toKstCalendarDate(now);
  const currentDate = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate());
  const baseDate = Date.UTC(2024, 11, 28);
  const days = Math.floor((currentDate - baseDate) / (1000 * 60 * 60 * 24));
  const weeksSinceBaseRound = Math.max(0, Math.floor((days + 6) / 7));
  return 1152 + weeksSinceBaseRound;
}

export function resolveSalesRound(pageRound: string | null, latestDrawRound: string | null, now = new Date()): string {
  const candidates = [calculateFallbackRound(now)];

  if (pageRound && /^\d+$/.test(pageRound)) {
    candidates.push(Number(pageRound));
  }
  if (latestDrawRound && /^\d+$/.test(latestDrawRound)) {
    candidates.push(Number(latestDrawRound) + 1);
  }

  return String(Math.max(...candidates));
}

async function getLatestDrawRound(context: BrowserContext): Promise<string | null> {
  // 메인 페이지에는 최근 추첨이 끝난 회차가 표시된다.
  try {
    const response = await context.request.get("https://www.dhlottery.co.kr/common.do?method=main", {
      headers: { "User-Agent": userAgent }
    });
    if (!response.ok()) {
      return null;
    }

    const html = await response.text();
    const match = html.match(/<strong[^>]*id=["']lottoDrwNo["'][^>]*>\s*(\d+)\s*<\/strong>/i);
    return match?.[1] ?? null;
  } catch {
    // 메인 페이지 조회 장애가 구매 페이지/달력 기반 회차 판정을 막지 않게 한다.
    return null;
  }
}

async function getBuyRequirements(context: BrowserContext): Promise<BuyRequirements> {
  // 구매 전 필수 값 조회:
  // 1) ready socket API에서 direct 값 획득
  // 2) game645 페이지에서 추첨일/마감일/현재회차 input 값 추출
  const readyResponse = await context.request.post(`${lotto645Url}/olotto/game/egovUserReadySocket.json`, {
        headers: {
          "User-Agent": userAgent,
          Origin: lotto645Url,
          Referer: `${lotto645Url}/olotto/game/game645.do`,
          "X-Requested-With": "XMLHttpRequest",
          "Content-Type": "application/x-www-form-urlencoded"
        }
      });

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
  const pageRound = extractInputValue(html, "curRound");
  const latestDrawRound = await getLatestDrawRound(context);
  const currentRound = resolveSalesRound(pageRound, latestDrawRound);

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
  options.onSubmit?.();
  const response = await context.request.post(`${lotto645Url}/olotto/game/execBuy.do`, {
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
      });

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

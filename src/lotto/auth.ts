import type { BrowserContext } from "playwright";
import { baseUrl, userAgent } from "./constants.js";
import type { LoginOptions } from "./types.js";

function assertNotBlocked(stage: string, url: string): void {
  if (url.includes("/errorPage")) {
    throw new Error(
      `${stage} blocked by dhlottery site protection (url=${url}). ` +
        "현재 실행 환경(IP/네트워크)에서 로그인 페이지 접근이 제한된 상태입니다."
    );
  }
}

async function normalizeAuthCookies(context: BrowserContext): Promise<void> {
  // 인증 쿠키가 특정 서브도메인으로 한정될 수 있으므로
  // .dhlottery.co.kr 도메인으로 재주입해 ol.dhlottery.co.kr 구매 API까지 공유되게 만든다.
  const cookies = await context.cookies();
  const targetCookieNames = new Set(["JSESSIONID", "DHJSESSIONID", "WMONID"]);

  const normalizedCookies = cookies
    .filter((cookie) => targetCookieNames.has(cookie.name))
    .map((cookie) => ({
      ...cookie,
      domain: ".dhlottery.co.kr",
      path: "/"
    }));

  if (normalizedCookies.length > 0) {
    await context.addCookies(normalizedCookies);
  }
}

async function submitLogin(context: BrowserContext, userId: string, userPassword: string): Promise<void> {
  // 로그인 페이지 JS가 자체적으로 RSA 암호화 후 전송하도록
  // 실제 페이지 입력/클릭 플로우를 그대로 수행한다.
  const page = await context.newPage();
  try {
    await page.setExtraHTTPHeaders({ "User-Agent": userAgent });
    const loginPageResponse = await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
    assertNotBlocked("Login page", page.url());

    if (!loginPageResponse || !loginPageResponse.ok()) {
      throw new Error(`Login page request failed. status=${loginPageResponse?.status() ?? "unknown"}`);
    }

    await page.waitForSelector("#inpUserId", { timeout: 10000 });
    await page.waitForSelector("#inpUserPswdEncn", { timeout: 10000 });
    await page.fill("#inpUserId", userId);
    await page.fill("#inpUserPswdEncn", userPassword);
    await page.click("#btnLogin");
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);

    assertNotBlocked("Login submit", page.url());
    const responseText = await page.content();
    const errorMessageMatch = responseText.match(/const\s+errorMessage\s*=\s*'([^']*)';/);
    if (errorMessageMatch?.[1]) {
      throw new Error(`Login failed: ${errorMessageMatch[1]}`);
    }

    await normalizeAuthCookies(context);
  } finally {
    await page.close();
  }
}

export async function getUserBalance(context: BrowserContext): Promise<string> {
  // 마이페이지 잔액 API를 호출해 로그인 유효성을 함께 확인한다.
  // HTML이 오면 세션 만료/로그인 실패로 판단하고 예외를 발생시킨다.
  const response = await context.request.get(`${baseUrl}/mypage/selectUserMndp.do?_=${Date.now()}`, {
    headers: {
      "User-Agent": userAgent,
      Referer: `${baseUrl}/mypage/home`,
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript, */*; q=0.01",
      AJAX: "true"
    }
  });

  if (!response.ok()) {
    if (response.status() === 401) {
      throw new Error(
        "Balance check unauthorized (401). 로그인 세션이 만들어지지 않았거나, 실행 환경 접근이 차단된 상태일 수 있습니다."
      );
    }
    throw new Error(`Balance check request failed. status=${response.status()}`);
  }

  const text = (await response.text()).trim();
  if (text.length === 0) {
    throw new Error("Balance check returned an empty response. Login session may be invalid.");
  }

  if (text.startsWith("<")) {
    throw new Error("Balance check returned HTML. Login session may be invalid.");
  }

  let payload: { data?: { userMndp?: { totalAmt?: string | number } } };
  try {
    payload = JSON.parse(text) as { data?: { userMndp?: { totalAmt?: string | number } } };
  } catch {
    const preview = text.slice(0, 200);
    throw new Error(`Balance check returned non-JSON response: ${preview}`);
  }

  const totalAmount = payload.data?.userMndp?.totalAmt ?? 0;
  const normalizedAmount = Number(String(totalAmount).replaceAll(",", ""));

  if (!Number.isFinite(normalizedAmount)) {
    return "0원";
  }

  return `${normalizedAmount.toLocaleString("ko-KR")}원`;
}

export async function loginToDhlottery(context: BrowserContext, options: LoginOptions): Promise<void> {
  // 로그인 전체 시퀀스:
  // 1) /login 페이지에서 실제 입력/클릭
  // 2) 사이트 JS가 생성한 인증 쿠키 정규화
  // 3) 잔액 API로 로그인 유효성 최종 확인
  await submitLogin(context, options.userId, options.userPassword);
  await getUserBalance(context);
}

import { constants as cryptoConstants, createPublicKey, publicEncrypt } from "node:crypto";
import type { BrowserContext } from "playwright";
import { baseUrl, userAgent } from "./constants.js";
import type { LoginOptions } from "./types.js";

const debugAuthEnvKey = "LOTTO_DEBUG_AUTH";

function isDebugAuthEnabled(): boolean {
  return process.env[debugAuthEnvKey]?.toLowerCase() === "true";
}

function logAuthDebug(message: string): void {
  if (isDebugAuthEnabled()) {
    console.log(`[auth-debug] ${message}`);
  }
}

function assertNotBlocked(stage: string, url: string): void {
  if (url.includes("/errorPage")) {
    throw new Error(
      `${stage} blocked by dhlottery site protection (url=${url}). ` +
        "현재 실행 환경(IP/네트워크)에서 로그인 페이지 접근이 제한된 상태입니다."
    );
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function withRetries<T>(action: () => Promise<T>, maxRetries: number, retryDelayMs: number): Promise<T> {
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

function toBase64UrlFromHex(hexValue: string): string {
  const normalizedHex = hexValue
    .trim()
    .replace(/^0x/i, "")
    .replace(/[^0-9a-f]/gi, "")
    .replace(/^00+/, "");
  const evenHex = normalizedHex.length % 2 === 0 ? normalizedHex : `0${normalizedHex}`;

  return Buffer.from(evenHex, "hex")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function rsaEncryptToHex(plainText: string, modulusHex: string, exponentHex: string): string {
  const publicKey = createPublicKey({
    key: {
      kty: "RSA",
      n: toBase64UrlFromHex(modulusHex),
      e: toBase64UrlFromHex(exponentHex)
    },
    format: "jwk"
  });

  const encrypted = publicEncrypt(
    {
      key: publicKey,
      padding: cryptoConstants.RSA_PKCS1_PADDING
    },
    Buffer.from(plainText, "utf8")
  );

  return encrypted.toString("hex");
}

function buildBaseRequestHeaders(): Record<string, string> {
  return {
    "User-Agent": userAgent,
    Connection: "keep-alive",
    "Cache-Control": "max-age=0",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "Upgrade-Insecure-Requests": "1",
    Origin: baseUrl,
    "Content-Type": "application/x-www-form-urlencoded",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
    Referer: `${baseUrl}/`,
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-User": "?1",
    "Sec-Fetch-Dest": "document",
    "Accept-Language": "ko,en-US;q=0.9,en;q=0.8,ko-KR;q=0.7"
  };
}

async function getRsaKey(context: BrowserContext): Promise<{ modulus: string; exponent: string }> {
  const headers = buildBaseRequestHeaders();
  headers.Accept = "application/json";
  headers["X-Requested-With"] = "XMLHttpRequest";
  headers.Referer = `${baseUrl}/user.do?method=login`;
  delete headers["Upgrade-Insecure-Requests"];

  const response = await context.request.get(`${baseUrl}/login/selectRsaModulus.do`, { headers });
  if (!response.ok()) {
    throw new Error(`RSA modulus request failed. status=${response.status()}`);
  }

  const payload = (await response.json()) as {
    data?: { rsaModulus?: string; publicExponent?: string };
    rsaModulus?: string;
    publicExponent?: string;
  };

  const modulus = payload.data?.rsaModulus ?? payload.rsaModulus;
  const exponent = payload.data?.publicExponent ?? payload.publicExponent;
  if (!modulus || !exponent) {
    throw new Error("RSA modulus/publicExponent not found in response.");
  }

  return { modulus, exponent };
}

async function submitLoginViaPageFlow(context: BrowserContext, userId: string, userPassword: string): Promise<void> {
  const page = await context.newPage();
  try {
    const loginPageResponse = await page.goto(`${baseUrl}/user.do?method=login`, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    logAuthDebug(
      `fallback-login-page status=${loginPageResponse?.status() ?? "unknown"} finalUrl=${page.url().split("?")[0]}`
    );
    assertNotBlocked("Fallback login page", page.url());

    if (!loginPageResponse || !loginPageResponse.ok()) {
      throw new Error(`Fallback login page request failed. status=${loginPageResponse?.status() ?? "unknown"}`);
    }

    await page.waitForSelector("#inpUserId", { timeout: 10000 });
    const passwordLocator = page.locator("input[type='password']").first();
    await passwordLocator.waitFor({ timeout: 10000 });

    await page.fill("#inpUserId", userId);
    await passwordLocator.fill(userPassword);
    await page.click("#btnLogin");
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
    logAuthDebug(`fallback-login-submit finalUrl=${page.url().split("?")[0]}`);

    assertNotBlocked("Fallback login submit", page.url());
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

  if (isDebugAuthEnabled()) {
    const cookieState = (await context.cookies())
      .filter((cookie) => targetCookieNames.has(cookie.name))
      .map((cookie) => `${cookie.name}@${cookie.domain}`);
    logAuthDebug(`normalized-cookies=${cookieState.length > 0 ? cookieState.join(", ") : "none"}`);
  }
}

async function submitLogin(context: BrowserContext, userId: string, userPassword: string): Promise<void> {
  await withRetries(
    async () => {
      const warmupHeaders = buildBaseRequestHeaders();
      await context.request.get(`${baseUrl}/`, { headers: warmupHeaders });
      await context.request.get(`${baseUrl}/user.do?method=login`, { headers: warmupHeaders });

      const { modulus, exponent } = await getRsaKey(context);
      const encryptedUserId = rsaEncryptToHex(userId, modulus, exponent);
      const encryptedPassword = rsaEncryptToHex(userPassword, modulus, exponent);

      const loginHeaders = buildBaseRequestHeaders();
      loginHeaders["Content-Type"] = "application/x-www-form-urlencoded";
      loginHeaders.Origin = baseUrl;
      loginHeaders.Referer = `${baseUrl}/user.do?method=login`;

      const loginResponse = await context.request.post(`${baseUrl}/login/securityLoginCheck.do`, {
        headers: loginHeaders,
        form: {
          userId: encryptedUserId,
          userPswdEncn: encryptedPassword,
          inpUserId: userId
        }
      });
      logAuthDebug(`login-check status=${loginResponse.status()} ok=${loginResponse.ok()}`);

      if (!loginResponse.ok()) {
        throw new Error(`securityLoginCheck failed. status=${loginResponse.status()}`);
      }

      const responseText = await loginResponse.text();
      const errorMessageMatch = responseText.match(/const\s+errorMessage\s*=\s*'([^']*)';/);
      if (errorMessageMatch?.[1]) {
        const mismatch = errorMessageMatch[1].includes("아이디 또는 비밀번호");
        if (mismatch) {
          logAuthDebug("rsa-login mismatch detected; trying fallback page flow");
          await submitLoginViaPageFlow(context, userId, userPassword);
          return;
        }
        throw new Error(`Login failed: ${errorMessageMatch[1]}`);
      }

      await normalizeAuthCookies(context);
      await context.request.get(`${baseUrl}/main`, { headers: buildBaseRequestHeaders() }).catch(() => undefined);
    },
    5,
    2000
  );
}

export async function getUserBalance(context: BrowserContext): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await context.request.get(`${baseUrl}/mypage/home`, { headers: buildBaseRequestHeaders() }).catch(() => undefined);

      const headers = buildBaseRequestHeaders();
      headers.Referer = `${baseUrl}/mypage/home`;
      headers["X-Requested-With"] = "XMLHttpRequest";
      headers["Content-Type"] = "application/json;charset=UTF-8";
      headers.Accept = "application/json, text/javascript, */*; q=0.01";
      headers.requestMenuUri = "/mypage/home";
      headers.AJAX = "true";
      headers["Sec-Fetch-Mode"] = "cors";
      headers["Sec-Fetch-Site"] = "same-origin";
      headers["Sec-Fetch-Dest"] = "empty";

      const response = await context.request.get(`${baseUrl}/mypage/selectUserMndp.do?_=${Date.now()}`, { headers });
      logAuthDebug(`balance-request status=${response.status()} ok=${response.ok()} attempt=${attempt}`);

      if (!response.ok()) {
        if (response.status() === 401) {
          throw new Error("Balance check unauthorized (401).");
        }
        throw new Error(`Balance check request failed. status=${response.status()}`);
      }

      const text = (await response.text()).trim();
      if (text.length === 0) {
        throw new Error("Balance check returned an empty response.");
      }

      if (text.startsWith("<")) {
        throw new Error("Balance check returned HTML. Login session may be invalid.");
      }

      const payload = JSON.parse(text) as { data?: { userMndp?: { totalAmt?: string | number } } };
      const totalAmount = payload.data?.userMndp?.totalAmt ?? 0;
      const normalizedAmount = Number(String(totalAmount).replaceAll(",", ""));
      if (!Number.isFinite(normalizedAmount)) {
        return "0원";
      }
      return `${normalizedAmount.toLocaleString("ko-KR")}원`;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(1000);
      }
    }
  }

  if (lastError instanceof Error && lastError.message.includes("401")) {
    throw new Error(
      "Balance check unauthorized (401). 로그인 세션이 만들어지지 않았거나, 실행 환경 접근이 차단된 상태일 수 있습니다."
    );
  }
  throw new Error(`Balance check failed after retries: ${String(lastError)}`);
}

export async function loginToDhlottery(context: BrowserContext, options: LoginOptions): Promise<void> {
  // 로그인 전체 시퀀스:
  // 1) /login 페이지에서 실제 입력/클릭
  // 2) 사이트 JS가 생성한 인증 쿠키 정규화
  // 3) (선택) 잔액 API로 로그인 유효성 최종 확인
  await submitLogin(context, options.userId, options.userPassword);
  if (options.validateWithBalance ?? true) {
    await getUserBalance(context);
  }
}

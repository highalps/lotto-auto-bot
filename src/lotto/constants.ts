export const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const browserFingerprint = {
  locale: "ko-KR",
  timezoneId: "Asia/Seoul",
  viewport: {
    width: 1280,
    height: 720
  },
  deviceScaleFactor: 1,
  extraHTTPHeaders: {
    "Accept-Language": "ko-KR,ko;q=0.9"
  }
} as const;

export const baseUrl = "https://www.dhlottery.co.kr";
export const lotto645Url = "https://ol.dhlottery.co.kr";
export const elotteryUrl = "https://el.dhlottery.co.kr";
export const lottoSlots = ["A", "B", "C", "D", "E"] as const;

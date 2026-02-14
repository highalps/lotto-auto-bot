import type { BrowserContext } from "playwright";
import { baseUrl, userAgent } from "./constants.js";

export type LedgerItem = {
  eltOrdrDt: string;
  ltGdsCd: string;
  ltGdsNm: string;
  ltEpsdView: string | number;
  gmInfo: string | null;
  prchsQty: number;
  ltWnResult: string;
  ltWnAmt: number | null;
  epsdRflDt: string | null;
  ntslOrdrNo: string | null;
  wnRnk: number | null;
  lramSmamTypeCd: string | null;
};

type LedgerResponse = {
  data?: {
    total?: number;
    list?: LedgerItem[];
  };
};

export async function selectMyLotteryledger(
  context: BrowserContext,
  options: {
    fromYmd: string;
    toYmd: string;
    ltGdsCd: "LO40" | "LP72";
    pageNum?: number;
    recordCountPerPage?: number;
  }
): Promise<{ total: number; list: LedgerItem[] }> {
  const pageNum = options.pageNum ?? 1;
  const recordCountPerPage = options.recordCountPerPage ?? 100;
  const query = new URLSearchParams({
    srchStrDt: options.fromYmd,
    srchEndDt: options.toYmd,
    sort: "",
    ltGdsCd: options.ltGdsCd,
    winResult: "",
    lramSmam: "",
    pageNum: String(pageNum),
    recordCountPerPage: String(recordCountPerPage),
    _: String(Date.now())
  });

  const response = await context.request.get(`${baseUrl}/mypage/selectMyLotteryledger.do?${query.toString()}`, {
    headers: {
      "User-Agent": userAgent,
      Referer: `${baseUrl}/mypage/mylotteryledger`,
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript, */*; q=0.01",
      AJAX: "true"
    }
  });

  if (!response.ok()) {
    throw new Error(`selectMyLotteryledger request failed. status=${response.status()}`);
  }

  const payload = (await response.json()) as LedgerResponse;
  return {
    total: payload.data?.total ?? 0,
    list: payload.data?.list ?? []
  };
}

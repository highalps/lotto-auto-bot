import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext } from "playwright";
import {
  buildLottoPickParam, buyLotto645, buyLotto645Auto, calculateFallbackRound, resolveSalesRound
} from "../src/lotto/lotto645.js";

test("sales round rolls over at Sunday midnight in Korea", () => {
  assert.equal(calculateFallbackRound(new Date("2026-09-26T14:59:59Z")), 1243);
  assert.equal(calculateFallbackRound(new Date("2026-09-26T15:00:00Z")), 1244);
  assert.equal(calculateFallbackRound(new Date("2026-10-03T14:59:59Z")), 1244);
});

test("stale purchase-page round cannot override the current sales round", () => {
  const sunday = new Date("2026-09-27T03:00:00Z");
  assert.equal(resolveSalesRound("1243", "1243", sunday), "1244");
  assert.equal(resolveSalesRound("1243", null, sunday), "1244");
  assert.equal(resolveSalesRound("1244", "1243", sunday), "1244");
});

test("Sunday purchase sends the round after the latest draw", async () => {
  const expectedRound = calculateFallbackRound();
  const latestDrawRound = String(expectedRound - 1);
  let submittedRound = "";
  const context = {
    request: {
      get: async (url: string) => {
        if (url.includes("common.do?method=main")) {
          return {
            ok: () => true,
            text: async () => `<strong id="lottoDrwNo">${latestDrawRound}</strong>`
          };
        }

        return {
          ok: () => true,
          text: async () =>
            '<input id="ROUND_DRAW_DATE" value="2026-10-03">' +
            '<input id="WAMT_PAY_TLMT_END_DT" value="2027-10-04">' +
            `<input id="curRound" value="${latestDrawRound}">`
        };
      },
      post: async (url: string, options?: { form?: { round?: string } }) => {
        if (url.endsWith("egovUserReadySocket.json")) {
          return { ok: () => true, json: async () => ({ ready_ip: "fixture" }) };
        }

        submittedRound = options?.form?.round ?? "";
        return {
          ok: () => true,
          json: async () => ({ loginYn: "Y", result: { resultMsg: "SUCCESS" } })
        };
      }
    }
  } as unknown as BrowserContext;

  await buyLotto645Auto(context, { gameCount: 1 });
  assert.equal(submittedRound, String(expectedRound));
});

test("manual and automatic games are serialized in one purchase request", async () => {
  assert.equal(buildLottoPickParam([
    { mode: "manual", numbers: [42, 3, 34, 11, 27, 19] },
    { mode: "auto" }, { mode: "auto" }, { mode: "auto" }, { mode: "auto" }
  ]), JSON.stringify([
    { genType: "1", arrGameChoiceNum: "3,11,19,27,34,42", alpabet: "A" },
    { genType: "0", arrGameChoiceNum: null, alpabet: "B" },
    { genType: "0", arrGameChoiceNum: null, alpabet: "C" },
    { genType: "0", arrGameChoiceNum: null, alpabet: "D" },
    { genType: "0", arrGameChoiceNum: null, alpabet: "E" }
  ]));
});

test("mixed purchase sends the correct count, amount and parameter", async () => {
  let submittedForm: Record<string, string> | undefined;
  const context = {
    request: {
      get: async (url: string) => ({
        ok: () => true,
        text: async () => url.includes("common.do")
          ? '<strong id="lottoDrwNo">1243</strong>'
          : '<input id="ROUND_DRAW_DATE" value="2026-10-03"><input id="WAMT_PAY_TLMT_END_DT" value="2027-10-04"><input id="curRound" value="1244">'
      }),
      post: async (url: string, options?: { form?: Record<string, string> }) => {
        if (url.endsWith("egovUserReadySocket.json")) {
          return { ok: () => true, json: async () => ({ ready_ip: "fixture" }) };
        }
        submittedForm = options?.form;
        return { ok: () => true, json: async () => ({ loginYn: "Y", result: { resultMsg: "SUCCESS" } }) };
      }
    }
  } as unknown as BrowserContext;

  const games = [
    { mode: "manual" as const, numbers: [3, 11, 19, 27, 34, 42] },
    { mode: "auto" as const }, { mode: "auto" as const }, { mode: "auto" as const }, { mode: "auto" as const }
  ];
  await buyLotto645(context, { games });
  assert.equal(submittedForm?.gameCnt, "5");
  assert.equal(submittedForm?.nBuyAmount, "5000");
  assert.equal(submittedForm?.param, buildLottoPickParam(games));
});

test("invalid manual games fail before sending a request", async () => {
  let requested = false;
  const context = { request: { get: async () => { requested = true; }, post: async () => { requested = true; } } } as unknown as BrowserContext;
  await assert.rejects(buyLotto645(context, {
    games: [{ mode: "manual", numbers: [1, 1, 2, 3, 4, 5] }]
  }), /unique integers/);
  assert.equal(requested, false);
});

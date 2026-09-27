import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext } from "playwright";
import { buyLotto645Auto, calculateFallbackRound, resolveSalesRound } from "../src/lotto/lotto645.js";

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

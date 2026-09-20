import assert from "node:assert/strict";
import test from "node:test";
import { guardedPurchase, purchaseRange, retryRead } from "../src/lotto/purchase-policy.js";
import { buyLotto645Auto } from "../src/lotto/lotto645.js";
import type { BrowserContext } from "playwright";

const pause = async () => {};

test("lotto payment timeout is marked submitted and sent exactly once", async () => {
  let payments = 0;
  let submitted = false;
  const context = { request: {
    post: async (url: string) => {
      if (url.endsWith("execBuy.do")) {
        assert.equal(submitted, true);
        payments++;
        throw new Error("Timeout");
      }
      return { ok: () => true, json: async () => ({ ready_ip: "fixture" }) };
    },
    get: async () => ({ ok: () => true, text: async () =>
      '<input id="ROUND_DRAW_DATE" value="2026-09-26"><input id="WAMT_PAY_TLMT_END_DT" value="2027-09-26"><input id="curRound" value="1234">'
    })
  } } as unknown as BrowserContext;
  await assert.rejects(buyLotto645Auto(context, { gameCount: 5, onSubmit: () => { submitted = true; } }), /Timeout/);
  assert.equal(payments, 1);
});

test("purchase cycles use KST and roll over separately for each product", () => {
  assert.deepEqual(purchaseRange("LO40", new Date("2026-09-19T14:59:59Z")), { fromYmd: "20260913", toYmd: "20260919" });
  assert.deepEqual(purchaseRange("LO40", new Date("2026-09-19T15:00:00Z")), { fromYmd: "20260920", toYmd: "20260920" });
  assert.deepEqual(purchaseRange("LP72", new Date("2026-09-17T15:00:00Z")), { fromYmd: "20260918", toYmd: "20260918" });
  assert.deepEqual(purchaseRange("LP72", new Date("2026-09-17T14:59:59Z")), { fromYmd: "20260911", toYmd: "20260917" });
  assert.deepEqual(purchaseRange("LO40", new Date("2027-01-01T03:00:00Z")), { fromYmd: "20261227", toYmd: "20270101" });
});

test("existing manual purchase skips without making a payment", async () => {
  const result = await guardedPurchase({ hasPurchase: async () => true, buy: async () => assert.fail("must skip"), pause });
  assert.equal(result.status, "SKIPPED");
});

test("pre-payment timeouts retry twice then succeed", async () => {
  let calls = 0;
  const result = await guardedPurchase({ hasPurchase: async () => false, pause, buy: async () => {
    if (++calls < 3) throw new Error("Timeout 30000ms exceeded");
    return "order";
  } });
  assert.equal(calls, 3);
  assert.equal(result.response, "order");
});

test("persistent timeouts stop after three attempts", async () => {
  let calls = 0;
  await assert.rejects(guardedPurchase({ hasPurchase: async () => false, pause, buy: async () => {
    calls++; throw new Error("Timed out");
  } }), /Timed out/);
  assert.equal(calls, 3);
});

test("post-payment timeout recovers from ledger without resending payment", async () => {
  let reads = 0;
  let payments = 0;
  const result = await guardedPurchase({ hasPurchase: async () => ++reads >= 3, pause, buy: async mark => {
    payments++; mark(); throw new Error("Timeout");
  } });
  assert.equal(result.status, "RECOVERED");
  assert.equal(payments, 1);
});

test("unconfirmed payment is not retried even when ledger remains empty", async () => {
  let payments = 0;
  await assert.rejects(guardedPurchase({ hasPurchase: async () => false, pause, buy: async mark => {
    payments++; mark(); throw new Error("Timeout");
  } }), /unconfirmed/);
  assert.equal(payments, 1);
});

test("ledger failures block buying and retry only transient reads", async () => {
  let reads = 0;
  await assert.rejects(guardedPurchase({ pause, hasPurchase: async () => {
    reads++; throw new Error("Timeout");
  }, buy: async () => assert.fail("must not buy") }), /Timeout/);
  assert.equal(reads, 3);
  let attempts = 0;
  await assert.rejects(retryRead(async () => { attempts++; throw new Error("Invalid credentials"); }, pause));
  assert.equal(attempts, 1);
});

test("each product independently skips or purchases in BOTH mode", async () => {
  const lotto = await guardedPurchase({ hasPurchase: async () => true, buy: async () => assert.fail(), pause });
  const pension = await guardedPurchase({ hasPurchase: async () => false, buy: async () => "pension-order", pause });
  assert.equal(lotto.status, "SKIPPED");
  assert.equal(pension.status, "PURCHASED");
});

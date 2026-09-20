import assert from "node:assert/strict";
import test from "node:test";
import { getPurchasedGameCount, selectMyLotteryledger } from "../src/lotto/ledger.js";
import type { BrowserContext } from "playwright";

test("counts games within a single lottery order", () => {
  assert.equal(getPurchasedGameCount([{ prchsQty: 5 }]), 5);
});

test("sums game quantities across multiple orders", () => {
  assert.equal(getPurchasedGameCount([{ prchsQty: 5 }, { prchsQty: 2 }]), 7);
});

test("ignores invalid game quantities", () => {
  assert.equal(getPurchasedGameCount([{ prchsQty: 0 }, { prchsQty: Number.NaN }, { prchsQty: 3 }]), 3);
});

test("missing ledger data must not be treated as no purchases", async () => {
  const context = { request: { get: async () => ({
    ok: () => true, status: () => 200, json: async () => ({ error: "Login expired" })
  }) } } as unknown as BrowserContext;
  await assert.rejects(selectMyLotteryledger(context, {
    fromYmd: "20260920", toYmd: "20260920", ltGdsCd: "LO40"
  }), /could not be verified/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { getPurchasedGameCount } from "../src/lotto/ledger.js";

test("counts games within a single lottery order", () => {
  assert.equal(getPurchasedGameCount([{ prchsQty: 5 }]), 5);
});

test("sums game quantities across multiple orders", () => {
  assert.equal(getPurchasedGameCount([{ prchsQty: 5 }, { prchsQty: 2 }]), 7);
});

test("ignores invalid game quantities", () => {
  assert.equal(getPurchasedGameCount([{ prchsQty: 0 }, { prchsQty: Number.NaN }, { prchsQty: 3 }]), 3);
});

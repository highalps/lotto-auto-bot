import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPurchaseConfig, PurchaseConfigError } from "../src/purchase-config.js";

async function withConfig(value: unknown, run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "purchase-config-"));
  try {
    await writeFile(join(cwd, "report.json"), JSON.stringify(value));
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const mixed = {
  version: 2,
  defaults: { range: { days: 7 } },
  purchase: {
    enabled: true,
    lotto645: { enabled: true, games: [
      { mode: "manual", numbers: [42, 3, 34, 11, 27, 19] },
      { mode: "auto", count: 4 }
    ] },
    pension720: { enabled: false, count: 1 }
  }
};

test("version 2 expands a manual 1 + auto 4 purchase plan", async () => {
  await withConfig(mixed, async (cwd) => {
    const config = await loadPurchaseConfig({ cwd, configPath: "report.json", env: {
      LOTTO_COUNT: "1", LOTTO_BUY_MODE: "PENSION_ONLY"
    } });
    assert.equal(config.source, "file");
    assert.equal(config.lotto645.games.length, 5);
    assert.deepEqual(config.lotto645.games[0], { mode: "manual", numbers: [3, 11, 19, 27, 34, 42] });
    assert.deepEqual(config.lotto645.games.slice(1), Array.from({ length: 4 }, () => ({ mode: "auto" })));
  });
});

test("version 1 without purchase falls back to legacy environment variables", async () => {
  await withConfig({ version: 1, defaults: {} }, async (cwd) => {
    const config = await loadPurchaseConfig({ cwd, configPath: "report.json", env: {
      LOTTO_BUY_MODE: "BOTH", LOTTO_COUNT: "2", PENSION_COUNT: "3"
    } });
    assert.equal(config.source, "env");
    assert.equal(config.lotto645.games.length, 2);
    assert.equal(config.pension720.count, 3);
  });
});

test("invalid purchase config never falls back to environment variables", async () => {
  const invalid = [
    { ...mixed, version: 1 },
    { ...mixed, purchase: { ...mixed.purchase, extra: true } },
    { ...mixed, purchase: { ...mixed.purchase, lotto645: { enabled: true, games: [] } } },
    { ...mixed, purchase: { ...mixed.purchase, lotto645: { enabled: true, games: [{ mode: "auto", count: 6 }] } } },
    { ...mixed, purchase: { ...mixed.purchase, lotto645: { enabled: true, games: [{ mode: "manual", numbers: [1, 1, 2, 3, 4, 5] }] } } }
  ];
  for (const value of invalid) {
    await withConfig(value, async (cwd) => {
      await assert.rejects(loadPurchaseConfig({ cwd, configPath: "report.json", env: {
        LOTTO_BUY_MODE: "LOTTO_ONLY", LOTTO_COUNT: "5"
      } }), PurchaseConfigError);
    });
  }
});

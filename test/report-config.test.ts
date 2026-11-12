import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadReportConfig, ReportConfigError } from "../src/report-config.js";

const now = new Date("2026-11-12T15:00:00Z");

async function withFile(value: unknown, run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "report-config-"));
  try {
    await writeFile(join(cwd, "report.json"), JSON.stringify(value));
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("legacy environment aliases and KST default range work without a file", async () => {
  for (const alias of ["lotto365", "LOTTO645", "lotto", "LO40"]) {
    const config = await loadReportConfig({ env: { CHECK_TARGET: alias }, now });
    assert.equal(config.target, "LO40");
    assert.equal(config.fromYmd, "20261106");
    assert.equal(config.toYmd, "20261113");
    assert.deepEqual(config.sources, { target: "env", range: "builtin" });
  }
  for (const alias of ["pension", "pension720", "LP72"]) {
    assert.equal((await loadReportConfig({ env: { CHECK_TARGET: alias }, now })).target, "LP72");
  }
});

test("precedence is defaults < profile < env < CLI, with provenance", async () => {
  await withFile({ version: 1, defaults: { target: "lotto365", range: { days: 30 } },
    defaultProfile: "weekly", profiles: { weekly: { target: "pension", range: { days: 7 } } }
  }, async (cwd) => {
    const options = { cwd, now, env: {}, argv: ["--config", "report.json"] };
    const base = await loadReportConfig(options);
    assert.equal(base.target, "LP72");
    assert.equal(base.sources.target, "profile");
    const env = { CHECK_TARGET: "lotto365", CHECK_FROM_YMD: "20240229", CHECK_TO_YMD: "20240301" };
    const overridden = await loadReportConfig({ ...options, env });
    assert.equal(overridden.target, "LO40");
    assert.equal(overridden.fromYmd, "20240229");
    assert.equal(overridden.sources.range, "env");
    const cli = await loadReportConfig({ ...options, env, argv: [...options.argv, "--target", "pension", "--from", "20260101", "--to", "20260102"] });
    assert.equal(cli.target, "LP72");
    assert.equal(cli.fromYmd, "20260101");
    assert.equal(cli.sources.range, "cli");
  });
});

test("profile range replaces the entire default range", async () => {
  await withFile({ version: 1, defaults: { target: "lotto365", range: { from: "20240101", to: "20240131" } },
    profiles: { recent: { range: { days: 1 } } }
  }, async (cwd) => {
    const config = await loadReportConfig({ cwd, now, env: { CHECK_CONFIG_PATH: "report.json", CHECK_PROFILE: "recent" } });
    assert.equal(config.fromYmd, "20261112");
    assert.equal(config.toYmd, "20261113");
  });
});

test("CLI selects a profile above the environment and file default", async () => {
  await withFile({ version: 1, defaultProfile: "a", profiles: {
    a: { target: "lotto365" }, b: { target: "pension" }
  } }, async (cwd) => {
    const config = await loadReportConfig({ cwd, now, env: { CHECK_CONFIG_PATH: "report.json", CHECK_PROFILE: "a" }, argv: ["--profile", "b"] });
    assert.equal(config.profile, "b");
    assert.equal(config.target, "LP72");
  });
});

test("invalid dates and partial/reversed ranges fail before any IO to a service", async () => {
  for (const [from, to] of [["20260229", "20260301"], ["20261301", "20261302"], ["20260431", "20260501"], ["20260102", "20260101"], ["20260101", ""], ["", "20260101"]]) {
    await assert.rejects(loadReportConfig({ env: { CHECK_TARGET: "lotto365", CHECK_FROM_YMD: from, CHECK_TO_YMD: to }, now }), ReportConfigError);
  }
});

test("a partial CLI range cannot silently combine with environment dates", async () => {
  await assert.rejects(loadReportConfig({ env: { CHECK_TARGET: "lotto365", CHECK_FROM_YMD: "20260101", CHECK_TO_YMD: "20260131" }, argv: ["--from", "20260102"] }), /same source/);
});

test("strict file validation includes unused profiles", async () => {
  for (const value of [null, [], { version: 3 }, { version: 1, password: "secret" },
    { version: 1, defaults: { taget: "lotto365" } },
    { version: 1, defaults: { range: { days: 0 } } },
    { version: 1, defaults: { range: { days: "7" } } },
    { version: 1, defaults: { range: { days: 7, from: "20260101", to: "20260131" } } },
    { version: 1, profiles: { unused: { target: "bad" } } },
    { version: 1, defaultProfile: "missing" },
    { version: 1, defaults: { resultPath: "" } }
  ]) {
    await withFile(value, async (cwd) => {
      await assert.rejects(loadReportConfig({ cwd, env: { CHECK_TARGET: "lotto365" }, argv: ["--config", "report.json"] }), ReportConfigError);
    });
  }
});

test("version 2 report config accepts and validates purchase settings", async () => {
  const value = {
    version: 2,
    defaults: { target: "lotto365" },
    purchase: {
      enabled: true,
      lotto645: { enabled: true, games: [{ mode: "auto", count: 5 }] },
      pension720: { enabled: false, count: 1 }
    }
  };
  await withFile(value, async (cwd) => {
    assert.equal((await loadReportConfig({ cwd, argv: ["--config", "report.json"], env: {}, now })).target, "LO40");
  });
  await withFile({ ...value, purchase: { ...value.purchase, lotto645: { enabled: true, games: [] } } }, async (cwd) => {
    await assert.rejects(loadReportConfig({ cwd, argv: ["--config", "report.json"], env: {}, now }), ReportConfigError);
  });
});

test("missing target, missing profile, unknown/repeated/missing arguments fail", async () => {
  for (const argv of [[], ["--profile", "missing"], ["--unknown", "x"], ["--target"], ["--target", "pension", "--target", "lotto365"]]) {
    await assert.rejects(loadReportConfig({ argv, env: {} }), ReportConfigError);
  }
});

test("missing and malformed files fail without exposing their contents", async () => {
  await withFile({}, async (cwd) => {
    await assert.rejects(loadReportConfig({ cwd, env: {}, argv: ["--config", "missing.json"] }), /Cannot read/);
    await writeFile(join(cwd, "report.json"), '{"password":"DO-NOT-PRINT"');
    await assert.rejects(loadReportConfig({ cwd, env: {}, argv: ["--config", "report.json"] }), (error: unknown) => {
      assert.ok(error instanceof ReportConfigError);
      assert.equal(error.message, "Report config file must contain valid JSON.");
      return true;
    });
  });
});

test("paths resolve relative to working directory and secrets are excluded", async () => {
  const config = await loadReportConfig({ env: { CHECK_TARGET: "lotto365", CHECK_RESULT_PATH: "result.json", LOTTO_USER_PASSWORD: "DO-NOT-PRINT" }, now });
  assert.equal(config.resultPath, resolve("result.json"));
  assert.ok(!JSON.stringify(config).includes("DO-NOT-PRINT"));
});

test("preview runs without credentials or a browser and does not write result files", async () => {
  await withFile({ version: 1, defaults: { target: "lotto365", resultPath: "result.json" } }, async (cwd) => {
    const env = { ...process.env, DOTENV_CONFIG_PATH: join(cwd, "absent.env") };
    for (const key of Object.keys(env)) {
      if (key.startsWith("CHECK_") || key.startsWith("LOTTO_")) delete env[key];
    }
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/preview-report-config.ts", "--config", join(cwd, "report.json"), "--result-path", join(cwd, "result.json")], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).target, "LO40");
    await assert.rejects(access(join(cwd, "result.json")));
    const invalid = spawnSync(process.execPath, ["--import", "tsx", "src/preview-report-config.ts", "--target", "invalid"], { env, encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
  });
});

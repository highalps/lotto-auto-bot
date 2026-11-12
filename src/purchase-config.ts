import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { LottoGame } from "./lotto/types.js";

export class PurchaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseConfigError";
  }
}

export type PurchasePlan = {
  enabled: boolean;
  lotto645: { enabled: boolean; games: LottoGame[] };
  pension720: { enabled: boolean; count: number };
};

export type ResolvedPurchaseConfig = PurchasePlan & {
  source: "file" | "env";
  configPath?: string;
};

function fail(message: string): never {
  throw new PurchaseConfigError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported) fail(`${label} contains an unsupported key: ${unsupported}. Allowed: ${allowed.join(", ")}.`);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be a boolean.`);
  return value;
}

function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 5) {
    fail(`${label} must be an integer between 1 and 5.`);
  }
  return value;
}

function manualNumbers(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length !== 6) fail(`${label} must contain exactly 6 numbers.`);
  if (value.some((number) => typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || number > 45)) {
    fail(`${label} must contain integers between 1 and 45.`);
  }
  const numbers = value as number[];
  if (new Set(numbers).size !== 6) fail(`${label} must not contain duplicate numbers.`);
  return [...numbers].sort((left, right) => left - right);
}

function lottoGames(value: unknown): LottoGame[] {
  if (!Array.isArray(value)) fail("purchase.lotto645.games must be an array.");
  const games: LottoGame[] = [];
  value.forEach((entry, index) => {
    const label = `purchase.lotto645.games[${index}]`;
    const record = object(entry, label);
    if (record.mode === "auto") {
      keys(record, ["mode", "count"], label);
      const gameCount = count(record.count, `${label}.count`);
      games.push(...Array.from({ length: gameCount }, (): LottoGame => ({ mode: "auto" })));
      return;
    }
    if (record.mode === "manual") {
      keys(record, ["mode", "numbers"], label);
      games.push({ mode: "manual", numbers: manualNumbers(record.numbers, `${label}.numbers`) });
      return;
    }
    fail(`${label}.mode must be auto or manual.`);
  });
  if (games.length > 5) fail("purchase.lotto645.games expands to more than 5 games.");
  return games;
}

/** Parses and strictly validates the version 2 purchase section. */
export function parsePurchaseSection(value: unknown): PurchasePlan {
  const purchase = object(value, "purchase");
  keys(purchase, ["enabled", "lotto645", "pension720"], "purchase");
  const lotto = object(purchase.lotto645, "purchase.lotto645");
  keys(lotto, ["enabled", "games"], "purchase.lotto645");
  const pension = object(purchase.pension720, "purchase.pension720");
  keys(pension, ["enabled", "count"], "purchase.pension720");

  const plan: PurchasePlan = {
    enabled: boolean(purchase.enabled, "purchase.enabled"),
    lotto645: {
      enabled: boolean(lotto.enabled, "purchase.lotto645.enabled"),
      games: lottoGames(lotto.games)
    },
    pension720: {
      enabled: boolean(pension.enabled, "purchase.pension720.enabled"),
      count: count(pension.count, "purchase.pension720.count")
    }
  };
  if (plan.lotto645.enabled && plan.lotto645.games.length === 0) {
    fail("purchase.lotto645.games must contain between 1 and 5 games when lotto645 is enabled.");
  }
  return plan;
}

type BuyMode = "STOP" | "LOTTO_ONLY" | "PENSION_ONLY" | "BOTH";

export function readBuyMode(value: string | undefined): BuyMode {
  const normalized = (value ?? "LOTTO_ONLY").trim().toUpperCase();
  const aliases: Record<string, BuyMode> = {
    STOP: "STOP", NONE: "STOP", LOTTO_ONLY: "LOTTO_ONLY", LOTTO: "LOTTO_ONLY",
    PENSION_ONLY: "PENSION_ONLY", PENSION: "PENSION_ONLY", BOTH: "BOTH", ALL: "BOTH"
  };
  return aliases[normalized] ?? fail(
    "LOTTO_BUY_MODE must be one of STOP | LOTTO_ONLY | PENSION_ONLY | BOTH (aliases: NONE | LOTTO | PENSION | ALL)."
  );
}

function envCount(env: NodeJS.ProcessEnv, name: string, fallback: string): number {
  const raw = env[name]?.trim() || fallback;
  return count(Number(raw), name);
}

function legacyPlan(env: NodeJS.ProcessEnv): ResolvedPurchaseConfig {
  const mode = readBuyMode(env.LOTTO_BUY_MODE);
  const lottoCount = envCount(env, "LOTTO_COUNT", "5");
  const pensionCount = envCount(env, "PENSION_COUNT", "1");
  return {
    source: "env",
    enabled: mode !== "STOP",
    lotto645: {
      enabled: mode === "LOTTO_ONLY" || mode === "BOTH",
      games: Array.from({ length: lottoCount }, (): LottoGame => ({ mode: "auto" }))
    },
    pension720: {
      enabled: mode === "PENSION_ONLY" || mode === "BOTH",
      count: pensionCount
    }
  };
}

/** Uses purchase from config when present; otherwise falls back to the legacy environment variables. */
export async function loadPurchaseConfig(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  configPath?: string;
} = {}): Promise<ResolvedPurchaseConfig> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configuredPath = options.configPath ?? env.PURCHASE_CONFIG_PATH?.trim() ?? "config/report.json";
  const configPath = resolve(cwd, configuredPath);
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (options.configPath || env.PURCHASE_CONFIG_PATH?.trim()) {
      fail("Cannot read purchase config file. Check PURCHASE_CONFIG_PATH.");
    }
    return legacyPlan(env);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch {
    fail("Purchase config file must contain valid JSON.");
  }
  const config = object(parsed, "config");
  keys(config, ["version", "defaults", "profiles", "defaultProfile", "purchase"], "config");
  if (config.version !== 1 && config.version !== 2) fail("config.version must be 1 or 2.");
  if (!("purchase" in config)) return legacyPlan(env);
  if (config.version !== 2) fail("config.version must be 2 when purchase is present.");
  return { source: "file", configPath, ...parsePurchaseSection(config.purchase) };
}

export function describeLottoGames(games: LottoGame[]): string {
  const manual = games.filter((game) => game.mode === "manual").length;
  const auto = games.length - manual;
  return [manual ? `수동 ${manual}게임` : "", auto ? `자동 ${auto}게임` : ""].filter(Boolean).join(" + ");
}

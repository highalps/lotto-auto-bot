import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parsePurchaseSection, PurchaseConfigError } from "./purchase-config.js";

export class ReportConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportConfigError";
  }
}

export type CheckTarget = "LO40" | "LP72";
type Range = { days: number } | { from: string; to: string };
type Settings = { target?: CheckTarget; range?: Range; resultPath?: string };
type ConfigFile = {
  defaults: Settings;
  profiles: Map<string, Settings>;
  defaultProfile?: string;
};
type Source = "builtin" | "file" | "profile" | "env" | "cli";

export type ReportConfig = {
  target: CheckTarget;
  fromYmd: string;
  toYmd: string;
  resultPath?: string;
  configPath?: string;
  profile?: string;
  sources: { target?: Source; range: Source; resultPath?: Source };
};

function fail(message: string): never {
  throw new ReportConfigError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    fail(`${label} contains an unsupported key. Allowed: ${allowed.join(", ")}.`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string.`);
  return value.trim();
}

function target(value: unknown): CheckTarget {
  const raw = text(value, "target").toLowerCase();
  if (["lotto365", "lotto645", "lotto", "lo40"].includes(raw)) return "LO40";
  if (["pension", "pension720", "lp72"].includes(raw)) return "LP72";
  return fail("target must be lotto365 or pension (legacy aliases are supported).");
}

function date(value: unknown, label: string): string {
  const raw = text(value, label);
  if (!/^\d{8}$/.test(raw)) fail(`${label} must be a valid YYYYMMDD date.`);
  const parsed = new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10).replaceAll("-", "") !== raw) {
    fail(`${label} must be a valid YYYYMMDD date.`);
  }
  return raw;
}

function range(value: unknown, label: string): Range {
  const record = object(value, label);
  keys(record, ["days", "from", "to"], label);
  if ("days" in record) {
    if ("from" in record || "to" in record) fail(`${label}: days cannot be combined with from/to.`);
    if (typeof record.days !== "number" || !Number.isSafeInteger(record.days) || record.days < 1 || record.days > 3660) {
      fail(`${label}.days must be an integer between 1 and 3660.`);
    }
    return { days: record.days };
  }
  const from = date(record.from, `${label}.from`);
  const to = date(record.to, `${label}.to`);
  if (from > to) fail(`${label}.from must be less than or equal to to.`);
  return { from, to };
}

function settings(value: unknown, label: string): Settings {
  const record = object(value, label);
  keys(record, ["target", "range", "resultPath"], label);
  return {
    ...("target" in record ? { target: target(record.target) } : {}),
    ...("range" in record ? { range: range(record.range, `${label}.range`) } : {}),
    ...("resultPath" in record ? { resultPath: text(record.resultPath, `${label}.resultPath`) } : {})
  };
}

function parseFile(value: unknown): ConfigFile {
  const record = object(value, "config");
  keys(record, ["version", "defaults", "profiles", "defaultProfile", "purchase"], "config");
  if (record.version !== 1 && record.version !== 2) fail("config.version must be 1 or 2.");
  if ("purchase" in record) {
    if (record.version !== 2) fail("config.version must be 2 when purchase is present.");
    try {
      parsePurchaseSection(record.purchase);
    } catch (error) {
      if (error instanceof PurchaseConfigError) fail(error.message);
      throw error;
    }
  }
  const profiles = new Map<string, Settings>();
  if ("profiles" in record) {
    for (const [name, value] of Object.entries(object(record.profiles, "profiles"))) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) fail("Profile names must use letters, numbers, underscores or hyphens.");
      profiles.set(name, settings(value, `profiles.${name}`));
    }
  }
  const defaultProfile = "defaultProfile" in record ? text(record.defaultProfile, "defaultProfile") : undefined;
  if (defaultProfile && !profiles.has(defaultProfile)) fail("defaultProfile does not exist in profiles.");
  return { defaults: "defaults" in record ? settings(record.defaults, "defaults") : {}, profiles, defaultProfile };
}

function args(argv: string[]): Record<string, string> {
  const allowed = ["--config", "--profile", "--target", "--from", "--to", "--result-path"];
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!allowed.includes(key)) fail(`Unsupported argument. Allowed: ${allowed.join(", ")}.`);
    if (key in result) fail(`Duplicate argument: ${key}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${key} requires a value.`);
    result[key] = text(value, key);
  }
  return result;
}

function overrides(targetValue?: string, from?: string, to?: string, resultPath?: string): Settings {
  if (Boolean(from) !== Boolean(to)) fail("from/to must be provided together in the same source (CHECK_FROM_YMD/CHECK_TO_YMD or --from/--to).");
  return {
    ...(targetValue ? { target: target(targetValue) } : {}),
    ...(from && to ? { range: range({ from, to }, "range") } : {}),
    ...(resultPath ? { resultPath } : {})
  };
}

function kstYmd(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now).filter((part) => ["year", "month", "day"].includes(part.type))
    .sort((a, b) => ["year", "month", "day"].indexOf(a.type) - ["year", "month", "day"].indexOf(b.type))
    .map((part) => part.value).join("");
}

/** Resolves read-only report settings. Never imports browser, login or purchase modules. */
export async function loadReportConfig(options: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: Date;
} = {}): Promise<ReportConfig> {
  const cli = args(options.argv ?? []);
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const envValue = (name: string): string | undefined => env[name]?.trim() || undefined;
  const fileName = cli["--config"] ?? envValue("CHECK_CONFIG_PATH");
  const configPath = fileName ? resolve(cwd, fileName) : undefined;
  let file: ConfigFile = { defaults: {}, profiles: new Map() };
  if (configPath) {
    let content: string;
    try {
      content = await readFile(configPath, "utf8");
    } catch {
      fail("Cannot read report config file. Check --config or CHECK_CONFIG_PATH.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.replace(/^\uFEFF/, ""));
    } catch {
      fail("Report config file must contain valid JSON.");
    }
    file = parseFile(parsed);
  }
  const profile = cli["--profile"] ?? envValue("CHECK_PROFILE") ?? file.defaultProfile;
  if (profile && !file.profiles.has(profile)) fail("Selected profile does not exist in the report config file.");
  const layers: Array<[Source, Settings]> = [
    ["builtin", { range: { days: 7 } }],
    ["file", file.defaults],
    ["profile", profile ? file.profiles.get(profile)! : {}],
    ["env", overrides(envValue("CHECK_TARGET"), envValue("CHECK_FROM_YMD"), envValue("CHECK_TO_YMD"), envValue("CHECK_RESULT_PATH"))],
    ["cli", overrides(cli["--target"], cli["--from"], cli["--to"], cli["--result-path"])]
  ];
  const merged: Settings = {};
  const sources: ReportConfig["sources"] = { range: "builtin" };
  for (const [source, values] of layers) {
    if (values.target !== undefined) { merged.target = values.target; sources.target = source; }
    if (values.range !== undefined) { merged.range = values.range; sources.range = source; }
    if (values.resultPath !== undefined) { merged.resultPath = values.resultPath; sources.resultPath = source; }
  }
  if (!merged.target) fail("Missing report target. Set target in config, CHECK_TARGET or --target.");
  const selectedRange = merged.range!;
  let fromYmd: string;
  let toYmd: string;
  if ("days" in selectedRange) {
    toYmd = kstYmd(options.now ?? new Date());
    const start = new Date(`${toYmd.slice(0, 4)}-${toYmd.slice(4, 6)}-${toYmd.slice(6, 8)}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - selectedRange.days);
    fromYmd = start.toISOString().slice(0, 10).replaceAll("-", "");
  } else {
    fromYmd = selectedRange.from;
    toYmd = selectedRange.to;
  }
  return {
    target: merged.target, fromYmd, toYmd,
    ...(merged.resultPath ? { resultPath: resolve(cwd, merged.resultPath) } : {}),
    ...(configPath ? { configPath } : {}),
    ...(profile ? { profile } : {}),
    sources
  };
}

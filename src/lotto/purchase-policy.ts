export type Product = "LO40" | "LP72";

export function readDryRun(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error("LOTTO_DRY_RUN must be true or false.");
}

// Each purchase cycle starts after the preceding draw, in Korean local time.
export function purchaseRange(product: Product, now = new Date()) {
  const date = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const ymd = (value: Date) => value.toISOString().slice(0, 10).replaceAll("-", "");
  const toYmd = ymd(date);
  const startDay = product === "LO40" ? 0 : 5;
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() - startDay + 7) % 7);
  return { fromYmd: ymd(date), toYmd };
}

export function isTransient(error: unknown): boolean {
  return /timeout|timed out|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|net::ERR_|status=5\d\d|status=429/i.test(String(error));
}

export async function retryRead<T>(action: () => Promise<T>, pause = delay): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await action(); } catch (error) {
      if (attempt === 3 || !isTransient(error)) throw error;
      console.warn(`[retry] attempt ${attempt}/3 failed; retrying`);
      await pause(attempt * 10000);
    }
  }
}

export const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function guardedPurchase<T>(options: {
  hasPurchase: () => Promise<boolean>;
  buy: (markSubmitted: () => void) => Promise<T>;
  pause?: (ms: number) => Promise<void>;
  dryRun?: boolean;
}): Promise<{ status: "PURCHASED" | "SKIPPED" | "RECOVERED" | "DRY_RUN"; response?: T }> {
  const pause = options.pause ?? delay;
  for (let attempt = 1; ; attempt++) {
    // Fail closed if the ledger cannot be read; never assume that means no purchase.
    if (await retryRead(options.hasPurchase, pause)) return { status: "SKIPPED" };
    if (options.dryRun) return { status: "DRY_RUN" };
    let submitted = false;
    try {
      const response = await options.buy(() => { submitted = true; });
      return { status: "PURCHASED", response };
    } catch (error) {
      if (submitted) {
        for (let check = 0; check < 3; check++) {
          await pause(10000);
          if (await retryRead(options.hasPurchase, pause)) return { status: "RECOVERED" };
        }
        throw new Error(`Purchase outcome is unconfirmed; no payment retry was sent. Check the ledger before rerunning. Cause: ${String(error)}`);
      }
      if (attempt === 3 || !isTransient(error)) throw error;
      console.warn(`[purchase] pre-payment attempt ${attempt}/3 failed; retrying`);
      await pause(attempt * 10000);
    }
  }
}

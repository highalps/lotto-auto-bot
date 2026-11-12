import "dotenv/config";
import { describeLottoGames, loadPurchaseConfig } from "./purchase-config.js";

loadPurchaseConfig().then((config) => {
  console.log(JSON.stringify({
    source: config.source,
    configPath: config.configPath,
    enabled: config.enabled,
    lotto645: {
      enabled: config.lotto645.enabled,
      description: describeLottoGames(config.lotto645.games),
      count: config.lotto645.games.length,
      games: config.lotto645.games
    },
    pension720: config.pension720,
    expectedAmount: (config.lotto645.enabled ? config.lotto645.games.length * 1000 : 0) +
      (config.pension720.enabled ? config.pension720.count * 1000 : 0)
  }, null, 2));
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Purchase config preview failed.");
  process.exitCode = 1;
});

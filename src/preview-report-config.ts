import "dotenv/config";
import { loadReportConfig } from "./report-config.js";

loadReportConfig({ argv: process.argv.slice(2) }).then((config) => {
  console.log(JSON.stringify(config, null, 2));
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Report config preview failed.");
  process.exitCode = 1;
});

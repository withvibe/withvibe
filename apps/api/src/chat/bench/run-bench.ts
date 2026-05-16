import "reflect-metadata";
import "dotenv/config";
import { readFile } from "fs/promises";
import path from "path";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "../../app.module";
import { BenchService } from "./bench.service";
import type { BenchScenario } from "./bench.types";

/**
 * CLI entry: `pnpm bench:chat <scenario.json>`
 *
 * Bootstraps a Nest application context (no HTTP server) so the bench can
 * resolve `BenchService` with all its DI deps wired exactly like the API
 * server does, then runs the scenario, writes the JSON report, and prints
 * a Markdown summary.
 *
 * Exit codes:
 *   0 — every turn produced a `done` event
 *   1 — at least one turn errored (CI-friendly)
 */
async function main() {
  const logger = new Logger("bench-cli");
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error("usage: pnpm bench:chat <scenario.json>");
    process.exit(2);
  }

  const scenarioPath = path.resolve(argv[0]);
  const raw = await readFile(scenarioPath, "utf-8");
  const scenario = JSON.parse(raw) as BenchScenario;

  // Disable Nest's logger except for warns + errors so the bench output isn't
  // drowned in startup chatter. Override with `LOG_LEVEL=debug` if needed.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger:
      process.env.LOG_LEVEL === "debug"
        ? ["debug", "log", "warn", "error", "fatal"]
        : ["warn", "error", "fatal"],
  });

  try {
    const bench = app.get(BenchService);
    logger.log(
      `Running bench "${scenario.name}" envId=${scenario.envId} prompts=${scenario.prompts.length} iterations=${scenario.iterations ?? 1}`
    );
    const report = await bench.run(scenario);
    const reportPath = await bench.writeReport(report);
    process.stdout.write("\n" + bench.formatMarkdown(report) + "\n");
    logger.log(`Report: ${reportPath}`);

    const anyErrors = report.runs.some((r) => r.turns.some((t) => t.errored));
    process.exit(anyErrors ? 1 : 0);
  } finally {
    await app.close();
  }
}

void main().catch((err) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  process.stderr.write(`bench failed: ${msg}\n`);
  process.exit(2);
});

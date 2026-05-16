import chalk from "chalk";

export const log = {
  info: (msg: string) => console.log(msg),
  ok: (msg: string) => console.log(chalk.green("✓"), msg),
  warn: (msg: string) => console.log(chalk.yellow("!"), msg),
  fail: (msg: string) => console.log(chalk.red("✗"), msg),
  step: (msg: string) => console.log(chalk.cyan("→"), msg),
  dim: (msg: string) => console.log(chalk.dim(msg)),
  header: (msg: string) => {
    console.log("");
    console.log(chalk.bold.cyan(msg));
    console.log(chalk.dim("─".repeat(Math.max(8, msg.length))));
  },
};

// intent: DEC-657 — cron の入口。UI を起動せずに engine だけを叩けるようにする

import { runIntake } from "../../idd-core/src/index.ts";

const command = process.argv[2] ?? "help";

async function main(): Promise<number> {
  if (command === "intake") {
    const result = await runIntake();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.failures.length > 0 ? 1 : 0;
  }
  process.stdout.write("usage: idd intake\n");
  return command === "help" ? 0 : 2;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});

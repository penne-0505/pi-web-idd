// intent: DEC-657 — cron の入口。UI を起動せずに engine だけを叩けるようにする

import { agentBaseUrl, runIntake } from "../../idd-core/src/index.ts";

const command = process.argv[2] ?? "help";

async function main(): Promise<number> {
  if (command === "intake") {
    const result = await runIntake();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.failures.length > 0 ? 1 : 0;
  }
  if (command === "tick") {
    // intent: DEC-659 — session を触る段階は runtime のプロセスでしか動かせない。CLI は口を叩く
    const res = await fetch(`${agentBaseUrl()}/api/idd/tick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return data?.ok ? 0 : 1;
  }
  process.stdout.write("usage: idd intake | idd tick\n");
  return command === "help" ? 0 : 2;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { SHUTDOWN_ALL_CONFIRMATION } from "./account/application.js";
import { createAccountUsageService } from "./composition.js";
import { safeMessage } from "./sandbox.js";

const service = createAccountUsageService();
const preview = await service.snapshot({ includeMetrics: false });
if (!preview.running) {
  console.log("SHUTDOWN_ALL_PASS attempted=0 deleted=0 failed=0");
} else {
  console.log(`即将关闭账户当前全部 ${preview.running} 个 RUNNING AgentBay 沙盒。`);
  const flag = process.argv.indexOf("--confirm");
  let confirmation = flag >= 0 ? process.argv[flag + 1] : undefined;
  if (confirmation === undefined && stdin.isTTY) {
    const prompt = createInterface({ input: stdin, output: stdout });
    confirmation = await prompt.question(`输入 ${SHUTDOWN_ALL_CONFIRMATION} 确认：`);
    prompt.close();
  }
  if (confirmation !== SHUTDOWN_ALL_CONFIRMATION) {
    console.error(`确认失败，未关闭任何沙盒。用法：npm run shutdown-all -- --confirm "${SHUTDOWN_ALL_CONFIRMATION}"`);
    process.exitCode = 2;
  } else {
    const result = await service.shutdownAllRunning();
    console.log(`SHUTDOWN_ALL_${result.failures.length ? "PARTIAL" : "PASS"} attempted=${result.attempted} deleted=${result.deleted} failed=${result.failures.length}`);
    for (const failure of result.failures) console.error(`${failure.sessionId}: ${safeMessage(failure.error)}`);
    if (result.failures.length) process.exitCode = 1;
  }
}

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBay } from "wuying-agentbay-sdk";
import { AccountUsageService } from "./account/application.js";
import { AliyunBillExporter } from "./account/aliyun-billing.js";
import { AgentChatSession } from "./agent.js";
import { EphemeralSandbox, type SandboxStatus } from "./sandbox.js";
import type { SessionArchivePort } from "./session/application.js";
import { FileSessionArchive } from "./session/file-session-archive.js";

type SessionOptions = {
  onSandboxStatus?: (status: SandboxStatus) => void;
  idleMs?: number;
  archive?: SessionArchivePort;
  resumeSessionId?: string;
};

function buildSession(options: SessionOptions): AgentChatSession {
  return new AgentChatSession({
    archive: options.archive || new FileSessionArchive(),
    resumeSessionId: options.resumeSessionId,
    runtimeConfigDir: mkdtempSync(join(tmpdir(), "agentbay-demo-runtime-")),
    sandbox: new EphemeralSandbox({ idleMs: options.idleMs, onStatus: options.onSandboxStatus }),
  });
}

export function createAgentChatSession(onSandboxStatus?: (status: SandboxStatus) => void, idleMs?: number): AgentChatSession {
  return buildSession({ onSandboxStatus, idleMs });
}

export function createAccountUsageService(): AccountUsageService {
  return new AccountUsageService(new AgentBay(), {
    parallelLimit: Number(process.env.AGENTBAY_PARALLEL_LIMIT || 10),
    cpuCnyPerCoreHour: Number(process.env.AGENTBAY_CPU_CNY_PER_CORE_HOUR || 0.12),
    cpuCnyPerCoreHourHigh: Number(process.env.AGENTBAY_CPU_CNY_PER_CORE_HOUR_HIGH || 0.2),
    memoryCnyPerGiBHour: Number(process.env.AGENTBAY_MEMORY_CNY_PER_GIB_HOUR || 0.05),
  });
}

export function createAliyunBillExporter(): AliyunBillExporter {
  return new AliyunBillExporter();
}

function composeRescuedSession(
  rescued: Awaited<ReturnType<typeof FileSessionArchive.resumeFrom>>,
  onSandboxStatus?: (status: SandboxStatus) => void,
  idleMs?: number,
): { session: AgentChatSession; sessionId: string; path: string } {
  return {
    session: buildSession({ archive: rescued.archive, idleMs, onSandboxStatus, resumeSessionId: rescued.sessionId }),
    sessionId: rescued.sessionId,
    path: rescued.path,
  };
}

export async function rescueAgentChatSession(
  reference: string,
  onSandboxStatus?: (status: SandboxStatus) => void,
  idleMs?: number,
): Promise<{ session: AgentChatSession; sessionId: string; path: string }> {
  return composeRescuedSession(await FileSessionArchive.resumeFrom(reference), onSandboxStatus, idleMs);
}

export async function rescueAgentChatSessionById(
  sessionId: string,
  onSandboxStatus?: (status: SandboxStatus) => void,
  idleMs?: number,
): Promise<{ session: AgentChatSession; sessionId: string; path: string }> {
  return composeRescuedSession(await FileSessionArchive.resumeFromId(sessionId), onSandboxStatus, idleMs);
}

export type RemoteSessionListItem = {
  sessionId: string;
  sessionStatus: string;
  appInstanceId?: string;
  imageId?: string;
};

type SessionMetrics = { cpuCount: number; memTotal: number };

export interface AgentBayAccountPort {
  list(
    labels?: Record<string, string>,
    page?: number,
    limit?: number,
    status?: string,
  ): Promise<{
    success?: boolean;
    errorMessage?: string;
    sessionIds: RemoteSessionListItem[];
    totalCount?: number;
  }>;
  get(sessionId: string): Promise<{
    success?: boolean;
    errorMessage?: string;
    session?: {
      getMetrics(): Promise<{ success?: boolean; data?: SessionMetrics }>;
      delete(syncContext?: boolean): Promise<{ success?: boolean; errorMessage?: string }>;
    };
  }>;
}

export type RemoteSandboxUsage = RemoteSessionListItem & {
  cpuCount?: number;
  memoryGiB?: number;
  estimatedCnyPerHour?: number;
  estimatedCnyPerHourHigh?: number;
};

export const SHUTDOWN_ALL_CONFIRMATION = "SHUTDOWN ALL";

export type ShutdownAllResult = {
  attempted: number;
  deleted: number;
  failures: Array<{ sessionId: string; error: string }>;
};

export type AccountUsageSnapshot = {
  plan: "Basic";
  running: number;
  parallelLimit: number;
  utilizationPercent: number;
  estimatedCnyPerHour: number;
  estimatedCnyPerHourHigh: number;
  estimatedSessionCount: number;
  sessions: RemoteSandboxUsage[];
  observedAt: string;
};

type UsageOptions = {
  parallelLimit?: number;
  pageSize?: number;
  cpuCnyPerCoreHour?: number;
  cpuCnyPerCoreHourHigh?: number;
  memoryCnyPerGiBHour?: number;
};

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须是正数`);
  return value;
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export class AccountUsageService {
  private readonly metrics = new Map<string, Pick<RemoteSandboxUsage, "cpuCount" | "memoryGiB" | "estimatedCnyPerHour" | "estimatedCnyPerHourHigh">>();
  private readonly parallelLimit: number;
  private readonly pageSize: number;
  private readonly cpuRate: number;
  private readonly cpuRateHigh: number;
  private readonly memoryRate: number;

  constructor(private readonly client: AgentBayAccountPort, options: UsageOptions = {}) {
    this.parallelLimit = positive("parallelLimit", options.parallelLimit ?? 10);
    this.pageSize = positive("pageSize", options.pageSize ?? 10);
    this.cpuRate = positive("cpuCnyPerCoreHour", options.cpuCnyPerCoreHour ?? 0.12);
    this.cpuRateHigh = positive("cpuCnyPerCoreHourHigh", options.cpuCnyPerCoreHourHigh ?? 0.2);
    if (this.cpuRateHigh < this.cpuRate) throw new Error("cpuCnyPerCoreHourHigh 不能低于 cpuCnyPerCoreHour");
    this.memoryRate = positive("memoryCnyPerGiBHour", options.memoryCnyPerGiBHour ?? 0.05);
  }

  private async listRunning(): Promise<Map<string, RemoteSessionListItem>> {
    const listed = new Map<string, RemoteSessionListItem>();
    let page = 1;
    let totalCount: number | undefined;

    while (page <= 100) {
      const result = await this.client.list({}, page, this.pageSize, "RUNNING");
      if (!result.success) throw new Error(`AgentBay 会话列表失败：${result.errorMessage || "未知错误"}`);
      for (const session of result.sessionIds) listed.set(session.sessionId, session);
      totalCount = result.totalCount ?? totalCount;
      if (result.sessionIds.length < this.pageSize || totalCount !== undefined && listed.size >= totalCount) return listed;
      page++;
    }
    throw new Error("AgentBay 会话分页超过安全上限");
  }

  async shutdownAllRunning(): Promise<ShutdownAllResult> {
    const sessionIds = [...(await this.listRunning()).keys()];
    const outcomes = await Promise.all(sessionIds.map(async (sessionId) => {
      try {
        const found = await this.client.get(sessionId);
        if (!found.success || !found.session) {
          return { sessionId, error: found.errorMessage || "AgentBay 会话不可用" };
        }
        const deleted = await found.session.delete(false);
        if (!deleted.success) return { sessionId, error: deleted.errorMessage || "AgentBay 删除失败" };
        this.metrics.delete(sessionId);
        return undefined;
      } catch (error) {
        return { sessionId, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    const failures = outcomes.filter((outcome): outcome is { sessionId: string; error: string } => outcome !== undefined);
    return { attempted: sessionIds.length, deleted: sessionIds.length - failures.length, failures };
  }

  async snapshot(options: { includeMetrics?: boolean } = {}): Promise<AccountUsageSnapshot> {
    const listed = await this.listRunning();

    for (const sessionId of this.metrics.keys()) {
      if (!listed.has(sessionId)) this.metrics.delete(sessionId);
    }
    const includeMetrics = options.includeMetrics ?? true;
    const sessions = await Promise.all([...listed.values()].map(async (item): Promise<RemoteSandboxUsage> => {
      if (!includeMetrics) return { ...item, ...this.metrics.get(item.sessionId) };
      try {
        const result = await this.client.get(item.sessionId);
        const metrics = result.success && result.session ? await result.session.getMetrics() : undefined;
        if (!metrics?.success || !metrics.data) return { ...item, ...this.metrics.get(item.sessionId) };
        const cpuCount = metrics.data.cpuCount;
        const memoryGiB = rounded(metrics.data.memTotal / 1024 ** 3);
        const usage = {
          cpuCount,
          memoryGiB,
          estimatedCnyPerHour: rounded(cpuCount * this.cpuRate + memoryGiB * this.memoryRate),
          estimatedCnyPerHourHigh: rounded(cpuCount * this.cpuRateHigh + memoryGiB * this.memoryRate),
        };
        this.metrics.set(item.sessionId, usage);
        return { ...item, ...usage };
      } catch {
        return { ...item, ...this.metrics.get(item.sessionId) };
      }
    }));

    const estimated = sessions.filter((session) => session.estimatedCnyPerHour !== undefined);
    return {
      plan: "Basic",
      running: sessions.length,
      parallelLimit: this.parallelLimit,
      utilizationPercent: rounded(sessions.length / this.parallelLimit * 100),
      estimatedCnyPerHour: rounded(estimated.reduce((sum, session) => sum + session.estimatedCnyPerHour!, 0)),
      estimatedCnyPerHourHigh: rounded(estimated.reduce((sum, session) => sum + session.estimatedCnyPerHourHigh!, 0)),
      estimatedSessionCount: estimated.length,
      sessions,
      observedAt: new Date().toISOString(),
    };
  }
}

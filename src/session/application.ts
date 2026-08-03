export type SessionKey = {
  projectKey: string;
  sessionId: string;
  subpath?: string;
};

export type SessionEntry = {
  type: string;
  uuid?: string;
  timestamp?: string;
  [key: string]: unknown;
};

export interface SessionArchivePort {
  append(key: SessionKey, entries: SessionEntry[]): Promise<void>;
  load(key: SessionKey): Promise<SessionEntry[] | null>;
  pathFor(sessionId: string, subpath?: string): string;
  confirm(sessionId: string): Promise<string>;
  listSubkeys?(key: { projectKey: string; sessionId: string }): Promise<string[]>;
}

export interface ArchivableSessionPort {
  archive(): Promise<string | undefined>;
  destroy(): Promise<void>;
}

export async function archiveAndDestroy(session: ArchivableSessionPort): Promise<{ archivePath?: string }> {
  const archivePath = await session.archive();
  await session.destroy();
  return { archivePath };
}

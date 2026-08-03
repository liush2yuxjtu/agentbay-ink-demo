import { posix } from "node:path";

export const DEFAULT_PREVIEW_DIRECTORY = "/tmp/todo-app";
export const DEFAULT_PREVIEW_PORT = 30100;
export const MIN_PREVIEW_PORT = 30100;
export const MAX_PREVIEW_PORT = 30199;

export type PreviewState = {
  directory: string;
  port: number;
  url: string;
  expiresAt: string;
  takeoverUrl?: string;
};

export type PublishPreviewInput = { directory?: string; port?: number };
export type ValidatedPreviewInput = { directory: string; port: number };

export interface PreviewRuntimePort {
  publishPreview(input: ValidatedPreviewInput): Promise<PreviewState>;
  createTakeover(): Promise<PreviewState>;
  stopPreview(): Promise<void>;
  currentPreview(): PreviewState | undefined;
}

function validateDirectory(value: string): string {
  if (!value.startsWith("/")) throw new Error("预览路径必须是沙盒内绝对目录");
  if (value.length > 512 || /[\0\r\n]/u.test(value)) throw new Error("预览目录无效");
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(value)) throw new Error("预览目录只能包含安全字符：字母、数字、点、下划线、短横线和斜杠");
  const normalized = posix.normalize(value);
  if (normalized !== value) throw new Error("预览目录必须使用规范路径，不能包含 ..、重复分隔符或尾随斜杠");
  if (!(normalized === "/tmp" || normalized.startsWith("/tmp/") || normalized === "/home/wuying" || normalized.startsWith("/home/wuying/"))) {
    throw new Error("预览目录必须位于 /tmp 或 /home/wuying 下");
  }
  return normalized;
}

function validatePort(value: number): number {
  if (!Number.isInteger(value) || value < MIN_PREVIEW_PORT || value > MAX_PREVIEW_PORT) {
    throw new Error(`预览端口必须位于 ${MIN_PREVIEW_PORT}–${MAX_PREVIEW_PORT}`);
  }
  return value;
}

export class PreviewApplication {
  constructor(private readonly runtime: PreviewRuntimePort) {}

  async publish(input: PublishPreviewInput = {}): Promise<PreviewState> {
    return this.runtime.publishPreview({
      directory: validateDirectory(input.directory || DEFAULT_PREVIEW_DIRECTORY),
      port: validatePort(input.port ?? DEFAULT_PREVIEW_PORT),
    });
  }

  takeover(): Promise<PreviewState> {
    return this.runtime.createTakeover();
  }

  stop(): Promise<void> {
    return this.runtime.stopPreview();
  }

  current(): PreviewState | undefined {
    return this.runtime.currentPreview();
  }
}

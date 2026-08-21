import assert from "node:assert/strict";
import test from "node:test";
import {
	PreviewApplication,
	type PreviewRuntimePort,
} from "../src/preview/application.js";
import { EphemeralSandbox } from "../src/sandbox.js";
import { parseSessionCommand } from "../src/session/commands.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const previewResult = {
	directory: "/tmp/todo-app",
	port: 30100,
	url: "https://preview.example.test/app",
	expiresAt: "2026-07-29T18:00:00.000Z",
};

test("预览应用层只允许安全目录和 AgentBay 开放端口", async () => {
	const calls: Array<{ directory: string; port: number }> = [];
	const runtime: PreviewRuntimePort = {
		publishPreview: async (input) => {
			calls.push(input);
			return previewResult;
		},
		createTakeover: async () => ({
			...previewResult,
			takeoverUrl: "https://takeover.example.test",
		}),
		stopPreview: async () => undefined,
		currentPreview: () => undefined,
	};
	const app = new PreviewApplication(runtime);

	assert.deepEqual(
		await app.publish({ directory: "/tmp/todo-app" }),
		previewResult,
	);
	assert.deepEqual(calls, [{ directory: "/tmp/todo-app", port: 30100 }]);
	await assert.rejects(
		() => app.publish({ directory: "../../etc", port: 30100 }),
		/绝对目录/,
	);
	await assert.rejects(
		() => app.publish({ directory: "/etc", port: 30100 }),
		/\/tmp 或 \/home\/wuying/,
	);
	await assert.rejects(
		() => app.publish({ directory: "/tmp/a/../secret", port: 30100 }),
		/规范路径/,
	);
	await assert.rejects(
		() => app.publish({ directory: "/tmp/a'; touch /tmp/pwned", port: 30100 }),
		/安全字符/,
	);
	await assert.rejects(
		() => app.publish({ directory: "/tmp/todo-app", port: 3000 }),
		/30100–30199/,
	);
});

test("代码沙盒发布静态目录、生成临时链接并在预览期间暂停普通空闲回收", async () => {
	const commands: string[] = [];
	let deleted = 0;
	const sandbox = new EphemeralSandbox({
		idleMs: 30,
		previewTtlMs: 500,
		createSandbox: async () => ({
			sessionId: "code-session",
			command: {
				executeCommand: async (command: string) => {
					commands.push(command);
					return {
						success: true,
						output: command.includes("PREVIEW_HEALTH_OK")
							? "PREVIEW_HEALTH_OK"
							: "4242\n",
						exitCode: 0,
					};
				},
			},
			fileSystem: {
				readFile: async () => ({ success: true, content: "" }),
				writeFile: async () => ({ success: true }),
			},
			getLink: async (_protocol?: string, port?: number) => ({
				success: true,
				data: `https://preview.example.test/${port}`,
			}),
			delete: async () => {
				deleted++;
				return { success: true };
			},
		}),
	});
	const app = new PreviewApplication(sandbox);

	const preview = await app.publish({ directory: "/tmp/todo-app" });
	assert.equal(preview.url, "https://preview.example.test/30100");
	assert.equal(preview.port, 30100);
	assert.match(commands[0], /python3 -m http\.server 30100/);
	assert.match(commands[0], /--directory '\/tmp\/todo-app'/);
	assert.match(commands[0], /find '\/tmp\/todo-app' -type l/);
	assert.match(commands[0], /\.env/);
	assert.match(commands[0], /20971520/);
	assert.match(commands[1], /PREVIEW_HEALTH_OK/);

	await sleep(70);
	assert.equal(sandbox.state, "ready", "活跃预览不应被普通空闲计时器销毁");
	assert.equal(deleted, 0);

	await app.stop();
	assert.equal(app.current(), undefined);
	assert.ok(commands.some((command) => command.includes("kill 4242")));
	await sleep(70);
	assert.equal(sandbox.state, "destroyed");
	assert.equal(deleted, 1);
});

test("Basic 套餐 GetLink 受限时，同一浏览器沙盒打开本地预览并返回人工接管地址", async () => {
	let browserDestroyed = 0;
	let browserOptions: Record<string, unknown> | undefined;
	const sandbox = new EphemeralSandbox({
		idleMs: 5_000,
		previewTtlMs: 5_000,
		createSandbox: async () => ({
			sessionId: "browser-code-session",
			command: {
				executeCommand: async (command: string) => ({
					success: true,
					output: command.includes("PREVIEW_HEALTH_OK")
						? "PREVIEW_HEALTH_OK"
						: "777\n",
					exitCode: 0,
				}),
			},
			fileSystem: {
				readFile: async () => ({ success: true, content: "" }),
				writeFile: async () => ({ success: true }),
			},
			getLink: async () => {
				throw new Error(
					"GetLink is an exclusive premium feature for paid subscription users",
				);
			},
			browser: {
				initializeAsync: async (options: Record<string, unknown>) => {
					browserOptions = options;
					return true;
				},
				destroy: async () => {
					browserDestroyed++;
				},
			},
			info: async () => ({
				success: true,
				data: {
					resourceUrl:
						"https://takeover.example.test/browser?authcode=a+b&resourceId=p-1",
				},
			}),
			delete: async () => ({ success: true }),
		}),
	});
	const app = new PreviewApplication(sandbox);

	const published = await app.publish({ directory: "/tmp/todo-app" });
	assert.equal(browserOptions?.defaultNavigateUrl, "http://127.0.0.1:30100");
	assert.equal(
		published.url,
		"https://takeover.example.test/browser?authcode=a%2Bb&resourceId=p-1",
	);
	assert.equal(
		published.takeoverUrl,
		"https://takeover.example.test/browser?authcode=a%2Bb&resourceId=p-1",
	);
	assert.deepEqual(await app.takeover(), published);

	await app.stop();
	assert.equal(browserDestroyed, 1);
	await sandbox.destroy();
});

test("预览 slash 命令可发布、接管和停止", () => {
	assert.deepEqual(parseSessionCommand("/preview /tmp/todo-app 30123"), {
		type: "preview",
		directory: "/tmp/todo-app",
		port: 30123,
	});
	assert.deepEqual(parseSessionCommand("/preview"), {
		type: "preview",
		directory: "/tmp/todo-app",
		port: 30100,
	});
	assert.deepEqual(parseSessionCommand("/takeover"), { type: "takeover" });
	assert.deepEqual(parseSessionCommand("/stop-preview"), {
		type: "stopPreview",
	});
	assert.equal(
		parseSessionCommand("/preview /tmp/todo-app 3000").type,
		"error",
	);
});

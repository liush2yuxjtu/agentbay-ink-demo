import assert from "node:assert/strict";
import test from "node:test";
import { EphemeralSandbox, safeMessage } from "../src/sandbox.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeSession(onDelete: () => void) {
	return {
		sessionId: "test-session",
		command: {
			executeCommand: async (command: string) => ({
				success: true,
				output: `remote:${command}`,
				exitCode: 0,
			}),
		},
		fileSystem: {
			readFile: async (path: string) => ({
				success: true,
				content: `file:${path}`,
			}),
			writeFile: async () => ({ success: true }),
		},
		delete: async () => {
			onDelete();
			return { success: true };
		},
	};
}

test("错误信息会隐藏凭据、租户和请求标识", () => {
	const message = safeMessage(
		new Error(
			"tenantId: tenant-fixture-123 request id: 123e4567-e89b-42d3-a456-426614174000 token=secret-value AccessKeyId=akid-fixture&Signature=sig-fixture",
		),
	);
	assert.equal(message.includes("tenant-fixture-123"), false);
	assert.equal(message.includes("secret-value"), false);
	assert.equal(message.includes("akid-fixture"), false);
	assert.equal(message.includes("sig-fixture"), false);
	assert.match(message, /tenantId: <redacted>/);
});

test("一个会话只创建一个沙盒，并在空闲后只销毁一次", async () => {
	let created = 0;
	let deleted = 0;
	const sandbox = new EphemeralSandbox({
		idleMs: 30,
		createSandbox: async () => {
			created++;
			return fakeSession(() => deleted++);
		},
	});

	await Promise.all([sandbox.start(), sandbox.start()]);
	assert.equal(await sandbox.execute("printf hello"), "remote:printf hello");
	assert.equal(created, 1);
	assert.equal(sandbox.sessionId, "test-session");

	await sleep(70);
	assert.equal(sandbox.state, "destroyed");
	assert.equal(sandbox.sessionId, undefined);
	assert.equal(deleted, 1);
	await sandbox.destroy();
	assert.equal(deleted, 1);
});

test("创建尚未完成时退出也会清理刚创建的沙盒", async () => {
	let release!: (value: ReturnType<typeof fakeSession>) => void;
	let deleted = 0;
	const pending = new Promise<ReturnType<typeof fakeSession>>((resolve) => {
		release = resolve;
	});
	const sandbox = new EphemeralSandbox({ createSandbox: () => pending });

	const starting = sandbox.start();
	const closing = sandbox.destroy();
	release(fakeSession(() => deleted++));
	await Promise.all([starting, closing]);

	assert.equal(sandbox.state, "destroyed");
	assert.equal(deleted, 1);
});

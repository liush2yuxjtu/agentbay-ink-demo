import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const authScript = join(root, "scripts/auth.sh");
const runtimeScript = join(root, "scripts/with-runtime.sh");
const syntheticAgentBayKey = ["akm", "synthetic-agentbay-key"].join("-");

function run(command: string, args: string[], env: NodeJS.ProcessEnv, input?: string) {
  return spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, input, encoding: "utf8" });
}

function runtimeProbe(env: NodeJS.ProcessEnv) {
  return run("bash", [runtimeScript, process.execPath, "-e", `console.log(JSON.stringify({
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    apiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    authToken: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
    agentBay: Boolean(process.env.AGENTBAY_API_KEY),
    region: process.env.AGENTBAY_REGION_ID,
    profile: process.env.ALIYUN_PROFILE,
  }))`], env);
}

test("本地登录以私有权限保存 LLM、AgentBay 和 Aliyun profile，且不回显密钥", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentbay-auth-test-"));
  const configDir = join(home, ".config/agentbay-ink-demo");
  const agentBayKeyFile = join(home, ".config/agentbay/api_key");
  const llmSecret = "llm-test-secret-value";
  const agentBaySecret = syntheticAgentBayKey;
  const env = { HOME: home, AGENTBAY_DEMO_CONFIG_DIR: configDir, AGENTBAY_API_KEY_FILE: agentBayKeyFile };

  const login = run("bash", [authScript, "login"], env, [
    "https://llm.example.test/v1",
    "token",
    llmSecret,
    agentBaySecret,
    "ap-southeast-1",
    "billing-demo",
  ].join("\n") + "\n");

  assert.equal(login.status, 0, login.stderr);
  assert.match(login.stdout, /LOGIN_PASS/);
  assert.equal(`${login.stdout}${login.stderr}`.includes(llmSecret), false);
  assert.equal(`${login.stdout}${login.stderr}`.includes(agentBaySecret), false);
  assert.equal((await stat(configDir)).mode & 0o777, 0o700);
  for (const file of ["llm_base_url", "llm_auth_kind", "llm_credential", "agentbay_region_id", "aliyun_profile"]) {
    assert.equal((await stat(join(configDir, file))).mode & 0o777, 0o600);
  }
  assert.equal((await stat(agentBayKeyFile)).mode & 0o777, 0o600);
  assert.equal((await readFile(agentBayKeyFile, "utf8")).trim(), agentBaySecret);

  const status = run("bash", [authScript, "status"], env);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /llm=configured agentbay=configured/);
  assert.equal(status.stdout.includes(llmSecret), false);
  assert.equal(status.stdout.includes(agentBaySecret), false);

  const probe = runtimeProbe(env);
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout.trim()), {
    baseUrl: "https://llm.example.test/v1",
    apiKey: false,
    authToken: true,
    agentBay: true,
    region: "ap-southeast-1",
    profile: "billing-demo",
  });
});

test("环境变量优先并支持 Anthropic API key 模式", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentbay-auth-env-test-"));
  const probe = runtimeProbe({
    HOME: home,
    LLM_BASE_URL: "https://api.anthropic.com",
    LLM_API_KEY: "synthetic-anthropic-key",
    LLM_AUTH_KIND: "api-key",
    AGENTBAY_API_KEY: syntheticAgentBayKey,
    AGENTBAY_REGION_ID: "us-east-1",
    ALIYUN_PROFILE: "prod-readonly",
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout.trim()), {
    baseUrl: "https://api.anthropic.com",
    apiKey: true,
    authToken: false,
    agentBay: true,
    region: "us-east-1",
    profile: "prod-readonly",
  });
});

test("无登录配置时保留现有 CLIProxyAPI fallback，非法输入不落盘", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentbay-auth-fallback-test-"));
  const proxyDir = join(home, ".config/claudex");
  await mkdir(proxyDir, { recursive: true, mode: 0o700 });
  await writeFile(join(proxyDir, "proxy-start.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
  await writeFile(join(proxyDir, "agent-api-key-helper"), "#!/usr/bin/env bash\nprintf synthetic-proxy-token\n", { mode: 0o700 });
  await chmod(join(proxyDir, "proxy-start.sh"), 0o700);
  await chmod(join(proxyDir, "agent-api-key-helper"), 0o700);

  const fallback = runtimeProbe({ HOME: home, CLAUDEX_CONFIG_DIR: proxyDir, AGENTBAY_API_KEY: syntheticAgentBayKey });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.deepEqual(JSON.parse(fallback.stdout.trim()), {
    baseUrl: "http://127.0.0.1:8318",
    apiKey: false,
    authToken: true,
    agentBay: true,
  });

  const configDir = join(home, ".config/agentbay-ink-demo");
  const agentBayKeyFile = join(home, ".config/agentbay/api_key");
  const invalid = run("bash", [authScript, "login"], {
    HOME: home,
    AGENTBAY_DEMO_CONFIG_DIR: configDir,
    AGENTBAY_API_KEY_FILE: agentBayKeyFile,
  }, `file:///tmp/not-http\ntoken\nsecret-value\n${syntheticAgentBayKey}\ncn-hangzhou\ndefault\n`);
  assert.notEqual(invalid.status, 0);
  await assert.rejects(stat(join(configDir, "llm_credential")), { code: "ENOENT" });
  await assert.rejects(stat(agentBayKeyFile), { code: "ENOENT" });
});

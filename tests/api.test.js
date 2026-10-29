const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_PASSWORD = "CIRCLE-2026-A";
const FLOW_PASSWORD = "CIRCLE-2026-B";
const ADMIN_PASSWORD = "ADMIN-TEST-PASSWORD-2026";

let child;
let baseUrl;
let temporaryDirectory;
let serverOutput = "";

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(url, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // The child process may still be loading its state.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`服务器未能启动：${serverOutput}`);
}

async function request(pathname, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.body !== undefined
      ? { "Content-Type": "application/json" }
      : {}),
    ...options.headers,
  };
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
}

async function unlock(password) {
  const response = await request("/api/unlock", {
    method: "POST",
    body: { password },
  });
  assert.equal(response.status, 200);
  assert.ok(response.payload.unlockToken);
  assert.equal(response.payload.maxTests, 3);
  return response.payload;
}

async function startTest(unlockToken) {
  return request("/api/tests/start", {
    method: "POST",
    body: { unlockToken },
  });
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey.toString("hex"));
    });
  });
}

async function createAdminConfig(filePath) {
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = await scrypt(ADMIN_PASSWORD, salt);
  const now = new Date().toISOString();
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      salt,
      passwordHash,
      tokenSecret: crypto.randomBytes(32).toString("hex"),
      createdAt: now,
      updatedAt: now,
    }),
    "utf8",
  );
}

function buildCompleteAnswers(seed = 3) {
  const answers = {};
  for (const question of content.questions) {
    answers[question.id] = ((question.id + seed - 1) % 5) + 1;
  }
  return answers;
}

let content;

test.before(async () => {
  content = JSON.parse(
    await fs.readFile(path.join(ROOT, "data", "content.json"), "utf8"),
  );
  temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "friend-circle-atlas-"),
  );
  const adminConfigPath = path.join(temporaryDirectory, "admin.json");
  await createAdminConfig(adminConfigPath);
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      STATE_PATH: path.join(temporaryDirectory, "state.json"),
      ADMIN_CONFIG_PATH: adminConfigPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  await waitForServer(baseUrl);
});

test.after(async () => {
  if (child && !child.killed) {
    child.kill();
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 2_000);
    });
  }
  if (temporaryDirectory) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("内容接口只返回安全题库字段，中文和生活场景可正常读取", async () => {
  const response = await request("/api/content");
  assert.equal(response.status, 200);
  assert.equal(response.payload.questions.length, 47);
  assert.equal(response.payload.dimensions.length, 9);
  assert.match(response.payload.questions[0].text, /周末|群里|朋友/);
  assert.deepEqual(Object.keys(response.payload.questions[0]).sort(), [
    "dimension",
    "id",
    "text",
  ]);
});

test("同一密码前三次可以开始，第四次被服务端拒绝", async () => {
  const unlocked = await unlock(DEFAULT_PASSWORD);
  assert.equal(unlocked.remaining, 3);

  for (let index = 0; index < 3; index += 1) {
    const started = await startTest(unlocked.unlockToken);
    assert.equal(started.status, 201);
    assert.equal(started.payload.remaining, 2 - index);
    assert.ok(started.payload.testId);
    assert.ok(started.payload.testToken);
  }

  const fourth = await startTest(unlocked.unlockToken);
  assert.equal(fourth.status, 403);
  assert.equal(fourth.payload.remaining, 0);
});

test("答题进度可保存与恢复，邀请好友使用三次额度", async () => {
  const unlocked = await unlock(FLOW_PASSWORD);
  const started = await startTest(unlocked.unlockToken);
  assert.equal(started.status, 201);

  const { testId, testToken } = started.payload;
  const partialAnswers = {
    1: 5,
    2: 4,
    3: 1,
    41: 5,
  };
  const saved = await request(`/api/tests/${testId}/progress`, {
    method: "PUT",
    token: testToken,
    body: { answers: partialAnswers, currentIndex: 40 },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.answered, 4);

  const restored = await request(`/api/tests/${testId}`, {
    token: testToken,
  });
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.payload.answers, partialAnswers);
  assert.equal(restored.payload.currentIndex, 40);

  const completeAnswers = buildCompleteAnswers();
  const submitted = await request(`/api/tests/${testId}/submit`, {
    method: "POST",
    token: testToken,
    body: { answers: completeAnswers },
  });
  assert.equal(submitted.status, 201);
  assert.ok(submitted.payload.id);
  assert.equal(typeof submitted.payload.role.name, "string");
  assert.equal(typeof submitted.payload.role.highlight, "string");
  assert.equal("code" in submitted.payload.role, false);
  assert.equal("advice" in submitted.payload.role, false);
  assert.equal(typeof submitted.payload.role.practice.scene, "string");
  assert.equal(typeof submitted.payload.role.practice.action, "string");
  assert.equal(typeof submitted.payload.role.practice.signal, "string");
  assert.equal(submitted.payload.shareCount, 0);
  assert.equal(submitted.payload.maxShares, 3);

  const resultId = submitted.payload.id;
  const privateResult = await request(`/api/results/${resultId}`, {
    token: testToken,
  });
  assert.equal(privateResult.status, 200);
  assert.equal(privateResult.payload.id, resultId);

  const invites = [];
  for (let count = 1; count <= 3; count += 1) {
    const invite = await request(`/api/results/${resultId}/invite`, {
      method: "POST",
      token: testToken,
    });
    assert.equal(invite.status, 201);
    assert.equal(invite.payload.kind, "invite");
    assert.equal(invite.payload.shareCount, count);
    assert.equal(invite.payload.remainingShares, 3 - count);
    assert.equal(invite.payload.shareUrl, `${baseUrl}/`);
    invites.push(invite.payload);
  }

  const fourthInvite = await request(`/api/results/${resultId}/invite`, {
    method: "POST",
    token: testToken,
  });
  assert.equal(fourthInvite.status, 429);
  assert.equal(fourthInvite.payload.shareCount, 3);

  const inviteResult = await request(
    `/api/shared/${invites[0].shareToken}`,
  );
  assert.equal(inviteResult.status, 404);

  const retake = await request(`/api/tests/${testId}/retake`, {
    method: "POST",
    token: testToken,
  });
  assert.equal(retake.status, 201);
  assert.equal(retake.payload.remaining, 1);
  assert.notEqual(retake.payload.testId, testId);
});

test("管理员可生成卡密批次、重新导出并用于解锁", async () => {
  const adminPage = await request("/admin");
  assert.equal(adminPage.status, 200);
  assert.match(adminPage.payload, /<title>卡密发货台｜朋友圈岗位图鉴<\/title>/);

  const unauthorizedInventory = await request("/api/admin/inventory");
  assert.equal(unauthorizedInventory.status, 401);

  const wrongLogin = await request("/api/admin/login", {
    method: "POST",
    body: { password: "WRONG-ADMIN-PASSWORD" },
  });
  assert.equal(wrongLogin.status, 401);

  const login = await request("/api/admin/login", {
    method: "POST",
    body: { password: ADMIN_PASSWORD },
  });
  assert.equal(login.status, 200);
  assert.ok(login.payload.adminToken);
  const adminToken = login.payload.adminToken;

  const inventoryBefore = await request("/api/admin/inventory", {
    token: adminToken,
  });
  assert.equal(inventoryBefore.status, 200);

  const generated = await request("/api/admin/codes/generate", {
    method: "POST",
    token: adminToken,
    body: { count: 4, label: "自动发货测试批次" },
  });
  assert.equal(generated.status, 201);
  assert.equal(generated.payload.codes.length, 4);
  assert.equal(new Set(generated.payload.codes).size, 4);
  for (const code of generated.payload.codes) {
    assert.match(code, /^FC-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  }

  const batchId = generated.payload.batch.id;
  const exported = await request(
    `/api/admin/batches/${encodeURIComponent(batchId)}/export`,
    { token: adminToken },
  );
  assert.equal(exported.status, 200);
  assert.deepEqual(exported.payload.codes, generated.payload.codes);

  const unlocked = await unlock(generated.payload.codes[0]);
  assert.equal(unlocked.remaining, 3);

  const inventoryAfter = await request("/api/admin/inventory", {
    token: adminToken,
  });
  assert.equal(inventoryAfter.status, 200);
  assert.equal(
    inventoryAfter.payload.totals.totalCodes,
    inventoryBefore.payload.totals.totalCodes + 4,
  );
  assert.equal(
    inventoryAfter.payload.batchCount,
    inventoryBefore.payload.batchCount + 1,
  );

  const stateText = await fs.readFile(
    path.join(temporaryDirectory, "state.json"),
    "utf8",
  );
  for (const code of generated.payload.codes) {
    assert.equal(stateText.includes(code), false);
  }
});

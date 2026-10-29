const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const STATE_PATH = process.env.STATE_PATH
  ? path.resolve(process.env.STATE_PATH)
  : path.join(DATA_DIR, "state.json");
const ADMIN_CONFIG_PATH = process.env.ADMIN_CONFIG_PATH
  ? path.resolve(process.env.ADMIN_CONFIG_PATH)
  : path.join(DATA_DIR, "admin.json");
const CONTENT_PATH = path.join(DATA_DIR, "content.json");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_TESTS_PER_PASSWORD = 3;
const MAX_SHARES_PER_RESULT = 3;
const UNLOCK_TTL_MS = 24 * 60 * 60 * 1000;
const ADMIN_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const ADMIN_GENERATE_LIMIT = 100;
const ACCESS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEFAULT_PASSWORDS = [
  "CIRCLE-2026-A",
  "CIRCLE-2026-B",
  "CIRCLE-2026-C",
];

const content = JSON.parse(fs.readFileSync(CONTENT_PATH, "utf8"));
validateContent(content);

const dimensionMap = new Map(
  content.dimensions.map((dimension) => [dimension.id, dimension]),
);
const roleMap = new Map(
  [...content.roles, content.specialRole].map((role) => [role.id, role]),
);
const questionMap = new Map(
  content.questions.map((question) => [question.id, question]),
);

let state;
let adminConfig;
let writeQueue = Promise.resolve();
let adminGenerationQueue = Promise.resolve();
let passwordById = new Map();
let passwordByLookup = new Map();
const unlockAttempts = new Map();
const adminLoginAttempts = new Map();

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function validateContent(data) {
  if (
    !Array.isArray(data.questions) ||
    data.questions.length !== data.meta.questionCount
  ) {
    throw new Error("content.json 的题目数量与 meta.questionCount 不一致");
  }
  const dimensionIds = new Set(data.dimensions.map((item) => item.id));
  const counts = Object.fromEntries(
    data.dimensions.map((dimension) => [dimension.id, 0]),
  );
  for (const question of data.questions) {
    if (!dimensionIds.has(question.dimension)) {
      throw new Error(`题目 ${question.id} 使用了未知维度`);
    }
    counts[question.dimension] += 1;
  }
  for (const dimension of data.dimensions) {
    if (counts[dimension.id] < 5) {
      throw new Error(`维度 ${dimension.id} 至少需要 5 道题`);
    }
  }
  if (counts.N < 7) {
    throw new Error("导航力维度至少需要 7 道题");
  }
  if (data.roles.length !== 12) {
    throw new Error("content.json 必须包含 12 个岗位结果");
  }
  for (const role of [...data.roles, data.specialRole]) {
    for (const dimensionId of dimensionIds) {
      if (!Number.isFinite(role.target[dimensionId])) {
        throw new Error(`岗位 ${role.name} 缺少维度 ${dimensionId}`);
      }
    }
  }
}

function createEmptyState() {
  return {
    version: 1,
    secret: crypto.randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(),
    passwords: [],
    codeBatches: {},
    tests: {},
    results: {},
    shares: {},
  };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt);
  return { salt, hash };
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey.toString("hex"));
    });
  });
}

function normalizePassword(value) {
  return String(value || "").trim().toUpperCase();
}

function indexPassword(record) {
  passwordById.set(record.id, record);
  if (record.lookupHash) {
    passwordByLookup.set(record.lookupHash, record);
  }
}

function rebuildPasswordIndexes() {
  passwordById = new Map();
  passwordByLookup = new Map();
  for (const record of state.passwords) {
    indexPassword(record);
  }
}

async function addPassword(password, maxTests = MAX_TESTS_PER_PASSWORD) {
  const normalized = normalizePassword(password);
  if (!normalized) throw new Error("密码不能为空");
  const lookupHash = hashPasswordLookup(normalized);
  const existing = passwordByLookup.get(lookupHash);
  if (existing) return { added: false, id: existing.id };
  const { salt, hash } = await hashPassword(normalized);
  const record = {
    id: crypto.randomUUID(),
    salt,
    hash,
    lookupHash,
    maxTests,
    usedTests: 0,
    createdAt: new Date().toISOString(),
  };
  state.passwords.push(record);
  indexPassword(record);
  return { added: true, id: record.id };
}

function hashPasswordLookup(normalizedPassword) {
  return crypto
    .createHmac("sha256", state.secret)
    .update(normalizedPassword)
    .digest("hex");
}

async function loadState() {
  try {
    state = JSON.parse(await fsp.readFile(STATE_PATH, "utf8"));
    if (!state.secret || !state.passwords || !state.tests) {
      throw new Error("state.json 格式不完整");
    }
    if (!state.codeBatches || typeof state.codeBatches !== "object") {
      state.codeBatches = {};
    }
    let migrated = false;
    for (const password of state.passwords) {
      if (!password.lookupHash && password.normalizedHint) {
        password.lookupHash = hashPasswordLookup(password.normalizedHint);
        delete password.normalizedHint;
        migrated = true;
      }
    }
    rebuildPasswordIndexes();
    if (migrated) await persistState();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = createEmptyState();
    const seedPasswords = process.env.SEED_PASSWORDS
      ? process.env.SEED_PASSWORDS.split(",")
      : DEFAULT_PASSWORDS;
    for (const password of seedPasswords) {
      await addPassword(password);
    }
    rebuildPasswordIndexes();
    await persistState();
  }
}

function persistState() {
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(async () => {
    await fsp.mkdir(path.dirname(STATE_PATH), { recursive: true });
    const temporaryPath = `${STATE_PATH}.tmp`;
    await fsp.writeFile(temporaryPath, snapshot, "utf8");
    try {
      await fsp.rename(temporaryPath, STATE_PATH);
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
      await fsp.copyFile(temporaryPath, STATE_PATH);
      await fsp.rm(temporaryPath, { force: true });
    }
  });
  return writeQueue;
}

async function loadAdminConfig() {
  try {
    const parsed = JSON.parse(
      await fsp.readFile(ADMIN_CONFIG_PATH, "utf8"),
    );
    if (
      !parsed ||
      typeof parsed.salt !== "string" ||
      typeof parsed.passwordHash !== "string" ||
      typeof parsed.tokenSecret !== "string"
    ) {
      throw new Error("admin.json 格式不完整");
    }
    adminConfig = parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      adminConfig = null;
      return;
    }
    throw error;
  }
}

function normalizeAdminPassword(value) {
  return String(value || "").trim();
}

async function verifyAdminPassword(password) {
  if (!adminConfig || password.length > 256) return false;
  const hash = await scrypt(password, adminConfig.salt);
  const expected = Buffer.from(adminConfig.passwordHash, "hex");
  const actual = Buffer.from(hash, "hex");
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}

function signAdminPayload(payload) {
  return crypto
    .createHmac("sha256", adminConfig.tokenSecret)
    .update(payload)
    .digest("base64url");
}

function createAdminToken() {
  const expiresAt = Date.now() + ADMIN_TOKEN_TTL_MS;
  const payload = base64Url(
    JSON.stringify({
      type: "admin",
      expiresAt,
      nonce: crypto.randomBytes(12).toString("hex"),
    }),
  );
  return {
    token: `${payload}.${signAdminPayload(payload)}`,
    expiresAt,
  };
}

function verifyAdminToken(token) {
  if (!adminConfig || typeof token !== "string" || !token.includes(".")) {
    return null;
  }
  const [payload, signature] = token.split(".");
  const expected = signAdminPayload(payload);
  if (
    !signature ||
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (decoded.type !== "admin" || decoded.expiresAt < Date.now()) return null;
    return decoded;
  } catch {
    return null;
  }
}

function authenticateAdmin(request) {
  return verifyAdminToken(readBearerToken(request));
}

function checkAdminLoginRateLimit(ip) {
  const now = Date.now();
  const entry = adminLoginAttempts.get(ip);
  if (!entry || entry.resetAt < now) return true;
  return entry.count < 8;
}

function recordAdminLoginFailure(ip) {
  const now = Date.now();
  const entry = adminLoginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    adminLoginAttempts.set(ip, {
      count: 1,
      resetAt: now + 15 * 60 * 1000,
    });
    return;
  }
  entry.count += 1;
}

function cleanBatchLabel(value) {
  const label = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return label || "未命名批次";
}

function deriveBatchAccessCode(batch, index, attempt) {
  const digest = crypto
    .createHmac("sha256", state.secret)
    .update(
      `friend-circle-code-v1:${batch.id}:${batch.nonce}:${index}:${attempt}`,
    )
    .digest();
  let body = "";
  for (let offset = 0; offset < 8; offset += 1) {
    body += ACCESS_CODE_ALPHABET[digest[offset] % ACCESS_CODE_ALPHABET.length];
  }
  return `FC-${body.slice(0, 4)}-${body.slice(4)}`;
}

function batchPayload(batch) {
  return {
    id: batch.id,
    label: batch.label,
    count: batch.count,
    createdAt: batch.createdAt,
  };
}

async function generateCodeBatch(input) {
  const count = Number(input.count);
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > ADMIN_GENERATE_LIMIT
  ) {
    const error = new Error(
      `每次最多生成 ${ADMIN_GENERATE_LIMIT} 个访问码`,
    );
    error.statusCode = 400;
    throw error;
  }

  const createdAt = new Date().toISOString();
  const batch = {
    id: crypto.randomUUID(),
    label: cleanBatchLabel(input.label),
    count,
    nonce: crypto.randomBytes(18).toString("hex"),
    records: [],
    createdAt,
  };
  const originalCount = state.passwords.length;
  const codes = [];

  try {
    for (let index = 0; index < count; index += 1) {
      let attempt = 0;
      let code;
      let lookupHash;
      do {
        code = deriveBatchAccessCode(batch, index, attempt);
        lookupHash = hashPasswordLookup(code);
        attempt += 1;
      } while (passwordByLookup.has(lookupHash));

      const { salt, hash } = await hashPassword(code);
      const record = {
        id: crypto.randomUUID(),
        salt,
        hash,
        lookupHash,
        maxTests: MAX_TESTS_PER_PASSWORD,
        usedTests: 0,
        createdAt,
        batchId: batch.id,
        batchIndex: index,
      };
      state.passwords.push(record);
      indexPassword(record);
      batch.records.push({
        passwordId: record.id,
        attempt: attempt - 1,
      });
      codes.push(code);
    }

    state.codeBatches[batch.id] = batch;
    await persistState();
    return {
      batch: batchPayload(batch),
      codes,
      maxTests: MAX_TESTS_PER_PASSWORD,
    };
  } catch (error) {
    state.passwords.splice(originalCount);
    delete state.codeBatches[batch.id];
    rebuildPasswordIndexes();
    throw error;
  }
}

function queueCodeBatchGeneration(input) {
  const task = adminGenerationQueue.then(() => generateCodeBatch(input));
  adminGenerationQueue = task.catch(() => {});
  return task;
}

function exportCodeBatch(batch) {
  return batch.records.map((batchRecord, index) => {
    const record = passwordById.get(batchRecord.passwordId);
    if (!record) {
      const error = new Error("批次中的访问码记录缺失");
      error.statusCode = 409;
      throw error;
    }
    const code = deriveBatchAccessCode(
      batch,
      index,
      batchRecord.attempt,
    );
    if (hashPasswordLookup(code) !== record.lookupHash) {
      throw new Error("批次导出校验失败");
    }
    return code;
  });
}

function buildInventorySummary() {
  let untouchedCodes = 0;
  let partiallyUsedCodes = 0;
  let exhaustedCodes = 0;
  let totalUses = 0;

  for (const record of state.passwords) {
    totalUses += record.usedTests;
    if (record.usedTests === 0) untouchedCodes += 1;
    else if (record.usedTests >= record.maxTests) exhaustedCodes += 1;
    else partiallyUsedCodes += 1;
  }

  const batches = Object.values(state.codeBatches)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 30)
    .map((batch) => {
      let testStarts = 0;
      let remainingTests = 0;
      for (const item of batch.records) {
        const record = passwordById.get(item.passwordId);
        if (!record) continue;
        testStarts += record.usedTests;
        remainingTests += Math.max(0, record.maxTests - record.usedTests);
      }
      return {
        ...batchPayload(batch),
        testStarts,
        remainingTests,
      };
    });

  return {
    totals: {
      totalCodes: state.passwords.length,
      untouchedCodes,
      partiallyUsedCodes,
      exhaustedCodes,
      totalUses,
      totalCapacity: state.passwords.reduce(
        (total, record) => total + record.maxTests,
        0,
      ),
    },
    batches,
    batchCount: Object.keys(state.codeBatches).length,
    generatedAt: new Date().toISOString(),
  };
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function signPayload(payload) {
  return crypto
    .createHmac("sha256", state.secret)
    .update(payload)
    .digest("base64url");
}

function createUnlockToken(passwordId) {
  const payload = base64Url(
    JSON.stringify({
      type: "unlock",
      passwordId,
      expiresAt: Date.now() + UNLOCK_TTL_MS,
    }),
  );
  return `${payload}.${signPayload(payload)}`;
}

function verifyUnlockToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  const expected = signPayload(payload);
  if (
    !signature ||
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (decoded.type !== "unlock" || decoded.expiresAt < Date.now()) return null;
    return decoded;
  } catch {
    return null;
  }
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createTestRecord(passwordId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const test = {
    id: crypto.randomUUID(),
    passwordId,
    tokenHash: hashToken(token),
    status: "active",
    answers: {},
    currentIndex: 0,
    resultId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.tests[test.id] = test;
  return { test, token };
}

function remainingForPassword(passwordId) {
  const password = passwordById.get(passwordId);
  if (!password) return 0;
  return Math.max(0, password.maxTests - password.usedTests);
}

function consumeAttempt(passwordId) {
  const password = passwordById.get(passwordId);
  if (!password || password.usedTests >= password.maxTests) return null;
  password.usedTests += 1;
  return password;
}

function readBearerToken(request) {
  const header = request.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function authenticateTest(request, testId) {
  const test = state.tests[testId];
  if (!test) return null;
  const token = readBearerToken(request);
  if (!token || hashToken(token) !== test.tokenHash) return null;
  return test;
}

function validateAnswers(input, requireComplete = false) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, message: "答案格式不正确" };
  }
  const answers = {};
  for (const [key, value] of Object.entries(input)) {
    const questionId = Number(key);
    const score = Number(value);
    if (!questionMap.has(questionId)) {
      return { valid: false, message: "答案中包含未知题目" };
    }
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return { valid: false, message: "每道题只能选择 1 至 5 分" };
    }
    answers[questionId] = score;
  }
  if (requireComplete && Object.keys(answers).length !== content.questions.length) {
    return { valid: false, message: "还有题目没有完成" };
  }
  return { valid: true, answers };
}

function calculateDimensionScores(answers) {
  const rawTotals = Object.fromEntries(
    content.dimensions.map((dimension) => [dimension.id, 0]),
  );
  const questionCounts = Object.fromEntries(
    content.dimensions.map((dimension) => [dimension.id, 0]),
  );
  for (const question of content.questions) {
    const raw = answers[question.id];
    const score = question.reverse ? 6 - raw : raw;
    rawTotals[question.dimension] += score;
    questionCounts[question.dimension] += 1;
  }
  return Object.fromEntries(
    content.dimensions.map((dimension) => [
      dimension.id,
      Math.round(
        ((rawTotals[dimension.id] - questionCounts[dimension.id]) /
          (questionCounts[dimension.id] * 4)) *
          100,
      ),
    ]),
  );
}

function matchScore(userScores, role) {
  let distance = 0;
  for (const dimension of content.dimensions) {
    distance += Math.abs(
      userScores[dimension.id] - role.target[dimension.id],
    );
  }
  let score = 100 - distance / content.dimensions.length;
  if (
    role.id === "gps" &&
    !(userScores.N >= 80 && (userScores.O + userScores.A) / 2 >= 70)
  ) {
    score -= 20;
  }
  return score;
}

function getElectricityMode(scores) {
  if (scores.B >= 65 && scores.H < 55) {
    return {
      name: "潜水省电型",
      description:
        "群聊热度不是唯一的连接方式。低频回复、固定冒泡或私聊深聊，都能让关系保持稳定。",
      tip: "不必勉强自己跟上每一次刷屏，但可以约定一个固定冒泡节奏，让重要的人知道你在。",
    };
  }
  if (scores.B >= 55 && scores.H >= 65) {
    return {
      name: "间歇满电型",
      description:
        "在热闹场合能快速上线，但连续社交后需要明显恢复。提前说明节奏，比硬撑更有利于长期相处。",
      tip: "聚会当下可以尽情参与，散场后直说“我先充电，明天再聊”，比突然消失更容易被理解。",
    };
  }
  if (scores.B < 55 && scores.H >= 65) {
    return {
      name: "常驻在线型",
      description:
        "群聊启动和即时回应都比较顺手。也要给安静成员留出参与空间，不用把每一次冷场都当成任务。",
      tip: "把即时回应当成你的优势，而不是默认值班；抛完话题后留一点空白，让慢热的人也能接上。",
    };
  }
  return {
    name: "弹性在线型",
    description:
      "社交投入会随对象、场合和当天电量变化。提前说清预期，通常比维持固定人设更舒服。",
    tip: "在进入热闹群聊前给自己定一个大致时段，结束时留一句交代，热情和边界就不用互相打架。",
  };
}

function publicRoleSnapshot(role) {
  const snapshot = {
    id: role.id,
    name: role.name,
    keywords: role.keywords,
    oneSentence: role.oneSentence,
    target: role.target,
    highlight: role.highlight,
    theory: role.theory,
    friendView: role.friendView,
    bestPartner: role.bestPartner,
    mismatchPartner: role.mismatchPartner,
  };
  if (role.practice) snapshot.practice = role.practice;
  return snapshot;
}

function buildResult(answers) {
  const scores = calculateDimensionScores(answers);
  const scoreValues = Object.values(scores);
  const spread = Math.max(...scoreValues) - Math.min(...scoreValues);
  const isSpecial = spread < 12;
  const ranked = content.roles
    .map((role) => ({ role, score: matchScore(scores, role) }))
    .sort((a, b) => b.score - a.score);

  let selectedRole;
  let secondaryRole = null;
  let relationType = null;
  let fitScore;

  if (isSpecial) {
    selectedRole = content.specialRole;
    fitScore = Math.max(0, 100 - spread);
  } else {
    selectedRole = ranked[0].role;
    fitScore = Math.round(ranked[0].score);
    const difference = ranked[0].score - ranked[1].score;
    secondaryRole = ranked[1].role;
    relationType =
      difference > 10
        ? "单核岗位"
        : difference >= 4
          ? "主岗位 + 副岗位"
          : "双岗位组合";
  }

  return {
    role: publicRoleSnapshot(selectedRole),
    secondaryRole: secondaryRole
      ? {
          id: secondaryRole.id,
          code: secondaryRole.code,
          name: secondaryRole.name,
          keywords: secondaryRole.keywords,
          oneSentence: secondaryRole.oneSentence,
        }
      : null,
    relationType,
    fitScore: Math.max(0, Math.min(100, Math.round(fitScore))),
    scores,
    spread,
    electricity: getElectricityMode(scores),
    isSpecial,
  };
}

function resultPayload(record) {
  const test = state.tests[record.testId];
  const currentRole =
    roleMap.get(record.analysis.role.id) || record.analysis.role;
  const currentSecondaryRole = record.analysis.secondaryRole
    ? roleMap.get(record.analysis.secondaryRole.id) ||
      record.analysis.secondaryRole
    : null;
  return {
    id: record.id,
    createdAt: record.createdAt,
    role: publicRoleSnapshot(currentRole),
    secondaryRole: currentSecondaryRole
      ? {
          id: currentSecondaryRole.id,
          name: currentSecondaryRole.name,
          keywords: currentSecondaryRole.keywords,
          oneSentence: currentSecondaryRole.oneSentence,
        }
      : null,
    relationType: record.analysis.relationType,
    fitScore: record.analysis.fitScore,
    scores: record.analysis.scores,
    target: record.analysis.role.target,
    electricity: record.analysis.electricity,
    isSpecial: record.analysis.isSpecial,
    testsRemaining: remainingForPassword(test.passwordId),
    shareCount: record.shareIds.length,
    maxShares: MAX_SHARES_PER_RESULT,
    dimensionMeta: content.dimensions,
  };
}

function sharedResultPayload(record) {
  const payload = resultPayload(record);
  return {
    id: payload.id,
    createdAt: payload.createdAt,
    role: payload.role,
    secondaryRole: payload.secondaryRole,
    relationType: payload.relationType,
    fitScore: payload.fitScore,
    scores: payload.scores,
    target: payload.target,
    electricity: payload.electricity,
    isSpecial: payload.isSpecial,
    dimensionMeta: payload.dimensionMeta,
  };
}

function applyTestHeaders(response) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response, statusCode, payload) {
  applyTestHeaders(response);
  response.writeHead(statusCode);
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) {
      const error = new Error("请求内容过大");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求内容不是有效 JSON");
    error.statusCode = 400;
    throw error;
  }
}

function getClientIp(request) {
  return (
    String(request.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    request.socket.remoteAddress ||
    "unknown"
  );
}

function checkUnlockRateLimit(ip) {
  const now = Date.now();
  const entry = unlockAttempts.get(ip);
  if (!entry || entry.resetAt < now) return true;
  return entry.count < 12;
}

function recordUnlockFailure(ip) {
  const now = Date.now();
  const entry = unlockAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    unlockAttempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return;
  }
  entry.count += 1;
}

async function findPassword(password) {
  const record = passwordByLookup.get(hashPasswordLookup(password));
  if (!record) return null;
  const hash = await scrypt(password, record.salt);
  if (
    hash.length === record.hash.length &&
    crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(record.hash))
  ) {
    return record;
  }
  return null;
}

async function handleApi(request, response, url) {
  if (url.pathname.startsWith("/api/admin/")) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, { ok: true, version: content.meta.title });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/status") {
    return sendJson(response, 200, {
      configured: Boolean(adminConfig),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/login") {
    if (!adminConfig) {
      return sendJson(response, 503, {
        error: "管理员密码尚未初始化",
      });
    }
    const ip = getClientIp(request);
    if (!checkAdminLoginRateLimit(ip)) {
      return sendJson(response, 429, {
        error: "登录尝试过多，请 15 分钟后再试",
      });
    }
    const body = await readJson(request);
    const password = normalizeAdminPassword(body.password);
    if (!(await verifyAdminPassword(password))) {
      recordAdminLoginFailure(ip);
      return sendJson(response, 401, { error: "管理员密码不正确" });
    }
    adminLoginAttempts.delete(ip);
    const session = createAdminToken();
    return sendJson(response, 200, {
      adminToken: session.token,
      expiresAt: session.expiresAt,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/inventory") {
    if (!authenticateAdmin(request)) {
      return sendJson(response, 401, { error: "管理员登录已失效" });
    }
    return sendJson(response, 200, buildInventorySummary());
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/admin/codes/generate"
  ) {
    if (!authenticateAdmin(request)) {
      return sendJson(response, 401, { error: "管理员登录已失效" });
    }
    const body = await readJson(request);
    const generated = await queueCodeBatchGeneration(body);
    return sendJson(response, 201, generated);
  }

  const batchExportMatch = url.pathname.match(
    /^\/api\/admin\/batches\/([^/]+)\/export$/,
  );
  if (request.method === "GET" && batchExportMatch) {
    if (!authenticateAdmin(request)) {
      return sendJson(response, 401, { error: "管理员登录已失效" });
    }
    const batch = state.codeBatches[batchExportMatch[1]];
    if (!batch) {
      return sendJson(response, 404, { error: "卡密批次不存在" });
    }
    return sendJson(response, 200, {
      batch: batchPayload(batch),
      codes: exportCodeBatch(batch),
      maxTests: MAX_TESTS_PER_PASSWORD,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/content") {
    return sendJson(response, 200, {
      meta: content.meta,
      scale: content.scale,
      dimensions: content.dimensions,
      questions: content.questions.map((question) => ({
        id: question.id,
        text: question.text,
        dimension: question.dimension,
      })),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/unlock") {
    const ip = getClientIp(request);
    if (!checkUnlockRateLimit(ip)) {
      return sendJson(response, 429, {
        error: "尝试次数过多，请十分钟后再试。",
      });
    }
    const body = await readJson(request);
    const normalized = normalizePassword(body.password);
    if (!normalized) {
      return sendJson(response, 400, { error: "请输入测试密码。" });
    }
    const password = await findPassword(normalized);
    if (!password) {
      recordUnlockFailure(ip);
      return sendJson(response, 401, { error: "测试密码不正确。" });
    }
    const remaining = remainingForPassword(password.id);
    if (remaining <= 0) {
      return sendJson(response, 403, {
        error: "这个测试密码的 3 次机会已经用完。",
        remaining: 0,
      });
    }
    return sendJson(response, 200, {
      unlockToken: createUnlockToken(password.id),
      remaining,
      maxTests: MAX_TESTS_PER_PASSWORD,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/tests/start") {
    const body = await readJson(request);
    const payload = verifyUnlockToken(body.unlockToken);
    if (!payload) {
      return sendJson(response, 401, {
        error: "测试凭证已失效，请重新输入密码。",
      });
    }
    const password = consumeAttempt(payload.passwordId);
    if (!password) {
      return sendJson(response, 403, {
        error: "这个测试密码的 3 次机会已经用完。",
        remaining: 0,
      });
    }
    const { test, token } = createTestRecord(password.id);
    await persistState();
    return sendJson(response, 201, {
      testId: test.id,
      testToken: token,
      remaining: remainingForPassword(password.id),
      answers: {},
      currentIndex: 0,
    });
  }

  const testMatch = url.pathname.match(/^\/api\/tests\/([^/]+)$/);
  if (request.method === "GET" && testMatch) {
    const test = authenticateTest(request, testMatch[1]);
    if (!test) return sendJson(response, 401, { error: "无法读取这次测试。" });
    return sendJson(response, 200, {
      testId: test.id,
      status: test.status,
      answers: test.answers,
      currentIndex: test.currentIndex,
      resultId: test.resultId,
      remaining: remainingForPassword(test.passwordId),
    });
  }

  const progressMatch = url.pathname.match(
    /^\/api\/tests\/([^/]+)\/progress$/,
  );
  if (request.method === "PUT" && progressMatch) {
    const test = authenticateTest(request, progressMatch[1]);
    if (!test) return sendJson(response, 401, { error: "无法保存这次测试。" });
    if (test.status !== "active") {
      return sendJson(response, 409, { error: "这次测试已经提交。" });
    }
    const body = await readJson(request);
    const validation = validateAnswers(body.answers);
    if (!validation.valid) {
      return sendJson(response, 400, { error: validation.message });
    }
    test.answers = validation.answers;
    test.currentIndex = Math.max(
      0,
      Math.min(
        content.questions.length - 1,
        Number.isInteger(body.currentIndex) ? body.currentIndex : 0,
      ),
    );
    test.updatedAt = new Date().toISOString();
    await persistState();
    return sendJson(response, 200, {
      saved: true,
      answered: Object.keys(test.answers).length,
    });
  }

  const submitMatch = url.pathname.match(
    /^\/api\/tests\/([^/]+)\/submit$/,
  );
  if (request.method === "POST" && submitMatch) {
    const test = authenticateTest(request, submitMatch[1]);
    if (!test) return sendJson(response, 401, { error: "无法提交这次测试。" });
    if (test.status === "completed" && test.resultId) {
      return sendJson(response, 200, {
        resultId: test.resultId,
        alreadySubmitted: true,
      });
    }
    if (test.status !== "active") {
      return sendJson(response, 409, { error: "这次测试当前不能提交。" });
    }
    const body = await readJson(request);
    const validation = validateAnswers(body.answers, true);
    if (!validation.valid) {
      return sendJson(response, 400, { error: validation.message });
    }
    const analysis = buildResult(validation.answers);
    const result = {
      id: crypto.randomUUID(),
      testId: test.id,
      createdAt: new Date().toISOString(),
      analysis,
      shareIds: [],
    };
    state.results[result.id] = result;
    test.answers = validation.answers;
    test.status = "completed";
    test.resultId = result.id;
    test.updatedAt = new Date().toISOString();
    await persistState();
    return sendJson(response, 201, resultPayload(result));
  }

  const retakeMatch = url.pathname.match(
    /^\/api\/tests\/([^/]+)\/retake$/,
  );
  if (request.method === "POST" && retakeMatch) {
    const oldTest = authenticateTest(request, retakeMatch[1]);
    if (!oldTest) return sendJson(response, 401, { error: "无法再次测试。" });
    if (oldTest.status !== "completed") {
      return sendJson(response, 409, { error: "请先完成当前测试。" });
    }
    const password = consumeAttempt(oldTest.passwordId);
    if (!password) {
      return sendJson(response, 403, {
        error: "这个测试密码的 3 次机会已经用完。",
        remaining: 0,
      });
    }
    const { test, token } = createTestRecord(password.id);
    await persistState();
    return sendJson(response, 201, {
      testId: test.id,
      testToken: token,
      remaining: remainingForPassword(password.id),
      answers: {},
      currentIndex: 0,
    });
  }

  const resultMatch = url.pathname.match(/^\/api\/results\/([^/]+)$/);
  if (request.method === "GET" && resultMatch) {
    const result = state.results[resultMatch[1]];
    if (!result) return sendJson(response, 404, { error: "结果不存在。" });
    const test = authenticateTest(request, result.testId);
    if (!test) return sendJson(response, 401, { error: "无法读取这次结果。" });
    return sendJson(response, 200, resultPayload(result));
  }

  const shareMatch = url.pathname.match(
    /^\/api\/results\/([^/]+)\/share$/,
  );
  const inviteMatch = url.pathname.match(
    /^\/api\/results\/([^/]+)\/invite$/,
  );
  const shareRouteMatch = shareMatch || inviteMatch;
  if (request.method === "POST" && shareRouteMatch) {
    const result = state.results[shareRouteMatch[1]];
    if (!result) return sendJson(response, 404, { error: "结果不存在。" });
    const test = authenticateTest(request, result.testId);
    if (!test) return sendJson(response, 401, { error: "无法使用邀请好友额度。" });
    if (result.shareIds.length >= MAX_SHARES_PER_RESULT) {
      return sendJson(response, 429, {
        error: "本次结果的 3 次邀请好友额度已经用完。",
        shareCount: result.shareIds.length,
        maxShares: MAX_SHARES_PER_RESULT,
        remainingShares: 0,
      });
    }
    const kind = inviteMatch ? "invite" : "result";
    const shareToken = crypto.randomBytes(18).toString("base64url");
    state.shares[shareToken] = {
      resultId: result.id,
      kind,
      createdAt: new Date().toISOString(),
      views: 0,
    };
    result.shareIds.push(shareToken);
    await persistState();
    const protocol = request.headers["x-forwarded-proto"] || "http";
    const host = request.headers.host || `${HOST}:${PORT}`;
    const origin = `${protocol}://${host}`;
    return sendJson(response, 201, {
      shareToken,
      kind,
      shareUrl:
        kind === "invite" ? `${origin}/` : `${origin}/s/${shareToken}`,
      shareCount: result.shareIds.length,
      maxShares: MAX_SHARES_PER_RESULT,
      remainingShares: MAX_SHARES_PER_RESULT - result.shareIds.length,
    });
  }

  const sharedMatch = url.pathname.match(/^\/api\/shared\/([^/]+)$/);
  if (request.method === "GET" && sharedMatch) {
    const share = state.shares[sharedMatch[1]];
    if (!share || share.kind === "invite") {
      return sendJson(response, 404, { error: "分享链接无效。" });
    }
    const result = state.results[share.resultId];
    if (!result) return sendJson(response, 404, { error: "结果不存在。" });
    share.views += 1;
    await persistState();
    return sendJson(response, 200, sharedResultPayload(result));
  }

  return sendJson(response, 404, { error: "接口不存在。" });
}

function setSecurityHeaders(response) {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Frame-Options", "DENY");
}

async function serveStatic(response, pathname) {
  let relativePath;
  if (pathname === "/" || pathname.startsWith("/s/")) {
    relativePath = "index.html";
  } else if (pathname === "/admin" || pathname === "/admin/") {
    relativePath = "admin.html";
  } else {
    relativePath = decodeURIComponent(pathname).replace(/^\/+/, "");
  }
  if (relativePath.includes("\0")) {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }
  let filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
    const extension = path.extname(filePath).toLowerCase();
    const contents = await fsp.readFile(filePath);
    setSecurityHeaders(response);
    if (relativePath === "admin.html") {
      response.setHeader("X-Robots-Tag", "noindex, nofollow");
    }
    response.setHeader(
      "Content-Type",
      MIME_TYPES[extension] || "application/octet-stream",
    );
    response.setHeader(
      "Cache-Control",
      relativePath === "admin.html"
        ? "no-store"
        : extension === ".html"
        ? "no-cache"
        : "public, max-age=3600, must-revalidate",
    );
    response.writeHead(200);
    response.end(contents);
  } catch (error) {
    if (error.code === "ENOENT") {
      const index = await fsp.readFile(path.join(PUBLIC_DIR, "index.html"));
      setSecurityHeaders(response);
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache");
      response.writeHead(200);
      response.end(index);
      return;
    }
    throw error;
  }
}

async function requestHandler(request, response) {
  try {
    const url = new URL(
      request.url,
      `http://${request.headers.host || `${HOST}:${PORT}`}`,
    );
    if (url.pathname.startsWith("/api/")) {
      return await handleApi(request, response, url);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405);
      response.end("Method not allowed");
      return;
    }
    return await serveStatic(response, url.pathname);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) {
      setSecurityHeaders(response);
      applyTestHeaders(response);
      response.writeHead(error.statusCode || 500);
      response.end(
        JSON.stringify({
          error:
            error.statusCode && error.statusCode < 500
              ? error.message
              : "服务器暂时开小差，请稍后再试。",
        }),
      );
    } else {
      response.end();
    }
  }
}

async function startServer() {
  await loadState();
  await loadAdminConfig();
  const server = http.createServer(requestHandler);
  return new Promise((resolve) => {
    server.listen(PORT, HOST, () => {
      console.log(
        `朋友圈岗位图鉴运行中：http://${HOST}:${PORT}（密码使用上限 ${MAX_TESTS_PER_PASSWORD} 次）`,
      );
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildResult,
  calculateDimensionScores,
  content,
  getElectricityMode,
  matchScore,
  startServer,
  validateAnswers,
  validateContent,
};

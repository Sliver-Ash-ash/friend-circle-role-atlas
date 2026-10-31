import content from "./content.json" with { type: "json" };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const APP_SECRET = Deno.env.get("APP_SECRET") || "";
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") || "";
const LEGACY_LOOKUP_SECRET = Deno.env.get("LEGACY_LOOKUP_SECRET") || "";
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "*")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const MAX_TESTS_PER_CODE = 3;
const MAX_SHARES_PER_RESULT = 3;
const UNLOCK_TTL_SECONDS = 24 * 60 * 60;
const ADMIN_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const ACCESS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const encoder = new TextEncoder();

const questionMap = new Map(
  content.questions.map((question: Record<string, unknown>) => [
    Number(question.id),
    question,
  ]),
);
const roleMap = new Map(
  [...content.roles, content.specialRole].map((role: Record<string, unknown>) => [
    String(role.id),
    role,
  ]),
);

class ApiError extends Error {
  status: number;
  payload: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    payload: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.payload = { error: message, ...payload };
  }
}

interface DbOptions {
  method?: string;
  body?: unknown;
  prefer?: string;
}

interface TestRecord {
  id: string;
  access_code_id: string | null;
  token_hash: string;
  status: string;
  answers: Record<string, number>;
  current_index: number;
  result_id: string | null;
  started_at: string;
  access_codes: {
    id: string;
    max_tests: number;
    used_tests: number;
  } | null;
}

interface ResultRecord {
  id: string;
  test_id: string;
  access_code_id: string | null;
  role_id: string;
  is_special: boolean;
  scores: Record<string, number>;
  target: Record<string, number>;
  fit_score: number;
  secondary_role_id: string | null;
  relation_type: string | null;
  electricity: Record<string, unknown>;
  created_at: string;
}

interface BatchRecord {
  id: string;
  label: string;
  item_count: number;
  version: number;
  legacy_nonce: string | null;
  created_at: string;
}

function getCorsHeaders(request: Request) {
  const origin = request.headers.get("origin") || "";
  const allowOrigin =
    ALLOWED_ORIGINS.includes("*") || !origin
      ? "*"
      : ALLOWED_ORIGINS.includes(origin)
        ? origin
        : ALLOWED_ORIGINS[0] || "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-app-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(
  request: Request,
  status: number,
  payload: Record<string, unknown>,
) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...getCorsHeaders(request),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function cleanBatchLabel(value: unknown) {
  const label = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return label || "未命名批次";
}

function normalizeAccessCode(value: unknown) {
  return String(value || "").trim().toUpperCase();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toHex(bytes: Uint8Array) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(value: Uint8Array | string) {
  const bytes =
    typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toHex(new Uint8Array(digest));
}

async function hmacBytes(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  );
  return new Uint8Array(signature);
}

async function hmacHex(value: string, secret: string) {
  return toHex(await hmacBytes(value, secret));
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function createSignedToken(
  type: "unlock" | "admin",
  id: string,
  ttlSeconds: number,
) {
  const payload = toBase64Url(
    JSON.stringify({
      type,
      id,
      expiresAt: Date.now() + ttlSeconds * 1000,
    }),
  );
  const signature = toBase64Url(await hmacBytes(payload, APP_SECRET));
  return {
    token: `${payload}.${signature}`,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };
}

async function verifySignedToken(
  token: string,
  expectedType: "unlock" | "admin",
) {
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  const expected = toBase64Url(await hmacBytes(payload, APP_SECRET));
  if (!signature || !safeEqual(signature, expected)) return null;
  try {
    const decoded = JSON.parse(fromBase64Url(payload));
    if (
      decoded.type !== expectedType ||
      Number(decoded.expiresAt) < Date.now() ||
      typeof decoded.id !== "string"
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

async function db(pathname: string, options: DbOptions = {}) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_RUNTIME_NOT_CONFIGURED");
  }
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    method: options.method || "GET",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      Accept: "application/json",
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    console.error("Supabase database request failed", response.status, payload);
    const message = isObject(payload) ? String(payload.message || "") : "";
    throw new Error(`DB_REQUEST_FAILED:${response.status}:${message}`);
  }
  return payload;
}

async function rpc(name: string, body: Record<string, unknown>) {
  return db(`rpc/${name}`, { method: "POST", body });
}

async function selectOne(table: string, query: string) {
  const rows = await db(`${table}?${query}`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function checkRateLimit(key: string, limit: number, windowSeconds: number) {
  const result = await rpc("check_rate_limit", {
    p_rate_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  return result === true;
}

function publicRoleSnapshot(role: Record<string, unknown>) {
  const snapshot: Record<string, unknown> = {
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

function publicSecondaryRoleSnapshot(role: Record<string, unknown>) {
  return {
    id: role.id,
    name: role.name,
    keywords: role.keywords,
    oneSentence: role.oneSentence,
  };
}

function validateAnswers(
  input: unknown,
  requireComplete = false,
): { valid: boolean; message?: string; answers: Record<number, number> } {
  if (!isObject(input)) {
    return { valid: false, message: "答案格式不正确", answers: {} };
  }
  const answers: Record<number, number> = {};
  for (const [key, value] of Object.entries(input)) {
    const questionId = Number(key);
    const score = Number(value);
    if (!questionMap.has(questionId)) {
      return {
        valid: false,
        message: "答案中包含未知题目",
        answers: {},
      };
    }
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return {
        valid: false,
        message: "每道题只能选择 1 至 5 分",
        answers: {},
      };
    }
    answers[questionId] = score;
  }
  if (requireComplete && Object.keys(answers).length !== content.questions.length) {
    return { valid: false, message: "还有题目没有完成", answers: {} };
  }
  return { valid: true, answers };
}

function calculateDimensionScores(answers: Record<number, number>) {
  const rawTotals: Record<string, number> = Object.fromEntries(
    content.dimensions.map((dimension: Record<string, unknown>) => [
      String(dimension.id),
      0,
    ]),
  );
  const questionCounts: Record<string, number> = Object.fromEntries(
    content.dimensions.map((dimension: Record<string, unknown>) => [
      String(dimension.id),
      0,
    ]),
  );
  for (const question of content.questions) {
    const raw = answers[Number(question.id)];
    const score = question.reverse ? 6 - raw : raw;
    rawTotals[question.dimension] += score;
    questionCounts[question.dimension] += 1;
  }
  return Object.fromEntries(
    content.dimensions.map((dimension: Record<string, unknown>) => {
      const id = String(dimension.id);
      return [
        id,
        Math.round(
          ((rawTotals[id] - questionCounts[id]) /
            (questionCounts[id] * 4)) *
            100,
        ),
      ];
    }),
  );
}

function matchScore(
  userScores: Record<string, number>,
  role: Record<string, unknown>,
) {
  const target = isObject(role.target) ? role.target : {};
  let distance = 0;
  for (const dimension of content.dimensions) {
    const id = String(dimension.id);
    distance += Math.abs(userScores[id] - Number(target[id]));
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

function getElectricityMode(scores: Record<string, number>) {
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

function buildAnalysis(answers: Record<number, number>) {
  const scores = calculateDimensionScores(answers);
  const scoreValues = Object.values(scores);
  const spread = Math.max(...scoreValues) - Math.min(...scoreValues);
  const isSpecial = spread < 12;
  const ranked = content.roles
    .map((role: Record<string, unknown>) => ({
      role,
      score: matchScore(scores, role),
    }))
    .sort((left, right) => right.score - left.score);

  let selectedRole: Record<string, unknown>;
  let secondaryRole: Record<string, unknown> | null = null;
  let relationType: string | null = null;
  let fitScore: number;

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
    selectedRole,
    secondaryRole,
    relationType,
    fitScore: Math.max(0, Math.min(100, Math.round(fitScore))),
    scores,
    electricity: getElectricityMode(scores),
    isSpecial,
  };
}

function testPayload(test: TestRecord) {
  const access = test.access_codes;
  return {
    testId: test.id,
    status: test.status,
    answers: test.answers || {},
    currentIndex: Number(test.current_index) || 0,
    resultId: test.result_id,
    remaining: access
      ? Math.max(0, Number(access.max_tests) - Number(access.used_tests))
      : null,
  };
}

async function getAccessCode(accessCodeId: string | null) {
  if (!accessCodeId) return null;
  return selectOne(
    "access_codes",
    `id=eq.${encodeURIComponent(accessCodeId)}&select=id,max_tests,used_tests`,
  );
}

async function getShareCount(resultId: string) {
  const rows = await db(
    `shares?result_id=eq.${encodeURIComponent(resultId)}&select=id`,
  );
  return Array.isArray(rows) ? rows.length : 0;
}

async function resultPayload(record: ResultRecord) {
  const currentRole = roleMap.get(record.role_id) || content.specialRole;
  const currentSecondaryRole = record.secondary_role_id
    ? roleMap.get(record.secondary_role_id) || null
    : null;
  const [accessCode, shareCount] = await Promise.all([
    getAccessCode(record.access_code_id),
    getShareCount(record.id),
  ]);
  return {
    id: record.id,
    createdAt: record.created_at,
    role: publicRoleSnapshot(currentRole),
    secondaryRole: currentSecondaryRole
      ? publicSecondaryRoleSnapshot(currentSecondaryRole)
      : null,
    relationType: record.relation_type,
    fitScore: Number(record.fit_score),
    scores: record.scores,
    target: currentRole.target || record.target,
    electricity: record.electricity,
    isSpecial: record.is_special,
    testsRemaining: accessCode
      ? Math.max(0, Number(accessCode.max_tests) - Number(accessCode.used_tests))
      : null,
    shareCount,
    maxShares: MAX_SHARES_PER_RESULT,
    dimensionMeta: content.dimensions,
  };
}

async function sharedResultPayload(record: ResultRecord) {
  const payload = await resultPayload(record);
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

async function getResult(resultId: string) {
  return (await selectOne(
    "results",
    `id=eq.${encodeURIComponent(resultId)}&select=*`,
  )) as ResultRecord | null;
}

async function authenticateTest(testId: string, token: string) {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return (await selectOne(
    "tests",
    `id=eq.${encodeURIComponent(testId)}&token_hash=eq.${encodeURIComponent(tokenHash)}&select=id,access_code_id,token_hash,status,answers,current_index,result_id,started_at,access_codes(id,max_tests,used_tests)`,
  )) as TestRecord | null;
}

async function createTest(accessCodeId: string | null) {
  const testId = crypto.randomUUID();
  const testToken = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256Hex(testToken);
  const result = accessCodeId
    ? await rpc("start_test", {
        p_access_code_id: accessCodeId,
        p_test_id: testId,
        p_token_hash: tokenHash,
      })
    : await rpc("start_public_test", {
        p_test_id: testId,
        p_token_hash: tokenHash,
      });
  const row = Array.isArray(result) ? result[0] : result;
  return {
    testId,
    testToken,
    remaining: accessCodeId ? Number(row?.remaining ?? 0) : null,
    answers: {},
    currentIndex: 0,
  };
}

function deriveCodeFromDigest(digest: Uint8Array) {
  let body = "";
  for (let offset = 0; offset < 8; offset += 1) {
    body += ACCESS_CODE_ALPHABET[digest[offset] % ACCESS_CODE_ALPHABET.length];
  }
  return `FC-${body.slice(0, 4)}-${body.slice(4)}`;
}

async function deriveCodeV2(batchId: string, index: number) {
  const digest = await hmacBytes(
    `friend-circle-code-v2:${batchId}:${index}`,
    APP_SECRET,
  );
  return deriveCodeFromDigest(digest);
}

async function deriveCodeV1(
  batchId: string,
  nonce: string,
  index: number,
  attempt: number,
) {
  if (!LEGACY_LOOKUP_SECRET) {
    throw new Error("LEGACY_LOOKUP_SECRET_REQUIRED");
  }
  const digest = await hmacBytes(
    `friend-circle-code-v1:${batchId}:${nonce}:${index}:${attempt}`,
    LEGACY_LOOKUP_SECRET,
  );
  return deriveCodeFromDigest(digest);
}

async function hashCode(code: string) {
  return hmacHex(code, APP_SECRET);
}

function batchPayload(batch: BatchRecord) {
  return {
    id: batch.id,
    label: batch.label,
    count: batch.item_count,
    createdAt: batch.created_at,
  };
}

function getClientIp(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function buildShareUrl(siteUrl: unknown, token: string) {
  try {
    const url = new URL(String(siteUrl || ""));
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    url.search = "";
    url.hash = "";
    url.searchParams.set("share", token);
    return url.toString();
  } catch {
    return `?share=${encodeURIComponent(token)}`;
  }
}

async function handleContent() {
  return {
    meta: content.meta,
    scale: content.scale,
    dimensions: content.dimensions,
    questions: content.questions.map((question: Record<string, unknown>) => ({
      id: question.id,
      text: question.text,
      dimension: question.dimension,
    })),
  };
}

async function handleUnlock(request: Request, body: Record<string, unknown>) {
  const ip = getClientIp(request);
  if (!(await checkRateLimit(`unlock:${ip}`, 20, 10 * 60))) {
    throw new ApiError(429, "尝试次数过多，请十分钟后再试。");
  }
  const normalized = normalizeAccessCode(body.password);
  if (!normalized) throw new ApiError(400, "请输入测试密码。");

  const lookupHash = await hashCode(normalized);
  let accessCode = await selectOne(
    "access_codes",
    `code_lookup_hash=eq.${encodeURIComponent(lookupHash)}&select=id,max_tests,used_tests`,
  );

  if (!accessCode && LEGACY_LOOKUP_SECRET) {
    const legacyHash = await hmacHex(normalized, LEGACY_LOOKUP_SECRET);
    accessCode = await selectOne(
      "access_codes",
      `legacy_lookup_hash=eq.${encodeURIComponent(legacyHash)}&select=id,max_tests,used_tests`,
    );
    if (accessCode) {
      await db(
        `access_codes?id=eq.${encodeURIComponent(String(accessCode.id))}`,
        {
          method: "PATCH",
          body: { code_lookup_hash: lookupHash, updated_at: new Date().toISOString() },
          prefer: "return=minimal",
        },
      ).catch(() => {});
    }
  }

  if (!accessCode) throw new ApiError(401, "测试密码不正确。");
  const remaining = Math.max(
    0,
    Number(accessCode.max_tests) - Number(accessCode.used_tests),
  );
  if (remaining <= 0) {
    throw new ApiError(403, "这个测试密码的 3 次机会已经用完。", {
      remaining: 0,
    });
  }
  const session = await createSignedToken(
    "unlock",
    String(accessCode.id),
    UNLOCK_TTL_SECONDS,
  );
  return {
    status: 200,
    payload: {
      unlockToken: session.token,
      remaining,
      maxTests: Number(accessCode.max_tests),
    },
  };
}

async function handleAdminLogin(request: Request, body: Record<string, unknown>) {
  if (!ADMIN_PASSWORD) throw new ApiError(503, "管理员密码尚未初始化。");
  const ip = getClientIp(request);
  if (!(await checkRateLimit(`admin-login:${ip}`, 8, 15 * 60))) {
    throw new ApiError(429, "登录尝试过多，请 15 分钟后再试。");
  }
  const submitted = String(body.password || "");
  const [submittedHash, expectedHash] = await Promise.all([
    sha256Hex(submitted),
    sha256Hex(ADMIN_PASSWORD),
  ]);
  if (!safeEqual(submittedHash, expectedHash)) {
    throw new ApiError(401, "管理员密码不正确。");
  }
  const session = await createSignedToken(
    "admin",
    "admin",
    ADMIN_TOKEN_TTL_SECONDS,
  );
  return {
    status: 200,
    payload: {
      adminToken: session.token,
      expiresAt: session.expiresAt,
    },
  };
}

async function requireAdmin(appToken: string) {
  const payload = await verifySignedToken(appToken, "admin");
  if (!payload) throw new ApiError(401, "管理员登录已失效。");
}

async function buildInventory() {
  const [codes, batches] = await Promise.all([
    db("access_codes?select=batch_id,max_tests,used_tests"),
    db(
      "code_batches?select=id,label,item_count,created_at&order=created_at.desc&limit=30",
    ),
  ]);
  const allCodes = Array.isArray(codes) ? codes : [];
  const allBatches = Array.isArray(batches) ? batches : [];
  let untouchedCodes = 0;
  let partiallyUsedCodes = 0;
  let exhaustedCodes = 0;
  let totalUses = 0;
  let totalCapacity = 0;

  for (const code of allCodes) {
    const used = Number(code.used_tests);
    const maxTests = Number(code.max_tests);
    totalUses += used;
    totalCapacity += maxTests;
    if (used === 0) untouchedCodes += 1;
    else if (used >= maxTests) exhaustedCodes += 1;
    else partiallyUsedCodes += 1;
  }

  const batchSummaries = allBatches.map((batch: Record<string, unknown>) => {
    const batchCodes = allCodes.filter(
      (code: Record<string, unknown>) => code.batch_id === batch.id,
    );
    return {
      ...batchPayload(batch as unknown as BatchRecord),
      testStarts: batchCodes.reduce(
        (total: number, code: Record<string, unknown>) =>
          total + Number(code.used_tests),
        0,
      ),
      remainingTests: batchCodes.reduce(
        (total: number, code: Record<string, unknown>) =>
          total + Math.max(0, Number(code.max_tests) - Number(code.used_tests)),
        0,
      ),
    };
  });

  return {
    totals: {
      totalCodes: allCodes.length,
      untouchedCodes,
      partiallyUsedCodes,
      exhaustedCodes,
      totalUses,
      totalCapacity,
    },
    batches: batchSummaries,
    batchCount: allBatchCount(allBatches),
    generatedAt: new Date().toISOString(),
  };
}

async function allBatchCount(recentBatches: unknown[]) {
  const rows = await db("code_batches?select=id");
  return Array.isArray(rows) ? rows.length : recentBatches.length;
}

async function generateBatch(body: Record<string, unknown>) {
  const count = Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new ApiError(400, "每次最多生成 100 个访问码。");
  }
  const batch: BatchRecord = {
    id: crypto.randomUUID(),
    label: cleanBatchLabel(body.label),
    item_count: count,
    version: 2,
    legacy_nonce: null,
    created_at: new Date().toISOString(),
  };
  await db("code_batches", {
    method: "POST",
    body: {
      id: batch.id,
      label: batch.label,
      item_count: batch.item_count,
      version: batch.version,
      created_at: batch.created_at,
    },
    prefer: "return=minimal",
  });

  try {
    const codes: string[] = [];
    const rows = [];
    for (let index = 0; index < count; index += 1) {
      const code = await deriveCodeV2(batch.id, index);
      codes.push(code);
      rows.push({
        id: crypto.randomUUID(),
        batch_id: batch.id,
        batch_index: index,
        legacy_attempt: 0,
        code_lookup_hash: await hashCode(code),
        max_tests: MAX_TESTS_PER_CODE,
        used_tests: 0,
        created_at: batch.created_at,
      });
    }
    await db("access_codes", {
      method: "POST",
      body: rows,
      prefer: "return=minimal",
    });
    return {
      status: 201,
      payload: {
        batch: batchPayload(batch),
        codes,
        maxTests: MAX_TESTS_PER_CODE,
      },
    };
  } catch (error) {
    await db(`code_batches?id=eq.${encodeURIComponent(batch.id)}`, {
      method: "DELETE",
      prefer: "return=minimal",
    }).catch(() => {});
    throw error;
  }
}

async function exportBatch(batchId: string) {
  const batch = (await selectOne(
    "code_batches",
    `id=eq.${encodeURIComponent(batchId)}&select=*`,
  )) as BatchRecord | null;
  if (!batch) throw new ApiError(404, "卡密批次不存在。");
  const rows = await db(
    `access_codes?batch_id=eq.${encodeURIComponent(batchId)}&select=batch_index,legacy_attempt&order=batch_index.asc`,
  );
  const codes = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const index = Number(row.batch_index);
    const attempt = Number(row.legacy_attempt || 0);
    codes.push(
      batch.version === 1 && batch.legacy_nonce
        ? await deriveCodeV1(batch.id, batch.legacy_nonce, index, attempt)
        : await deriveCodeV2(batch.id, index),
    );
  }
  return {
    status: 200,
    payload: {
      batch: batchPayload(batch),
      codes,
      maxTests: MAX_TESTS_PER_CODE,
    },
  };
}

async function handleRequest(request: Request) {
  const envelope = await request.json().catch(() => null);
  if (!isObject(envelope)) throw new ApiError(400, "请求格式不正确。");
  const pathname = String(envelope.path || "");
  const appToken = request.headers.get("x-app-token") || "";
  const body = isObject(envelope.body) ? envelope.body : {};

  if (pathname === "/api/health") {
    return { status: 200, payload: { ok: true, version: content.meta.title } };
  }
  if (pathname === "/api/content") {
    return { status: 200, payload: await handleContent() };
  }
  if (pathname === "/api/unlock") {
    return handleUnlock(request, body);
  }
  if (pathname === "/api/tests/start") {
    const ip = getClientIp(request);
    if (!(await checkRateLimit(`public-start:${ip}`, 30, 10 * 60))) {
      throw new ApiError(429, "开始测试过于频繁，请十分钟后再试。");
    }
    return {
      status: 201,
      payload: await createTest(null),
    };
  }

  const testMatch = pathname.match(/^\/api\/tests\/([^/]+)$/);
  if (testMatch) {
    const test = await authenticateTest(
      decodeURIComponent(testMatch[1]),
      appToken,
    );
    if (!test) throw new ApiError(401, "无法读取这次测试。");
    return { status: 200, payload: testPayload(test) };
  }

  const progressMatch = pathname.match(/^\/api\/tests\/([^/]+)\/progress$/);
  if (progressMatch) {
    const test = await authenticateTest(
      decodeURIComponent(progressMatch[1]),
      appToken,
    );
    if (!test) throw new ApiError(401, "无法保存这次测试。");
    if (test.status !== "active") {
      throw new ApiError(409, "这次测试已经提交。");
    }
    const validation = validateAnswers(body.answers);
    if (!validation.valid) throw new ApiError(400, validation.message || "答案格式不正确。");
    const currentIndex = Number.isInteger(body.currentIndex)
      ? Math.max(
          0,
          Math.min(content.questions.length - 1, Number(body.currentIndex)),
        )
      : 0;
    await db(`tests?id=eq.${encodeURIComponent(test.id)}`, {
      method: "PATCH",
      body: {
        answers: validation.answers,
        current_index: currentIndex,
        updated_at: new Date().toISOString(),
      },
      prefer: "return=minimal",
    });
    return {
      status: 200,
      payload: {
        saved: true,
        answered: Object.keys(validation.answers).length,
      },
    };
  }

  const submitMatch = pathname.match(/^\/api\/tests\/([^/]+)\/submit$/);
  if (submitMatch) {
    const test = await authenticateTest(
      decodeURIComponent(submitMatch[1]),
      appToken,
    );
    if (!test) throw new ApiError(401, "无法提交这次测试。");
    if (test.status === "completed" && test.result_id) {
      const existing = await getResult(test.result_id);
      if (existing) return { status: 200, payload: await resultPayload(existing) };
    }
    if (test.status !== "active") {
      throw new ApiError(409, "这次测试当前不能提交。");
    }
    const validation = validateAnswers(body.answers, true);
    if (!validation.valid) throw new ApiError(400, validation.message || "还有题目没有完成。");
    const analysis = buildAnalysis(validation.answers);
    const resultId = crypto.randomUUID();
    try {
      const persistedId = await rpc("submit_test_result", {
        p_result_id: resultId,
        p_test_id: test.id,
        p_access_code_id: test.access_code_id,
        p_role_id: String(analysis.selectedRole.id),
        p_is_special: analysis.isSpecial,
        p_scores: analysis.scores,
        p_target: analysis.selectedRole.target,
        p_fit_score: analysis.fitScore,
        p_secondary_role_id: analysis.secondaryRole
          ? String(analysis.secondaryRole.id)
          : null,
        p_relation_type: analysis.relationType,
        p_electricity: analysis.electricity,
        p_answers: validation.answers,
      });
      const record = await getResult(String(persistedId));
      if (!record) throw new Error("RESULT_NOT_PERSISTED");
      return { status: 201, payload: await resultPayload(record) };
    } catch (error) {
      if (String(error).includes("TEST_NOT_SUBMITTABLE")) {
        throw new ApiError(409, "这次测试当前不能提交。");
      }
      throw error;
    }
  }

  const retakeMatch = pathname.match(/^\/api\/tests\/([^/]+)\/retake$/);
  if (retakeMatch) {
    const oldTest = await authenticateTest(
      decodeURIComponent(retakeMatch[1]),
      appToken,
    );
    if (!oldTest) throw new ApiError(401, "无法再次测试。");
    if (oldTest.status !== "completed") {
      throw new ApiError(409, "请先完成当前测试。");
    }
    try {
      return {
        status: 201,
        payload: await createTest(oldTest.access_code_id),
      };
    } catch (error) {
      if (String(error).includes("ACCESS_EXHAUSTED")) {
        throw new ApiError(403, "这个测试密码的 3 次机会已经用完。", {
          remaining: 0,
        });
      }
      throw error;
    }
  }

  const resultMatch = pathname.match(/^\/api\/results\/([^/]+)$/);
  if (resultMatch) {
    const result = await getResult(decodeURIComponent(resultMatch[1]));
    if (!result) throw new ApiError(404, "结果不存在。");
    const test = await authenticateTest(result.test_id, appToken);
    if (!test) throw new ApiError(401, "无法读取这次结果。");
    return { status: 200, payload: await resultPayload(result) };
  }

  const inviteMatch = pathname.match(/^\/api\/results\/([^/]+)\/(?:invite|share)$/);
  if (inviteMatch) {
    const result = await getResult(decodeURIComponent(inviteMatch[1]));
    if (!result) throw new ApiError(404, "结果不存在。");
    const test = await authenticateTest(result.test_id, appToken);
    if (!test) throw new ApiError(401, "无法使用邀请好友额度。");
    const shareToken = toBase64Url(crypto.getRandomValues(new Uint8Array(18)));
    const shareTokenHash = await sha256Hex(shareToken);
    try {
      const count = Number(
        await rpc("create_result_share", {
          p_result_id: result.id,
          p_share_token_hash: shareTokenHash,
          p_kind: "result",
        }),
      );
      return {
        status: 201,
        payload: {
          shareToken,
          kind: "result",
          shareUrl: buildShareUrl(envelope.siteUrl, shareToken),
          shareCount: count,
          maxShares: MAX_SHARES_PER_RESULT,
          remainingShares: Math.max(0, MAX_SHARES_PER_RESULT - count),
        },
      };
    } catch (error) {
      if (String(error).includes("SHARE_LIMIT_REACHED")) {
        const count = await getShareCount(result.id);
        throw new ApiError(429, "本次结果的 3 次邀请好友额度已经用完。", {
          shareCount: count,
          maxShares: MAX_SHARES_PER_RESULT,
          remainingShares: 0,
        });
      }
      throw error;
    }
  }

  const sharedMatch = pathname.match(/^\/api\/shared\/([^/]+)$/);
  if (sharedMatch) {
    const token = decodeURIComponent(sharedMatch[1]);
    const tokenHash = await sha256Hex(token);
    const share = await selectOne(
      "shares",
      `token_hash=eq.${encodeURIComponent(tokenHash)}&kind=eq.result&select=id,result_id,views`,
    );
    if (!share) throw new ApiError(404, "分享链接无效。");
    const result = await getResult(String(share.result_id));
    if (!result) throw new ApiError(404, "结果不存在。");
    await db(`shares?id=eq.${encodeURIComponent(String(share.id))}`, {
      method: "PATCH",
      body: { views: Number(share.views || 0) + 1 },
      prefer: "return=minimal",
    }).catch(() => {});
    return { status: 200, payload: await sharedResultPayload(result) };
  }

  if (pathname === "/api/admin/status") {
    return { status: 200, payload: { configured: Boolean(ADMIN_PASSWORD) } };
  }
  if (pathname === "/api/admin/login") {
    return handleAdminLogin(request, body);
  }
  if (pathname === "/api/admin/inventory") {
    await requireAdmin(appToken);
    return { status: 200, payload: await buildInventory() };
  }
  if (pathname === "/api/admin/codes/generate") {
    await requireAdmin(appToken);
    return generateBatch(body);
  }
  const batchExportMatch = pathname.match(
    /^\/api\/admin\/batches\/([^/]+)\/export$/,
  );
  if (batchExportMatch) {
    await requireAdmin(appToken);
    return exportBatch(decodeURIComponent(batchExportMatch[1]));
  }

  throw new ApiError(404, "接口不存在。");
}

Deno.serve(async (request) => {
  const cors = getCorsHeaders(request);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return json(request, 405, { error: "仅支持 POST 请求。" });
  }
  if (!APP_SECRET) {
    return json(request, 503, { error: "Supabase Edge Function 尚未配置 APP_SECRET。" });
  }
  try {
    const result = await handleRequest(request);
    return json(request, result.status, result.payload);
  } catch (error) {
    if (error instanceof ApiError) {
      return json(request, error.status, error.payload);
    }
    console.error(error);
    return json(request, 500, {
      error: "服务暂时不可用，请稍后重试。",
    });
  }
});

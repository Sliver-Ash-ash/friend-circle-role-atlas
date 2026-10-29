const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const statePath = path.resolve(
  process.env.STATE_PATH || path.join(root, "data", "state.json"),
);
const apply = process.argv.includes("--apply");

function readState() {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildMigrationRows(state) {
  const batches = [];
  const attemptByPasswordId = new Map();

  for (const batch of Object.values(asObject(state.codeBatches))) {
    if (!batch?.id) continue;
    batches.push({
      id: String(batch.id),
      label: String(batch.label || "旧批次"),
      item_count: Number(batch.count || 0),
      version: 1,
      legacy_nonce: String(batch.nonce || ""),
      created_at: batch.createdAt || new Date().toISOString(),
    });
    for (const record of asArray(batch.records)) {
      if (record?.passwordId) {
        attemptByPasswordId.set(
          String(record.passwordId),
          Number(record.attempt || 0),
        );
      }
    }
  }

  const codes = [];
  for (const password of asArray(state.passwords)) {
    if (!password?.id || !password.lookupHash) {
      throw new Error("A password is missing id or lookupHash.");
    }
    codes.push({
      id: String(password.id),
      batch_id: password.batchId ? String(password.batchId) : null,
      batch_index:
        password.batchIndex === undefined || password.batchIndex === null
          ? null
          : Number(password.batchIndex),
      legacy_attempt: attemptByPasswordId.get(String(password.id)) || 0,
      code_lookup_hash: null,
      legacy_lookup_hash: String(password.lookupHash),
      max_tests: Number(password.maxTests || 3),
      used_tests: Number(password.usedTests || 0),
      created_at: password.createdAt || new Date().toISOString(),
      updated_at: password.createdAt || new Date().toISOString(),
    });
  }

  const tests = [];
  for (const test of Object.values(asObject(state.tests))) {
    if (!test?.id || !test.passwordId) continue;
    const status = test.status === "completed" ? "completed" : "active";
    tests.push({
      id: String(test.id),
      access_code_id: String(test.passwordId),
      token_hash: String(test.tokenHash || ""),
      status,
      answers: asObject(test.answers),
      current_index: Number(test.currentIndex || 0),
      result_id: null,
      started_at: test.createdAt || new Date().toISOString(),
      updated_at: test.updatedAt || test.createdAt || new Date().toISOString(),
      completed_at:
        status === "completed"
          ? test.updatedAt || test.completedAt || test.createdAt
          : null,
    });
  }

  const testsById = new Map(tests.map((test) => [test.id, test]));
  const results = [];
  for (const result of Object.values(asObject(state.results))) {
    if (!result?.id || !result.testId) continue;
    const test = testsById.get(String(result.testId));
    if (!test) throw new Error(`Result ${result.id} has no matching test.`);
    const analysis = asObject(result.analysis);
    const role = asObject(analysis.role);
    if (!role.id) throw new Error(`Result ${result.id} has no role id.`);
    results.push({
      id: String(result.id),
      test_id: test.id,
      access_code_id: test.access_code_id,
      role_id: String(role.id),
      is_special: Boolean(analysis.isSpecial),
      scores: asObject(analysis.scores),
      target: asObject(role.target),
      fit_score: Number(analysis.fitScore || 0),
      secondary_role_id:
        analysis.secondaryRole?.id
          ? String(analysis.secondaryRole.id)
          : null,
      relation_type: analysis.relationType || null,
      electricity: asObject(analysis.electricity),
      created_at: result.createdAt || new Date().toISOString(),
    });
    test.result_id = String(result.id);
  }

  const shares = [];
  for (const [token, share] of Object.entries(asObject(state.shares))) {
    if (!share?.resultId) continue;
    shares.push({
      id: crypto.randomUUID(),
      result_id: String(share.resultId),
      token_hash: sha256(token),
      kind: share.kind === "invite" ? "invite" : "result",
      views: Number(share.views || 0),
      created_at: share.createdAt || new Date().toISOString(),
    });
  }

  return { batches, codes, tests, results, shares };
}

async function request(method, pathname, body, supabaseUrl, serviceKey) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${pathname}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${method} ${pathname} failed (${response.status}): ${text.slice(0, 500)}`,
    );
  }
  return text ? JSON.parse(text) : null;
}

async function upsert(table, rows, supabaseUrl, serviceKey) {
  if (!rows.length) return;
  await request(
    "POST",
    `${table}?on_conflict=id`,
    rows,
    supabaseUrl,
    serviceKey,
  );
}

async function applyMigration(rows, supabaseUrl, serviceKey) {
  await upsert("code_batches", rows.batches, supabaseUrl, serviceKey);
  await upsert("access_codes", rows.codes, supabaseUrl, serviceKey);

  const testsWithoutResult = rows.tests.map((test) => ({
    ...test,
    result_id: null,
  }));
  await upsert("tests", testsWithoutResult, supabaseUrl, serviceKey);
  await upsert("results", rows.results, supabaseUrl, serviceKey);

  // The results table must exist before tests can point at it.
  await upsert("tests", rows.tests, supabaseUrl, serviceKey);
  await upsert("shares", rows.shares, supabaseUrl, serviceKey);
}

(async () => {
  const state = readState();
  const rows = buildMigrationRows(state);
  const legacySecret =
    String(process.env.LEGACY_LOOKUP_SECRET || "").trim() || state.secret;

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        statePath,
        batches: rows.batches.length,
        accessCodes: rows.codes.length,
        tests: rows.tests.length,
        results: rows.results.length,
        shares: rows.shares.length,
        legacySecretSource:
          process.env.LEGACY_LOOKUP_SECRET === undefined
            ? "state.secret"
            : "LEGACY_LOOKUP_SECRET",
      },
      null,
      2,
    ),
  );

  if (!legacySecret) throw new Error("LEGACY_LOOKUP_SECRET is empty.");
  if (!apply) {
    console.log("Dry run only. Re-run with --apply to write to Supabase.");
    return;
  }

  const supabaseUrl = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  await applyMigration(rows, supabaseUrl, serviceKey);
  console.log("Migration applied successfully.");
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

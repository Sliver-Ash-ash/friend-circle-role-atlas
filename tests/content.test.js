const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildResult,
  calculateDimensionScores,
  content,
  matchScore,
  validateContent,
} = require("../server.js");

test("题库包含 47 道题，九个维度覆盖充分，角色目标向量完整", () => {
  assert.doesNotThrow(() => validateContent(content));
  assert.equal(content.questions.length, 47);
  assert.equal(content.meta.questionCount, 47);
  assert.equal(content.dimensions.length, 9);
  assert.equal(content.roles.length, 12);
  assert.ok(content.specialRole);

  const questionIds = new Set();
  const counts = Object.fromEntries(
    content.dimensions.map((dimension) => [dimension.id, 0]),
  );

  for (const question of content.questions) {
    assert.equal(questionIds.has(question.id), false, "题目 ID 不应重复");
    assert.equal(typeof question.text, "string");
    assert.ok(question.text.length >= 12, "题目应提供具体生活情境");
    assert.equal(typeof question.reverse, "boolean");
    questionIds.add(question.id);
    counts[question.dimension] += 1;
  }

  for (const dimension of content.dimensions) {
    assert.ok(counts[dimension.id] >= 5);
  }
  assert.equal(counts.N, 7, "导航力应有额外题目提高人间 GPS 的区分度");

  const dimensionIds = content.dimensions.map((dimension) => dimension.id);
  for (const role of [...content.roles, content.specialRole]) {
    assert.deepEqual(
      Object.keys(role.target).sort(),
      [...dimensionIds].sort(),
      `${role.name} 的目标向量应覆盖所有维度`,
    );
    for (const dimensionId of dimensionIds) {
      const value = role.target[dimensionId];
      assert.ok(Number.isFinite(value));
      assert.ok(value >= 0 && value <= 100);
    }
  }
});

test("量表为五级，并且不向占位逻辑暴露已删除的反思内容", () => {
  assert.deepEqual(
    content.scale.map((item) => item.value),
    [1, 2, 3, 4, 5],
  );
  assert.equal("reflectionQuestions" in content, false);
  assert.equal(
    content.roles.some((role) => "blindSpot" in role),
    false,
  );
  assert.equal("blindSpot" in content.specialRole, false);
  for (const role of [...content.roles, content.specialRole]) {
    assert.ok(role.highlight.length >= role.theory.length);
    assert.equal("advice" in role, false);
    assert.ok(role.practice.scene.length >= 20);
    assert.ok(role.practice.action.length >= 20);
    assert.ok(role.practice.signal.length >= 20);
    assert.ok(role.bestPartner.length >= 35);
    assert.ok(role.mismatchPartner.length >= 35);
  }
  assert.equal(
    JSON.stringify(content).includes("先复述一句他的原话"),
    false,
    "已删除的建议句式不应重新进入内容数据",
  );
});

test("计分支持反向题，并将九个维度映射为 0 至 100 分", () => {
  const neutralAnswers = Object.fromEntries(
    content.questions.map((question) => [question.id, 3]),
  );
  const neutralScores = calculateDimensionScores(neutralAnswers);

  assert.deepEqual(Object.keys(neutralScores).sort(), [
    "A",
    "B",
    "E",
    "H",
    "M",
    "N",
    "O",
    "R",
    "X",
  ]);
  assert.ok(Object.values(neutralScores).every((score) => score === 50));

  const result = buildResult(neutralAnswers);
  assert.equal(result.isSpecial, true);
  assert.equal(result.role.id, "utility");
  assert.equal(result.role.name, "万金油替补");
});

test("人间 GPS 必须同时达到导航与组织智囊门槛", () => {
  const gps = content.roles.find((role) => role.id === "gps");
  assert.ok(gps);

  const fullyQualified = { ...gps.target };
  assert.equal(
    matchScore(fullyQualified, gps),
    100,
    "完全达到目标向量且通过门槛时应为 100 分",
  );

  const navigationBelowThreshold = {
    ...gps.target,
    N: 79,
    O: 100,
    A: 100,
  };
  const organizingBelowThreshold = {
    ...gps.target,
    N: 100,
    O: 60,
    A: 70,
  };

  assert.ok(
    matchScore(navigationBelowThreshold, gps) < 100,
    "导航力未达 80 时不应获得 GPS 满分匹配",
  );
  assert.ok(
    matchScore(organizingBelowThreshold, gps) < 100,
    "组织力与智囊力均值未达 70 时不应获得 GPS 满分匹配",
  );
});

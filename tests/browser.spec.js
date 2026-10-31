const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "test-results");
const EDGE_PATH = path.join(
  process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
  "Microsoft",
  "Edge",
  "Application",
  "msedge.exe",
);

let server;
let browser;
let temporaryDirectory;
let baseUrl;
let serverOutput = "";
let questionCount;

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
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
      // Keep waiting while the isolated test server boots.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`测试服务器启动失败：${serverOutput}`);
}

async function waitForQuestion(page, index) {
  const expectedText = `第 ${index} / ${questionCount} 题`;
  try {
    await page.waitForFunction(
      (expected) =>
        document.querySelector("#question-counter")?.textContent.trim() ===
        expected,
      expectedText,
      { timeout: 15_000 },
    );
  } catch (error) {
    const state = await page.evaluate(() => ({
      counter:
        document.querySelector("#question-counter")?.textContent.trim() || "",
      view: document.querySelector(".screen.is-active")?.id || "",
      dialog:
        [...document.querySelectorAll("dialog[open]")]
          .map((item) => item.textContent.trim())
          .filter(Boolean)
          .join(" | "),
      body: document.body.innerText.slice(0, 500),
    }));
    throw new Error(
      `等待题目失败：期望“${expectedText}”，页面状态 ${JSON.stringify(state)}`,
      { cause: error },
    );
  }
  await page.waitForSelector("#screen-quiz:not([hidden])");
}

async function selectedAnswer(page) {
  return Number(
    await page
      .locator('#answer-scale input[name="answer"]:checked')
      .getAttribute("value"),
  );
}

async function answerQuestion(page, value) {
  await page
    .locator(`#answer-scale .answer-option[data-value="${value}"]`)
    .click();
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector('#answer-scale input[name="answer"]:checked')
        ?.getAttribute("value") === String(expected),
    value,
  );
}

async function clickNext(page) {
  await page.locator("#next-button").click();
}

function readPngSize(buffer) {
  assert.equal(buffer.toString("ascii", 1, 4), "PNG");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function run() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const content = JSON.parse(
    await fs.readFile(path.join(ROOT, "data", "content.json"), "utf8"),
  );
  questionCount = content.questions.length;
  temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "friend-circle-browser-"),
  );
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      STATE_PATH: path.join(temporaryDirectory, "state.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  await waitForServer(baseUrl);

  browser = await chromium.launch({
    executablePath: EDGE_PATH,
    headless: true,
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  const failedResponses = [];
  page.on("pageerror", (error) => {
    throw error;
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });

  await page.waitForSelector("#screen-welcome:not([hidden])");
  assert.equal(await page.locator("#screen-unlock").count(), 0);
  assert.equal(
    (await page.locator("body").innerText()).includes("3 次测试机会"),
    false,
  );

  await page.locator("#start-test-button").click();
  await waitForQuestion(page, 1);

  for (let index = 0; index < questionCount; index += 1) {
    await waitForQuestion(page, index + 1);
    const value = (index % 5) + 1;
    await answerQuestion(page, value);

    if (index === 9) {
      await page.waitForFunction(
        () =>
          document.querySelector("#save-state")?.textContent.includes("进度已保存"),
      );
      await page.reload({ waitUntil: "networkidle" });
      await waitForQuestion(page, 10);
      assert.equal(await selectedAnswer(page), value);
      await clickNext(page);
      continue;
    }

    if (index === 14) {
      await page.locator("#previous-button").click();
      await waitForQuestion(page, 14);
      const previousValue = await selectedAnswer(page);
      const replacement = previousValue === 5 ? 4 : previousValue + 1;
      await answerQuestion(page, replacement);
      await clickNext(page);
      await waitForQuestion(page, 15);
      assert.equal(await selectedAnswer(page), value);
      await clickNext(page);
      await waitForQuestion(page, 16);
      continue;
    }

    if (index === 19) {
      await page.locator("#open-overview-button").click();
      await page.waitForSelector("#overview-dialog[open]");
      assert.equal(
        await page.locator(".question-map-button").count(),
        questionCount,
      );
      await page.locator(".question-map-button").nth(2).click();
      await waitForQuestion(page, 3);
      await page.locator("#open-overview-button").click();
      await page.locator(".question-map-button").nth(19).click();
      await waitForQuestion(page, 20);
      assert.equal(await selectedAnswer(page), value);
      await page.locator("#open-overview-button").click();
      await page.locator(".question-map-button").nth(20).click();
      await waitForQuestion(page, 21);
      continue;
    }

    await clickNext(page);
  }

  await page.waitForSelector("#screen-result:not([hidden])");
  const roleName = (await page.locator("#result-role-name").innerText()).trim();
  assert.ok(roleName.length > 0);
  assert.equal(await page.locator("#result-role-code").count(), 0);
  const resultText = await page.locator("#screen-result").innerText();
  assert.equal(resultText.includes("IQ-04"), false);
  assert.equal(resultText.includes("先复述一句他的原话"), false);
  assert.equal(
    await page.getByText("长图会按当前结果自动排版", { exact: true }).count(),
    0,
  );
  assert.equal(await page.locator("#radar-chart polygon").count(), 7);
  assert.equal(await page.locator("#radar-chart text").count(), 9);
  assert.equal(await page.locator("#dimension-bars .dimension-row").count(), 9);
  assert.equal(
    await page.locator("#result-friend-view").evaluate((node) => node.tagName),
    "P",
  );
  assert.equal(
    (await page.locator(".partner-panel-best h2").innerText()).trim(),
    "顺手搭档",
  );
  assert.equal(
    (await page.locator(".partner-panel-different h2").innerText()).trim(),
    "节奏不同但能互补",
  );
  assert.equal(
    (await page.locator(".electricity-section h2").innerText()).trim(),
    "群聊电量模式",
  );
  assert.ok(
    (await page.locator("#result-best-partner").innerText()).trim().length >= 20,
  );
  assert.ok(
    (await page.locator("#result-mismatch-partner").innerText()).trim()
      .length >= 20,
  );
  assert.ok(
    (await page.locator("#result-electricity-description").innerText()).trim()
      .length >= 20,
  );
  assert.ok(
    (await page.locator("#result-electricity-tip").innerText()).trim().length >=
      20,
  );
  assert.equal(await page.locator("#share-result-button").count(), 0);
  assert.equal(
    (await page.locator("#save-image-button").innerText()).trim(),
    "保存 / 转发结果长图",
  );
  assert.equal(
    (await page.locator("#share-test-button").innerText()).trim(),
    "邀请好友来测",
  );
  const shareActionOrder = await page.evaluate(() => ({
    button: document
      .querySelector("#share-test-button")
      .getBoundingClientRect().top,
    quota: document.querySelector(".share-quota").getBoundingClientRect().top,
  }));
  assert.ok(shareActionOrder.button < shareActionOrder.quota);

  await page.evaluate(() => {
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data) => {
        if (data.files?.length) {
          window.__testImageSharePayload = data;
        } else {
          window.__testInviteSharePayload = data;
        }
      },
    });
  });

  const order = await page.evaluate(() => ({
    title: document.querySelector(".result-hero").getBoundingClientRect().top,
    chart: document
      .querySelector(".result-chart-section")
      .getBoundingClientRect().top,
    description: document
      .querySelector(".result-description")
      .getBoundingClientRect().top,
  }));
  assert.ok(order.title < order.chart);
  assert.ok(order.chart < order.description);

  await page.screenshot({
    path: path.join(OUTPUT_DIR, "desktop-result.png"),
    fullPage: false,
  });

  await page.locator("#save-image-button").click();
  await page.waitForSelector("#image-dialog[open]", { timeout: 30_000 });
  assert.equal(
    (await page.locator("#share-quota-text").innerText()).trim(),
    "0 / 3",
  );
  assert.equal(await page.locator("#share-image-button").isVisible(), true);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, "desktop-image-dialog.png"),
    fullPage: false,
  });

  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.locator("#download-image-button").click();
  const download = await downloadPromise;
  const imagePath = path.join(OUTPUT_DIR, "friend-circle-result.png");
  await download.saveAs(imagePath);
  const png = await fs.readFile(imagePath);
  const pngSize = readPngSize(png);
  assert.equal(pngSize.width, 1440);
  assert.ok(
    pngSize.height > pngSize.width,
    `结果长图应明显长于宽，实际为 ${pngSize.width}x${pngSize.height}`,
  );
  assert.equal(
    (await page.locator("#share-quota-text").innerText()).trim(),
    "0 / 3",
  );

  await page.locator("#share-image-button").click();
  await page.waitForFunction(() => Boolean(window.__testImageSharePayload));
  const imageSharePayload = await page.evaluate(() => {
    const file = window.__testImageSharePayload.files?.[0];
    return {
      fileName: file?.name,
      fileType: file?.type,
      fileSize: file?.size,
      title: window.__testImageSharePayload.title,
    };
  });
  assert.match(imageSharePayload.fileName, /\.png$/);
  assert.equal(imageSharePayload.fileType, "image/png");
  assert.ok(imageSharePayload.fileSize > 0);
  assert.match(imageSharePayload.title, /朋友圈岗位图鉴/);
  assert.equal(
    (await page.locator("#share-quota-text").innerText()).trim(),
    "0 / 3",
  );
  await page.locator("#close-image-button").click();
  await page.waitForFunction(
    () => !document.querySelector("#image-dialog")?.open,
  );

  for (let count = 1; count <= 3; count += 1) {
    await page.evaluate(() => {
      window.__testInviteSharePayload = null;
    });
    await page.locator("#share-test-button").click();
    await page.waitForFunction(
      (expected) =>
        document.querySelector("#share-quota-text")?.textContent.trim() ===
        expected,
      `${count} / 3`,
    );
    await page.waitForFunction(() => Boolean(window.__testInviteSharePayload));
    const invitePayload = await page.evaluate(() => ({
      url: window.__testInviteSharePayload.url,
      text: window.__testInviteSharePayload.text,
    }));
    assert.equal(invitePayload.url, `${baseUrl}/`);
    assert.ok(invitePayload.text.length > 0);
  }
  assert.equal(
    (await page.locator("#share-quota-text").innerText()).trim(),
    "3 / 3",
  );
  assert.equal(await page.locator("#share-test-button").isDisabled(), true);
  assert.equal(
    (await page.locator("#share-test-button").innerText()).trim(),
    "邀请额度已用完",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  const mobileMetrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  assert.ok(
    mobileMetrics.scrollWidth <= mobileMetrics.viewportWidth + 1,
    `手机结果页出现横向溢出：${JSON.stringify(mobileMetrics)}`,
  );
  await page.screenshot({
    path: path.join(OUTPUT_DIR, "mobile-result.png"),
    fullPage: false,
  });

  await page.locator("#save-image-button").click();
  await page.waitForSelector("#image-dialog[open]", { timeout: 30_000 });
  assert.equal(
    (await page.locator("#share-quota-text").innerText()).trim(),
    "3 / 3",
  );
  assert.equal(await page.locator("#download-image-button").isVisible(), true);
  assert.equal(await page.locator("#share-image-button").isVisible(), true);
  const mobileDialogMetrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    dialogWidth: document
      .querySelector("#image-dialog")
      .getBoundingClientRect().width,
    actions: [...document.querySelectorAll(".image-dialog-actions .button")].map(
      (button) => {
        const rect = button.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      },
    ),
  }));
  assert.ok(
    mobileDialogMetrics.scrollWidth <= mobileDialogMetrics.viewportWidth + 1,
    `手机长图弹窗出现横向溢出：${JSON.stringify(mobileDialogMetrics)}`,
  );
  assert.ok(
    mobileDialogMetrics.dialogWidth <= mobileDialogMetrics.viewportWidth - 16,
  );
  assert.ok(
    mobileDialogMetrics.actions.every(
      (rect) =>
        rect.top >= 0 && rect.bottom <= mobileDialogMetrics.viewportHeight,
    ),
    `手机长图操作按钮未完整显示：${JSON.stringify(mobileDialogMetrics)}`,
  );
  await page.screenshot({
    path: path.join(OUTPUT_DIR, "mobile-image-dialog.png"),
    fullPage: false,
  });
  await page.locator("#close-image-button").click();
  await page.waitForFunction(
    () => !document.querySelector("#image-dialog")?.open,
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#retake-button").click();
  await page.waitForSelector("#message-dialog[open]");
  assert.equal(
    (await page.locator("#message-text").innerText()).includes(
      "好友共享链接",
    ),
    false,
  );
  await page
    .locator('#message-actions button[data-message-value="retake"]')
    .click();
  await waitForQuestion(page, 1);
  assert.equal(await page.locator("#screen-result").isVisible(), false);
  assert.deepEqual(failedResponses, []);

  await context.close();

  console.log(
    JSON.stringify(
      {
        roleName,
        pngSize,
        screenshots: OUTPUT_DIR,
      },
      null,
      2,
    ),
  );
}

async function cleanup() {
  if (browser) await browser.close().catch(() => {});
  if (server && !server.killed) {
    server.kill();
    await new Promise((resolve) => {
      server.once("exit", resolve);
      setTimeout(resolve, 2_000);
    });
  }
  if (temporaryDirectory) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(cleanup);

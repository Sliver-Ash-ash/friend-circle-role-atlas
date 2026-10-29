const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "test-results");
const ADMIN_PASSWORD = "ADMIN-BROWSER-TEST-2026";
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
let serverOutput = "";

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
  throw new Error(`管理端测试服务器启动失败：${serverOutput}`);
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
  const now = new Date().toISOString();
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      salt,
      passwordHash: await scrypt(ADMIN_PASSWORD, salt),
      tokenSecret: crypto.randomBytes(32).toString("hex"),
      createdAt: now,
      updatedAt: now,
    }),
    "utf8",
  );
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

async function run() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "friend-circle-admin-browser-"),
  );
  const adminConfigPath = path.join(temporaryDirectory, "admin.json");
  await createAdminConfig(adminConfigPath);

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.js"], {
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
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`${baseUrl}/admin`, { waitUntil: "networkidle" });
  await page.waitForSelector("#login-view:not([hidden])");
  assert.match(await page.title(), /卡密发货台/);

  await page.locator("#admin-password").fill(ADMIN_PASSWORD);
  await page.locator("#login-button").click();
  await page.waitForSelector("#dashboard-view:not([hidden])");
  assert.equal(await page.locator("#logout-button").isVisible(), true);
  assert.equal(await page.locator("#metric-total").innerText(), "3");

  await page.locator("#batch-label").fill("浏览器回归批次");
  await page.locator("#batch-count").fill("4");
  await page.locator("#test-url").fill("https://test.example.com/");
  await page.locator("#generate-button").click();
  await page.waitForSelector("#generation-result:not([hidden])", {
    timeout: 30_000,
  });
  assert.match(await page.locator("#result-title").innerText(), /4 个访问码/);
  assert.equal(await page.locator("#metric-total").innerText(), "7");

  const csvDownloadPromise = page.waitForEvent("download");
  await page.locator("#download-csv").click();
  const csvDownload = await csvDownloadPromise;
  const csvPath = path.join(OUTPUT_DIR, "admin-delivery.csv");
  await csvDownload.saveAs(csvPath);
  const csvRows = parseCsv((await fs.readFile(csvPath, "utf8")).replace(/^\uFEFF/, ""));
  assert.deepEqual(csvRows[0], [
    "access_code",
    "test_url",
    "max_tests",
    "batch_id",
    "batch_label",
    "product_name",
  ]);
  assert.equal(csvRows.length, 5);
  assert.equal(new Set(csvRows.slice(1).map((row) => row[0])).size, 4);
  for (const row of csvRows.slice(1)) {
    assert.match(row[0], /^FC-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(row[1], "https://test.example.com/");
    assert.equal(row[2], "3");
    assert.equal(row[4], "浏览器回归批次");
    assert.equal(row[5], "朋友圈岗位图鉴");
  }

  const txtDownloadPromise = page.waitForEvent("download");
  await page.locator("#download-txt").click();
  const txtDownload = await txtDownloadPromise;
  const txtPath = path.join(OUTPUT_DIR, "admin-delivery.txt");
  await txtDownload.saveAs(txtPath);
  const txtCodes = (await fs.readFile(txtPath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(txtCodes.length, 4);
  assert.deepEqual(
    txtCodes,
    csvRows.slice(1).map((row) => row[0]),
  );
  assert.match(
    await page.locator("#delivery-template").inputValue(),
    /\{\{access_code\}\}/,
  );

  await page.screenshot({
    path: path.join(OUTPUT_DIR, "admin-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const mobileMetrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    overflowing: [...document.querySelectorAll("body *")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          id: element.id,
          className:
            typeof element.className === "string" ? element.className : "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      })
      .filter(
        (item) =>
          item.right > window.innerWidth + 1 || item.left < -1 || item.width > window.innerWidth,
      )
      .slice(0, 20),
  }));
  await page.screenshot({
    path: path.join(OUTPUT_DIR, "admin-mobile.png"),
    fullPage: false,
  });
  assert.ok(
    mobileMetrics.scrollWidth <= mobileMetrics.viewportWidth + 1,
    `管理端手机页面出现横向溢出：${JSON.stringify(mobileMetrics)}`,
  );

  assert.deepEqual(pageErrors, []);
  await context.close();

  console.log(
    JSON.stringify(
      {
        csvRows: csvRows.length - 1,
        txtCodes: txtCodes.length,
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

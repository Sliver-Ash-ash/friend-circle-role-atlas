(() => {
  const STORAGE_KEY = "friend-circle-admin.session.v1";
  const CHUNK_SIZE = 100;
  const MAX_BATCH_SIZE = 2000;

  const app = {
    token: sessionStorage.getItem(STORAGE_KEY) || "",
    inventory: null,
    lastExport: null,
    generating: false,
  };

  const $ = (selector) => document.querySelector(selector);

  function refreshIcons() {
    if (window.lucide) window.lucide.createIcons();
  }

  function setFeedback(element, message, tone = "") {
    element.textContent = message;
    element.classList.toggle("is-error", tone === "error");
    element.classList.toggle("is-success", tone === "success");
  }

  function setBusy(button, busy, label) {
    button.disabled = busy;
    const textNode = [...button.childNodes].find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
    );
    if (textNode && label) {
      textNode.textContent = ` ${label}`;
    }
  }

  async function apiRequest(pathname, options = {}) {
    const response = await window.FriendCircleBackend.request(pathname, {
      ...options,
      token: options.token || (options.auth ? app.token : ""),
    });
    if (response.status === 401 && options.auth) {
      logout("登录已失效，请重新输入管理员密码。");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        response.payload?.error || "请求失败，请稍后重试。",
      );
    }
    return response.payload;
  }

  function showLogin(message = "") {
    $("#login-view").hidden = false;
    $("#dashboard-view").hidden = true;
    $("#logout-button").hidden = true;
    setFeedback($("#login-feedback"), message, message ? "error" : "");
    window.setTimeout(() => $("#admin-password").focus(), 0);
  }

  function showDashboard() {
    $("#login-view").hidden = true;
    $("#dashboard-view").hidden = false;
    $("#logout-button").hidden = false;
    setFeedback($("#login-feedback"), "");
    refreshIcons();
  }

  function resetSensitiveResult() {
    app.lastExport = null;
    $("#generation-result").hidden = true;
    $("#delivery-template").value = "";
  }

  function logout(message = "") {
    app.token = "";
    sessionStorage.removeItem(STORAGE_KEY);
    resetSensitiveResult();
    showLogin(message);
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function renderInventory(inventory) {
    app.inventory = inventory;
    $("#metric-total").textContent = String(inventory.totals.totalCodes);
    $("#metric-untouched").textContent = String(
      inventory.totals.untouchedCodes,
    );
    $("#metric-partial").textContent = String(
      inventory.totals.partiallyUsedCodes,
    );
    $("#metric-exhausted").textContent = String(
      inventory.totals.exhaustedCodes,
    );

    const body = $("#batch-table-body");
    body.replaceChildren();
    if (!inventory.batches.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.className = "empty-cell";
      cell.textContent = "暂无卡密批次";
      row.appendChild(cell);
      body.appendChild(row);
      return;
    }

    for (const batch of inventory.batches) {
      const row = document.createElement("tr");

      const nameCell = document.createElement("td");
      const name = document.createElement("span");
      name.className = "batch-name";
      name.textContent = batch.label;
      const id = document.createElement("span");
      id.className = "batch-id";
      id.textContent = batch.id;
      nameCell.append(name, id);

      const countCell = document.createElement("td");
      countCell.textContent = String(batch.count);

      const startsCell = document.createElement("td");
      startsCell.textContent = String(batch.testStarts);

      const remainingCell = document.createElement("td");
      remainingCell.textContent = String(batch.remainingTests);

      const dateCell = document.createElement("td");
      dateCell.textContent = formatDate(batch.createdAt);

      const actionCell = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button button-secondary table-action";
      button.dataset.exportBatch = batch.id;
      button.textContent = "重新导出";
      actionCell.appendChild(button);

      row.append(
        nameCell,
        countCell,
        startsCell,
        remainingCell,
        dateCell,
        actionCell,
      );
      body.appendChild(row);
    }
  }

  async function loadInventory() {
    const inventory = await apiRequest("/api/admin/inventory", {
      auth: true,
    });
    renderInventory(inventory);
  }

  async function activateSession() {
    if (!app.token) {
      await checkAdminStatus();
      showLogin();
      return;
    }
    try {
      await loadInventory();
      showDashboard();
    } catch (error) {
      if (app.token) {
        showLogin(error.message);
      }
    }
  }

  async function checkAdminStatus() {
    try {
      const status = await apiRequest("/api/admin/status");
      if (!status.configured) {
        setFeedback(
          $("#login-feedback"),
          "管理员密码尚未初始化，请先运行管理员密码设置脚本。",
          "error",
        );
      }
    } catch {
      setFeedback($("#login-feedback"), "无法连接网站服务。", "error");
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    const button = $("#login-button");
    const password = $("#admin-password").value;
    if (!password.trim()) {
      setFeedback($("#login-feedback"), "请输入管理员密码。", "error");
      return;
    }
    setBusy(button, true, "正在验证");
    setFeedback($("#login-feedback"), "");
    try {
      const result = await apiRequest("/api/admin/login", {
        method: "POST",
        body: { password },
      });
      app.token = result.adminToken;
      sessionStorage.setItem(STORAGE_KEY, app.token);
      $("#admin-password").value = "";
      await loadInventory();
      showDashboard();
    } catch (error) {
      setFeedback($("#login-feedback"), error.message, "error");
    } finally {
      setBusy(button, false, "进入发货台");
      refreshIcons();
    }
  }

  function validateGeneratorForm() {
    const count = Number($("#batch-count").value);
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > MAX_BATCH_SIZE
    ) {
      throw new Error(`生成数量需要在 1 到 ${MAX_BATCH_SIZE} 之间。`);
    }
    let url;
    try {
      url = new URL($("#test-url").value);
    } catch {
      throw new Error("请填写完整的测评网址。");
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("测评网址必须使用 http 或 https。");
    }
    return {
      count,
      url: url.toString(),
      label: $("#batch-label").value.trim() || "未命名批次",
    };
  }

  function deliveryTemplate(url) {
    return [
      "【朋友圈岗位图鉴】已开通",
      "",
      "测评地址：",
      url,
      "",
      "访问码：",
      "{{access_code}}",
      "",
      "每个访问码最多可完成 3 次测评，请勿公开转发。",
      "建议使用手机浏览器打开。",
    ].join("\n");
  }

  function showGenerationResult(exportData) {
    app.lastExport = exportData;
    $("#result-title").textContent = `已生成 ${exportData.codes.length} 个访问码`;
    $("#delivery-template").value = deliveryTemplate(exportData.url);
    $("#generation-result").hidden = false;
    refreshIcons();
    $("#generation-result").scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  async function handleGenerate(event) {
    event.preventDefault();
    if (app.generating) return;

    const button = $("#generate-button");
    const feedback = $("#generate-feedback");
    let options;
    try {
      options = validateGeneratorForm();
    } catch (error) {
      setFeedback(feedback, error.message, "error");
      return;
    }

    app.generating = true;
    resetSensitiveResult();
    setBusy(button, true, "正在生成");
    setFeedback(feedback, `准备生成 ${options.count} 个访问码。`);

    const codes = [];
    const batches = [];
    try {
      let offset = 0;
      let chunkIndex = 0;
      const chunkTotal = Math.ceil(options.count / CHUNK_SIZE);
      while (offset < options.count) {
        chunkIndex += 1;
        const count = Math.min(CHUNK_SIZE, options.count - offset);
        const chunkLabel =
          chunkTotal === 1
            ? options.label
            : `${options.label} ${String(chunkIndex).padStart(2, "0")}`;
        setFeedback(
          feedback,
          `正在生成第 ${chunkIndex} / ${chunkTotal} 批，共 ${offset} / ${options.count} 个。`,
        );
        const result = await apiRequest("/api/admin/codes/generate", {
          method: "POST",
          auth: true,
          body: { count, label: chunkLabel },
        });
        codes.push(...result.codes);
        batches.push(result.batch);
        offset += count;
      }

      showGenerationResult({
        codes,
        batches,
        label: options.label,
        url: options.url,
        maxTests: 3,
        createdAt: new Date().toISOString(),
      });
      setFeedback(feedback, `已生成 ${codes.length} 个访问码。`, "success");
      await loadInventory();
    } catch (error) {
      if (codes.length) {
        showGenerationResult({
          codes,
          batches,
          label: options.label,
          url: options.url,
          maxTests: 3,
          createdAt: new Date().toISOString(),
        });
        setFeedback(
          feedback,
          `${error.message} 已生成 ${codes.length} 个，可先下载并核对。`,
          "error",
        );
        await loadInventory().catch(() => {});
      } else {
        setFeedback(feedback, error.message, "error");
      }
    } finally {
      app.generating = false;
      setBusy(button, false, "生成并准备下载");
      refreshIcons();
    }
  }

  function safeFilePart(value) {
    return String(value || "batch")
      .replace(/[\\/:*?"<>|\s]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }

  function escapeCsv(value) {
    const text = String(value ?? "");
    return `"${text.replaceAll('"', '""')}"`;
  }

  function downloadBlob(content, mime, filename) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCsv() {
    if (!app.lastExport) return;
    const rows = [
      [
        "access_code",
        "test_url",
        "max_tests",
        "batch_id",
        "batch_label",
        "product_name",
      ],
      ...app.lastExport.codes.map((code, index) => {
        const batch =
          app.lastExport.batches[
            Math.min(
              Math.floor(index / CHUNK_SIZE),
              app.lastExport.batches.length - 1,
            )
          ];
        return [
          code,
          app.lastExport.url,
          app.lastExport.maxTests,
          batch?.id || "",
          batch?.label || app.lastExport.label,
          "朋友圈岗位图鉴",
        ];
      }),
    ];
    const csv = `\uFEFF${rows
      .map((row) => row.map(escapeCsv).join(","))
      .join("\r\n")}\r\n`;
    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(
      csv,
      "text/csv;charset=utf-8",
      `朋友圈岗位图鉴-自动发货-${date}-${safeFilePart(app.lastExport.label)}.csv`,
    );
  }

  function downloadTxt() {
    if (!app.lastExport) return;
    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(
      `${app.lastExport.codes.join("\r\n")}\r\n`,
      "text/plain;charset=utf-8",
      `朋友圈岗位图鉴-卡密-${date}-${safeFilePart(app.lastExport.label)}.txt`,
    );
  }

  async function copyTemplate() {
    const textarea = $("#delivery-template");
    if (!textarea.value) return;
    try {
      await navigator.clipboard.writeText(textarea.value);
    } catch {
      textarea.focus();
      textarea.select();
      document.execCommand("copy");
    }
    const feedback = $("#generate-feedback");
    setFeedback(feedback, "发货文案已复制。", "success");
  }

  async function handleBatchTableClick(event) {
    const button = event.target.closest("[data-export-batch]");
    if (!button) return;
    button.disabled = true;
    try {
      const result = await apiRequest(
        `/api/admin/batches/${encodeURIComponent(
          button.dataset.exportBatch,
        )}/export`,
        { auth: true },
      );
      let url = $("#test-url").value.trim();
      if (!url) url = window.location.origin;
      showGenerationResult({
        codes: result.codes,
        batches: [result.batch],
        label: result.batch.label,
        url,
        maxTests: result.maxTests,
        createdAt: result.batch.createdAt,
      });
      setFeedback(
        $("#generate-feedback"),
        `已重新导出批次 ${result.batch.label}。`,
        "success",
      );
    } catch (error) {
      setFeedback($("#generate-feedback"), error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  function bindEvents() {
    $("#login-form").addEventListener("submit", handleLogin);
    $("#generate-form").addEventListener("submit", handleGenerate);
    $("#logout-button").addEventListener("click", () => logout());
    $("#refresh-button").addEventListener("click", async () => {
      const button = $("#refresh-button");
      setBusy(button, true, "刷新中");
      try {
        await loadInventory();
      } catch (error) {
        setFeedback($("#generate-feedback"), error.message, "error");
      } finally {
        setBusy(button, false, "刷新");
        refreshIcons();
      }
    });
    $("#download-csv").addEventListener("click", downloadCsv);
    $("#download-txt").addEventListener("click", downloadTxt);
    $("#copy-template").addEventListener("click", copyTemplate);
    $("#batch-table-body").addEventListener("click", handleBatchTableClick);
  }

  function initialize() {
    bindEvents();
    $("#test-url").value = window.FriendCircleBackend.siteUrl;
    refreshIcons();
    activateSession();
  }

  initialize();
})();

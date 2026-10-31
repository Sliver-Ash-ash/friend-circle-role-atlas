(() => {
  "use strict";

  const STORAGE_KEYS = {
    session: "friend-circle-atlas.session.v1",
  };

  const app = {
    content: null,
    view: "welcome",
    shared: false,
    currentSession: null,
    activeResult: null,
    saveTimer: null,
    saveRevision: 0,
    progressRequests: new Set(),
    submitting: false,
    generatedImage: null,
    messageResolve: null,
    busy: false,
  };

  class ApiError extends Error {
    constructor(message, status, payload) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.payload = payload;
    }
  }

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindEvents();
    refreshIcons();
    showLoading("正在打开岗位图鉴");

    try {
      app.content = await apiRequest("/api/content");
      const sharedToken = getSharedToken();
      if (sharedToken) {
        await openSharedResult(sharedToken);
        return;
      }
      await restoreSession();
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : "暂时无法连接测评服务，请稍后刷新页面。";
      showWelcome(message);
    } finally {
      hideLoading();
    }
  }

  function bindEvents() {
    $("#start-test-button").addEventListener("click", startTest);
    $("#resume-test-button").addEventListener("click", showQuiz);
    $("#leave-quiz-button").addEventListener("click", showWelcome);
    $("#answer-scale").addEventListener("change", handleAnswerChange);
    $("#previous-button").addEventListener("click", goToPreviousQuestion);
    $("#next-button").addEventListener("click", goToNextQuestion);
    $("#open-overview-button").addEventListener("click", openQuestionOverview);
    $("#close-overview-button").addEventListener("click", closeOverview);
    $("#share-test-button").addEventListener("click", shareTestToFriend);
    $("#save-image-button").addEventListener("click", generateAndOpenImage);
    $("#retake-button").addEventListener("click", retakeTest);
    $("#close-image-button").addEventListener("click", closeImageDialog);
    $("#download-image-button").addEventListener("click", downloadGeneratedImage);
    $("#share-image-button").addEventListener("click", shareGeneratedImage);

    $("#message-actions").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-message-value]");
      if (!button) return;
      $("#message-dialog").close(button.dataset.messageValue);
    });
    $("#message-dialog").addEventListener("close", () => {
      const settle = app.messageResolve;
      app.messageResolve = null;
      if (settle) settle($("#message-dialog").returnValue || "dismiss");
    });

    $$(".sheet-dialog").forEach((dialog) => {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
    });

    window.addEventListener("unhandledrejection", (event) => {
      if (event.reason?.name === "AbortError") return;
      console.error(event.reason);
    });
  }

  async function apiRequest(path, options = {}) {
    let result;
    try {
      result = await window.FriendCircleBackend.request(path, options);
    } catch {
      throw new ApiError("网络连接中断，请检查网络后重试。", 0, null);
    }

    if (result.status < 200 || result.status >= 300) {
      throw new ApiError(
        result.payload?.error || `请求失败（${result.status}）`,
        result.status,
        result.payload,
      );
    }
    return result.payload;
  }

  function readStorage(storage, key, fallback = null) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeStorage(storage, key, value) {
    try {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function normalizeAnswers(input) {
    const answers = {};
    if (!input || typeof input !== "object") return answers;
    for (const [key, value] of Object.entries(input)) {
      const questionId = Number(key);
      const score = Number(value);
      if (
        Number.isInteger(questionId) &&
        Number.isInteger(score) &&
        score >= 1 &&
        score <= 5
      ) {
        answers[questionId] = score;
      }
    }
    return answers;
  }

  function persistSession() {
    if (!app.currentSession) {
      writeStorage(localStorage, STORAGE_KEYS.session, null);
      return;
    }
    const saved = writeStorage(
      localStorage,
      STORAGE_KEYS.session,
      app.currentSession,
    );
    if (!saved) showToast("浏览器无法保存本次进度，请勿关闭页面。", "error");
  }

  function clearSession() {
    app.currentSession = null;
    writeStorage(localStorage, STORAGE_KEYS.session, null);
  }

  async function restoreSession() {
    const stored = readStorage(localStorage, STORAGE_KEYS.session);
    if (!stored?.testId || !stored?.testToken) {
      showWelcome();
      return;
    }

    try {
      const test = await apiRequest(
        `/api/tests/${encodeURIComponent(stored.testId)}`,
        { token: stored.testToken },
      );
      app.currentSession = {
        ...stored,
        ...test,
        answers: normalizeAnswers(test.answers),
      };
      persistSession();

      if (test.status === "active") {
        showQuiz();
        return;
      }

      if (test.status === "completed" && test.resultId) {
        const result = await loadPrivateResult(test.resultId);
        showResult(result);
        return;
      }
      clearSession();
      showWelcome();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearSession();
        showWelcome();
        return;
      }
      throw error;
    }
  }

  function showWelcome(message = "") {
    const activeSession = app.currentSession?.status === "active";
    const startButton = $("#start-test-button");
    const resumeButton = $("#resume-test-button");

    startButton.hidden = activeSession;
    startButton.disabled = !app.content;
    resumeButton.hidden = !activeSession;

    activateScreen("screen-welcome", "welcome");
    document.title = "开始测试｜朋友圈岗位图鉴";
    if (message) showToast(message, "error");
  }

  async function startTest() {
    if (app.busy) return;
    if (app.currentSession?.status === "active") {
      showQuiz();
      return;
    }

    app.busy = true;
    showLoading("正在准备第 1 题");
    try {
      const test = await apiRequest("/api/tests/start", {
        method: "POST",
      });
      app.currentSession = {
        ...test,
        answers: normalizeAnswers(test.answers),
        status: "active",
        resultId: null,
      };
      persistSession();
      showQuiz();
    } catch (error) {
      await showMessage("暂时无法开始", error.message, {
        icon: "triangle-alert",
      });
    } finally {
      app.busy = false;
      hideLoading();
    }
  }

  function showQuiz() {
    if (!app.currentSession || app.currentSession.status !== "active") {
      showWelcome();
      return;
    }
    activateScreen("screen-quiz", "quiz");
    renderQuestion();
    document.title = "答题中｜朋友圈岗位图鉴";
  }

  function renderQuestion({ focus = false } = {}) {
    const session = app.currentSession;
    if (!session || !app.content) return;

    const total = app.content.questions.length;
    session.currentIndex = Math.max(
      0,
      Math.min(total - 1, Number(session.currentIndex) || 0),
    );
    const question = app.content.questions[session.currentIndex];
    const dimension = app.content.dimensions.find(
      (item) => item.id === question.dimension,
    );
    const selectedValue = Number(session.answers[question.id]);

    $("#question-counter").textContent =
      `第 ${session.currentIndex + 1} / ${total} 题`;
    $("#question-number-ghost").textContent = String(
      session.currentIndex + 1,
    ).padStart(2, "0");
    $("#question-dimension").textContent = dimension?.short || dimension?.name || "";
    $("#question-title").textContent = question.text;
    $("#question-topic").textContent =
      dimension?.name || "熟悉好友群的日常反应";

    const scale = $("#answer-scale");
    scale.replaceChildren();
    for (const option of app.content.scale) {
      const label = document.createElement("label");
      label.className = "answer-option";
      label.dataset.value = String(option.value);
      if (selectedValue === option.value) label.classList.add("is-selected");

      const input = document.createElement("input");
      input.type = "radio";
      input.name = "answer";
      input.value = String(option.value);
      input.checked = selectedValue === option.value;
      input.setAttribute(
        "aria-label",
        `${option.value} 分，${option.label}，${option.hint}`,
      );

      const number = document.createElement("span");
      number.className = "answer-number";
      number.textContent = String(option.value);

      const labelText = document.createElement("span");
      labelText.className = "answer-label";
      labelText.textContent = option.label;

      const hint = document.createElement("span");
      hint.className = "answer-hint";
      hint.textContent = option.hint;

      label.append(input, number, labelText, hint);
      scale.append(label);
    }

    updateQuestionProgress();
    updateNavigation();
    setSaveState("saved");
    scheduleProgressSave();
    refreshIcons();

    if (focus) {
      $("#question-title").setAttribute("tabindex", "-1");
      $("#question-title").focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function handleAnswerChange(event) {
    const input = event.target.closest('input[name="answer"]');
    const session = app.currentSession;
    if (!input || !session) return;

    const question = app.content.questions[session.currentIndex];
    session.answers[question.id] = Number(input.value);
    $$(".answer-option", $("#answer-scale")).forEach((option) => {
      option.classList.toggle(
        "is-selected",
        Number(option.dataset.value) === Number(input.value),
      );
    });
    updateQuestionProgress();
    updateNavigation();
    scheduleProgressSave();
  }

  function updateQuestionProgress() {
    const session = app.currentSession;
    const total = app.content.questions.length;
    const answered = app.content.questions.reduce(
      (count, question) =>
        session.answers[question.id] >= 1 &&
        session.answers[question.id] <= 5
          ? count + 1
          : count,
      0,
    );
    $("#answered-counter").textContent = `已答 ${answered} 题`;
    $("#progress-fill").style.width = `${(answered / total) * 100}%`;
    $("#progress-track").setAttribute("aria-valuenow", String(answered));
  }

  function updateNavigation() {
    const session = app.currentSession;
    const total = app.content.questions.length;
    const question = app.content.questions[session.currentIndex];
    const isAnswered = Boolean(session.answers[question.id]);
    const isLast = session.currentIndex === total - 1;

    $("#previous-button").disabled = session.currentIndex === 0;
    $("#next-button").disabled = !isAnswered;
    setButtonContent(
      $("#next-button"),
      isLast ? "查看结果" : "下一题",
      isLast ? "circle-check-big" : "arrow-right",
    );
  }

  function goToPreviousQuestion() {
    const session = app.currentSession;
    if (!session || session.currentIndex <= 0) return;
    session.currentIndex -= 1;
    renderQuestion({ focus: true });
  }

  async function goToNextQuestion() {
    const session = app.currentSession;
    const total = app.content.questions.length;
    const question = app.content.questions[session.currentIndex];
    if (!session.answers[question.id]) {
      showToast("先选一个最接近你的答案。");
      return;
    }

    if (session.currentIndex < total - 1) {
      session.currentIndex += 1;
      renderQuestion({ focus: true });
      return;
    }
    await submitTest();
  }

  function openQuestionOverview() {
    const session = app.currentSession;
    if (!session) return;
    const map = $("#question-map");
    map.replaceChildren();
    app.content.questions.forEach((question, index) => {
      const button = document.createElement("button");
      button.className = "question-map-button";
      button.type = "button";
      button.textContent = String(index + 1).padStart(2, "0");
      button.setAttribute("aria-label", `前往第 ${index + 1} 题`);
      if (session.answers[question.id]) button.classList.add("is-answered");
      if (index === session.currentIndex) {
        button.classList.add("is-current");
        button.setAttribute("aria-current", "step");
      }
      button.addEventListener("click", () => {
        session.currentIndex = index;
        closeOverview();
        renderQuestion({ focus: true });
      });
      map.append(button);
    });
    $("#overview-dialog").showModal();
  }

  function closeOverview() {
    const dialog = $("#overview-dialog");
    if (dialog.open) dialog.close();
  }

  function scheduleProgressSave() {
    if (app.submitting) return;
    clearTimeout(app.saveTimer);
    app.saveTimer = null;
    setSaveState("saving");
    app.saveTimer = setTimeout(() => {
      app.saveTimer = null;
      persistProgress().catch(() => {});
    }, 240);
  }

  async function persistProgress() {
    const session = app.currentSession;
    if (
      !session ||
      session.status !== "active" ||
      app.shared ||
      app.submitting
    ) {
      return;
    }
    const revision = ++app.saveRevision;
    const request = apiRequest(
      `/api/tests/${encodeURIComponent(session.testId)}/progress`,
      {
        method: "PUT",
        token: session.testToken,
        body: {
          answers: session.answers,
          currentIndex: session.currentIndex,
        },
        keepalive: true,
      },
    );
    app.progressRequests.add(request);
    try {
      await request;
      if (revision === app.saveRevision) setSaveState("saved");
      persistSession();
    } catch (error) {
      if (revision === app.saveRevision) setSaveState("error");
      if (error instanceof ApiError && error.status === 401) {
        showToast("答题会话已失效，请返回首页重新开始。", "error");
      }
      throw error;
    } finally {
      app.progressRequests.delete(request);
    }
  }

  function clearScheduledProgress() {
    clearTimeout(app.saveTimer);
    app.saveTimer = null;
  }

  async function waitForProgressRequests() {
    if (app.progressRequests.size === 0) return;
    await Promise.allSettled([...app.progressRequests]);
  }

  function setSaveState(state) {
    const element = $("#save-state");
    const text = $("span", element);
    element.classList.toggle("is-saving", state === "saving");
    element.classList.toggle("has-error", state === "error");
    if (state === "saving") text.textContent = "正在保存";
    else if (state === "error") text.textContent = "保存失败，将自动重试";
    else text.textContent = "进度已保存";
    const icon = $("svg", element);
    if (icon) {
      icon.outerHTML = createIconElement(
        state === "saving"
          ? "loader-circle"
          : state === "error"
            ? "cloud-off"
            : "cloud-check",
      ).outerHTML;
      refreshIcons();
    }
  }

  async function submitTest() {
    const session = app.currentSession;
    if (!session || app.busy) return;

    const unanswered = app.content.questions.filter(
      (question) => !session.answers[question.id],
    );
    if (unanswered.length > 0) {
      const shouldGo = await showMessage(
        "还有题目没有作答",
        `目前还有 ${unanswered.length} 道题未完成。回到第一道未答题，选完后再查看结果。`,
        {
          icon: "list-checks",
          actions: [
            { label: "稍后继续", value: "cancel", style: "secondary" },
            { label: "去补答", value: "go", style: "primary" },
          ],
        },
      );
      if (shouldGo === "go") {
        session.currentIndex = app.content.questions.findIndex(
          (question) => !session.answers[question.id],
        );
        renderQuestion({ focus: true });
      }
      return;
    }

    app.busy = true;
    app.submitting = true;
    app.saveRevision += 1;
    clearScheduledProgress();
    await waitForProgressRequests();
    showLoading("正在整理你的岗位画像");
    try {
      const result = await apiRequest(
        `/api/tests/${encodeURIComponent(session.testId)}/submit`,
        {
          method: "POST",
          token: session.testToken,
          body: { answers: session.answers },
        },
      );
      session.status = "completed";
      session.resultId = result.id;
      persistSession();
      showResult(result);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearSession();
        await showMessage(
          "答题会话已失效",
          "当前答题进度已无法继续使用，请重新开始一次测试。",
          { icon: "refresh-cw" },
        );
        showWelcome();
      } else {
        await showMessage("提交失败", error.message, {
          icon: "triangle-alert",
        });
      }
    } finally {
      app.submitting = false;
      app.busy = false;
      hideLoading();
    }
  }

  async function loadPrivateResult(resultId) {
    if (!app.currentSession?.testToken) {
      throw new ApiError("无法读取本次结果。", 401, null);
    }
    const result = await apiRequest(
      `/api/results/${encodeURIComponent(resultId)}`,
      { token: app.currentSession.testToken },
    );
    return result;
  }

  function showResult(result) {
    app.shared = false;
    app.activeResult = result;
    renderResult(result);
    $("#shared-banner").hidden = true;
    activateScreen("screen-result", "result");
    document.title = `我的岗位是「${result.role.name}」｜朋友圈岗位图鉴`;
  }

  async function openSharedResult(token) {
    try {
      const result = await apiRequest(
        `/api/shared/${encodeURIComponent(token)}`,
      );
      app.shared = true;
      app.activeResult = result;
      renderResult(result);
      $("#shared-banner").hidden = false;
      activateScreen("screen-result", "shared");
      document.title = `好友的岗位是「${result.role.name}」｜朋友圈岗位图鉴`;
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 404
          ? "这个分享链接无效或已失效。"
          : "暂时无法打开分享结果，请稍后再试。";
      showWelcome();
      await showMessage("无法打开分享结果", message, {
        icon: "link-2-off",
      });
    }
  }

  function renderResult(result) {
    const role = result.role;
    const dimensions = result.dimensionMeta || app.content.dimensions;
    const target = role.target || result.target;
    const score = Number(result.fitScore) || 0;

    $("#result-role-name").textContent = role.name;
    $("#result-role-keywords").textContent = (role.keywords || []).join(" · ");
    $("#result-fit-score").textContent = String(score);
    $("#result-one-sentence").textContent = role.oneSentence;
    $("#result-highlight").textContent = role.highlight;
    $("#result-theory").textContent = role.theory;
    $("#result-friend-view").textContent = role.friendView;
    renderPractice(role);
    renderPartner("best", role.bestPartner);
    renderPartner("mismatch", role.mismatchPartner);
    $("#result-electricity-name").textContent = result.electricity.name;
    $("#result-electricity-description").textContent =
      result.electricity.description;
    $("#result-electricity-tip").textContent =
      result.electricity.tip || "先观察自己在不同群里的电量变化，再约定适合双方的回复节奏。";
    $("#result-date").textContent = formatDate(result.createdAt);

    const facts = $("#result-facts");
    facts.replaceChildren();
    addFact(`行为画像匹配 ${score} 分`);
    if (result.isSpecial) {
      addFact("九维分布较为均衡");
      addFact("触发隐藏岗位");
    } else {
      if (result.relationType) addFact(result.relationType);
      if (result.secondaryRole) addFact(`副岗位：${result.secondaryRole.name}`);
    }
    addFact(`群聊电量：${result.electricity.name}`);

    renderRadarChart(result.scores, target, dimensions);
    renderDimensionBars(result.scores, target, dimensions);
    updateShareState(result);

    if (app.shared) {
      $("#result-toolbar .section-index").textContent = "SHARED / RESULT";
    } else {
      $("#result-toolbar .section-index").textContent = "03 / RESULT";
    }
    refreshIcons();
  }

  function renderPractice(role) {
    const practice = role.practice || {
      scene: "适合放在你最自然地承担这项关系功能的场景里。",
      action: "先选一个具体的小动作，不急着一次改变所有相处方式。",
      signal: "做完后观察对方是否更容易接话、行动或表达真实需求。",
    };
    $("#result-practice-scene").textContent = practice.scene;
    $("#result-practice-action").textContent = practice.action;
    $("#result-practice-signal").textContent = practice.signal;
  }

  function renderPartner(kind, value = "") {
    const separatorIndex = value.indexOf("。");
    const name =
      separatorIndex > 0 ? value.slice(0, separatorIndex) : "互补搭档";
    const description =
      separatorIndex > 0
        ? value.slice(separatorIndex + 1).trim()
        : value || "换一种相处节奏，也能补上彼此没有覆盖的部分。";
    $(`#result-${kind}-partner-name`).textContent = name;
    $(`#result-${kind}-partner`).textContent = description;
  }

  function addFact(text) {
    const span = document.createElement("span");
    span.textContent = text;
    $("#result-facts").append(span);
  }

  function formatDate(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "Asia/Shanghai",
    }).format(date);
  }

  function renderRadarChart(scores, target, dimensions) {
    const svg = $("#radar-chart");
    const SVG_NS = "http://www.w3.org/2000/svg";
    const cx = 310;
    const cy = 210;
    const radius = 147;
    const count = dimensions.length;
    const angleFor = (index) => -Math.PI / 2 + (Math.PI * 2 * index) / count;
    const pointAt = (index, value) => {
      const angle = angleFor(index);
      const scaled = (Math.max(0, Math.min(100, value)) / 100) * radius;
      return [cx + Math.cos(angle) * scaled, cy + Math.sin(angle) * scaled];
    };

    const create = (name, attributes = {}) => {
      const node = document.createElementNS(SVG_NS, name);
      for (const [key, value] of Object.entries(attributes)) {
        node.setAttribute(key, String(value));
      }
      return node;
    };

    svg.replaceChildren();
    const title = create("title");
    title.textContent = "你的九维行为分数与岗位目标画像对比";
    svg.append(title);

    for (const level of [20, 40, 60, 80, 100]) {
      const points = dimensions
        .map((_, index) => pointAt(index, level).join(","))
        .join(" ");
      svg.append(
        create("polygon", {
          points,
          fill: level % 40 === 0 ? "rgba(51,45,104,0.018)" : "none",
          stroke: "#e9e6f2",
          "stroke-width": 1,
        }),
      );
    }

    for (let index = 0; index < count; index += 1) {
      const [x, y] = pointAt(index, 100);
      svg.append(
        create("line", {
          x1: cx,
          y1: cy,
          x2: x,
          y2: y,
          stroke: "#e9e6f2",
          "stroke-width": 1,
        }),
      );
    }

    const targetPoints = dimensions
      .map((dimension, index) => pointAt(index, target[dimension.id]).join(","))
      .join(" ");
    const userPoints = dimensions
      .map((dimension, index) => pointAt(index, scores[dimension.id]).join(","))
      .join(" ");

    svg.append(
      create("polygon", {
        points: targetPoints,
        fill: "rgba(140,119,232,0.08)",
        stroke: "#8c77e8",
        "stroke-width": 2,
        "stroke-dasharray": "7 5",
        "stroke-linejoin": "round",
      }),
    );
    svg.append(
      create("polygon", {
        points: userPoints,
        fill: "rgba(91,102,217,0.15)",
        stroke: "#5b66d9",
        "stroke-width": 2.5,
        "stroke-linejoin": "round",
      }),
    );

    dimensions.forEach((dimension, index) => {
      const [userX, userY] = pointAt(index, scores[dimension.id]);
      svg.append(
        create("circle", {
          cx: userX,
          cy: userY,
          r: 4,
          fill: "#5b66d9",
          stroke: "#ffffff",
          "stroke-width": 2,
        }),
      );

      const angle = angleFor(index);
      const labelRadius = radius + 34;
      const x = cx + Math.cos(angle) * labelRadius;
      const y = cy + Math.sin(angle) * labelRadius;
      const anchor =
        Math.cos(angle) > 0.25
          ? "start"
          : Math.cos(angle) < -0.25
            ? "end"
            : "middle";
      const label = create("text", {
        x,
        y: y + (Math.sin(angle) > 0.82 ? 3 : 4),
        "text-anchor": anchor,
        fill: "#515066",
        "font-size": 12,
        "font-weight": 650,
        "font-family":
          '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
      });
      label.textContent = dimension.short || dimension.name;
      svg.append(label);
    });

    svg.setAttribute(
      "aria-label",
      `你的九维行为分数与岗位目标画像对比，匹配分 ${app.activeResult?.fitScore || 0}`,
    );
  }

  function renderDimensionBars(scores, target, dimensions) {
    const container = $("#dimension-bars");
    container.replaceChildren();
    dimensions.forEach((dimension) => {
      const score = Number(scores[dimension.id]) || 0;
      const targetScore = Number(target[dimension.id]) || 0;
      const row = document.createElement("div");
      row.className = "dimension-row";
      row.setAttribute(
        "aria-label",
        `${dimension.name}：你的分数 ${score}，岗位目标 ${targetScore}`,
      );

      const name = document.createElement("span");
      name.className = "dimension-name";
      name.textContent = dimension.name;

      const track = document.createElement("div");
      track.className = "dimension-track";
      const fill = document.createElement("span");
      fill.className = "dimension-user-fill";
      fill.style.width = `${Math.max(0, Math.min(100, score))}%`;
      const targetLine = document.createElement("i");
      targetLine.className = "dimension-target-line";
      targetLine.style.left = `${Math.max(0, Math.min(100, targetScore))}%`;
      targetLine.title = `岗位目标 ${targetScore}`;
      track.append(fill, targetLine);

      const value = document.createElement("span");
      value.className = "dimension-value";
      value.textContent = `${score} / ${targetScore}`;

      row.append(name, track, value);
      container.append(row);
    });
  }

  function updateShareState(result) {
    if (app.shared) return;
    const count = Number(result.shareCount) || 0;
    const max = Number(result.maxShares) || 3;
    $("#share-quota-text").textContent = `${count} / ${max}`;
    const exhausted = count >= max;
    const inviteButton = $("#share-test-button");
    inviteButton.disabled = exhausted;
    setButtonContent(
      inviteButton,
      exhausted ? "邀请额度已用完" : "邀请好友来测",
      "user-plus",
    );
  }

  async function shareTestToFriend() {
    if (app.shared || app.busy) return;
    const session = app.currentSession;
    const result = app.activeResult;
    if (!session || !result) return;

    app.busy = true;
    const button = $("#share-test-button");
    button.disabled = true;
    setButtonContent(button, "正在准备邀请", "loader-circle");
    try {
      const share = await apiRequest(
        `/api/results/${encodeURIComponent(result.id)}/invite`,
        { method: "POST", token: session.testToken },
      );
      result.shareCount = share.shareCount;
      result.maxShares = share.maxShares;
      updateShareState(result);

      const shareData = {
        title: "朋友圈岗位图鉴",
        text: "来测测你在好友群里是什么角色。",
        url: share.shareUrl,
      };
      if (navigator.share) {
        try {
          await navigator.share(shareData);
          return;
        } catch (error) {
          if (error.name === "AbortError") return;
        }
      }

      await copyInviteLink(share.shareUrl);
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        result.shareCount = error.payload?.shareCount ?? 3;
        updateShareState(result);
        await showMessage("邀请好友额度已用完", error.message, { icon: "send" });
      } else {
        await showMessage("暂时无法邀请好友", error.message, {
          icon: "triangle-alert",
        });
      }
    } finally {
      app.busy = false;
      if (!app.shared) updateShareState(result);
    }
  }

  async function copyInviteLink(shareUrl) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        const input = document.createElement("textarea");
        input.value = shareUrl;
        input.setAttribute("readonly", "");
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.append(input);
        input.select();
        const copied = document.execCommand("copy");
        input.remove();
        if (!copied) throw new Error("copy failed");
      }
      showToast("测试链接已复制，可以发给好友了");
    } catch {
      await showMessage("复制测试链接", shareUrl, { icon: "link" });
    }
  }

  async function retakeTest() {
    if (app.busy || app.shared) return;
    const session = app.currentSession;
    if (!session?.resultId) return;

    const choice = await showMessage(
      "再测一次",
      "将开始一轮全新的答题，当前结果页会切换为新的测试进度。",
      {
        icon: "rotate-ccw",
        actions: [
          { label: "暂不再测", value: "cancel", style: "secondary" },
          { label: "开始新测试", value: "retake", style: "primary" },
        ],
      },
    );
    if (choice !== "retake") return;

    app.busy = true;
    showLoading("正在准备新一轮测试");
    try {
      const test = await apiRequest(
        `/api/tests/${encodeURIComponent(session.testId)}/retake`,
        { method: "POST", token: session.testToken },
      );
      app.currentSession = {
        ...test,
        answers: normalizeAnswers(test.answers),
        status: "active",
        resultId: null,
      };
      app.activeResult = null;
      persistSession();
      showQuiz();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearSession();
        app.activeResult = null;
        showWelcome("上次测试会话已失效，请重新开始。");
      } else {
        await showMessage("暂时无法再测", error.message, {
          icon: "triangle-alert",
        });
      }
    } finally {
      app.busy = false;
      hideLoading();
    }
  }

  async function generateAndOpenImage() {
    if (app.busy) return;
    if (typeof window.html2canvas !== "function") {
      await showMessage("图片组件未加载", "请刷新页面后重新生成长图。", {
        icon: "image-off",
      });
      return;
    }

    app.busy = true;
    const saveButton = $("#save-image-button");
    saveButton.disabled = true;
    setButtonContent(saveButton, "正在生成", "loader-circle");
    showLoading("正在生成长图，请稍候");
    let exportRoot = null;
    try {
      if (document.fonts?.ready) await document.fonts.ready;
      const source = $("#result-capture");
      exportRoot = document.createElement("div");
      exportRoot.className = "capture-export";
      const clone = source.cloneNode(true);
      clone.removeAttribute("id");
      exportRoot.append(clone);
      document.body.append(exportRoot);
      await nextFrame();
      await nextFrame();

      const canvas = await window.html2canvas(clone, {
        backgroundColor: "#f7f4ec",
        scale: 2,
        useCORS: true,
        logging: false,
        width: 720,
        height: clone.scrollHeight,
        windowWidth: 720,
        windowHeight: Math.max(900, clone.scrollHeight),
        scrollX: 0,
        scrollY: 0,
      });
      const blob = await canvasToBlob(canvas);
      const filename = `朋友圈岗位图鉴_${app.activeResult.role.name}.png`;
      setGeneratedImage(blob, filename);
      openImageDialog(blob, filename);
    } catch (error) {
      console.error(error);
      await showMessage(
        "长图生成失败",
        "可以尝试刷新页面后重试；如果仍无法保存，请确认浏览器允许下载文件。",
        { icon: "image-off" },
      );
    } finally {
      exportRoot?.remove();
      saveButton.disabled = false;
      setButtonContent(saveButton, "保存 / 转发结果长图", "images");
      app.busy = false;
      hideLoading();
    }
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas export failed"));
      }, "image/png");
    });
  }

  function setGeneratedImage(blob, filename) {
    if (app.generatedImage?.url) URL.revokeObjectURL(app.generatedImage.url);
    app.generatedImage = {
      blob,
      filename,
      url: URL.createObjectURL(blob),
    };
  }

  function openImageDialog(blob, filename) {
    const image = $("#generated-image");
    image.src = app.generatedImage.url;
    image.alt = `${app.activeResult.role.name}结果长图`;
    const canShareFile =
      typeof navigator.canShare === "function" &&
      navigator.canShare({
        files: [new File([blob], filename, { type: "image/png" })],
      });
    $("#share-image-button").hidden = !canShareFile;
    $("#image-dialog-note").textContent = canShareFile
      ? "长图已生成。可保存到本机，或直接转发给好友；两种操作均不占用邀请好友额度。"
      : "长图已生成。可保存到本机后发送给好友；保存和转发长图均不占用邀请好友额度。";
    $("#image-dialog").showModal();
  }

  function closeImageDialog() {
    const dialog = $("#image-dialog");
    if (dialog.open) dialog.close();
  }

  function downloadGeneratedImage() {
    if (!app.generatedImage) return;
    downloadBlob(app.generatedImage);
    showToast("图片已开始下载");
  }

  function downloadBlob(image) {
    const anchor = document.createElement("a");
    anchor.href = image.url;
    anchor.download = image.filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  async function shareGeneratedImage() {
    if (!app.generatedImage || !navigator.share) return;
    const file = new File(
      [app.generatedImage.blob],
      app.generatedImage.filename,
      { type: "image/png" },
    );
    if (
      typeof navigator.canShare === "function" &&
      !navigator.canShare({ files: [file] })
    ) {
      showToast("当前浏览器不能通过系统面板保存图片，请使用下载按钮。");
      return;
    }
    try {
      await navigator.share({
        title: `朋友圈岗位图鉴 · ${app.activeResult.role.name}`,
        text: "看看你在好友群里通常承担什么岗位。",
        files: [file],
      });
    } catch (error) {
      if (error.name !== "AbortError") {
        showToast("系统保存面板未能打开，请使用下载按钮。", "error");
      }
    }
  }

  function activateScreen(id, mode) {
    $$(".screen").forEach((screen) => {
      const isActive = screen.id === id;
      screen.hidden = !isActive;
      screen.classList.toggle("is-active", isActive);
    });
    app.view = id.replace("screen-", "");
    document.body.dataset.mode = mode;
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function showLoading(text) {
    $("#loading-text").textContent = text;
    $("#loading-overlay").hidden = false;
    document.body.classList.add("is-locked");
  }

  function hideLoading() {
    $("#loading-overlay").hidden = true;
    document.body.classList.remove("is-locked");
  }

  function showToast(message, type = "default") {
    const toast = document.createElement("div");
    toast.className = "toast";
    if (type === "error") toast.classList.add("is-error");
    toast.textContent = message;
    $("#toast-region").append(toast);
    setTimeout(() => {
      toast.remove();
    }, 3600);
  }

  function showMessage(title, text, options = {}) {
    const dialog = $("#message-dialog");
    if (dialog.open) dialog.close();
    $("#message-title").textContent = title;
    $("#message-text").textContent = text;
    const icon = $("#message-icon");
    icon.replaceChildren(createIconElement(options.icon || "info"));
    const actionsRoot = $("#message-actions");
    actionsRoot.replaceChildren();
    const actions = options.actions || [
      { label: "知道了", value: "dismiss", style: "primary" },
    ];
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        action.style === "secondary"
          ? "button button-secondary"
          : "button button-primary";
      button.dataset.messageValue = action.value;
      button.textContent = action.label;
      actionsRoot.append(button);
    }
    refreshIcons();
    dialog.returnValue = "";
    return new Promise((resolve) => {
      app.messageResolve = resolve;
      dialog.showModal();
    });
  }

  function setButtonContent(button, label, icon) {
    const text = document.createElement("span");
    text.textContent = label;
    button.replaceChildren(text);
    if (icon) button.prepend(createIconElement(icon));
    refreshIcons();
  }

  function createIconElement(name) {
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", name);
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }

  function refreshIcons() {
    if (window.lucide?.createIcons) {
      window.lucide.createIcons({
        attrs: {
          "aria-hidden": "true",
          "stroke-width": 2,
        },
      });
    }
  }

  function getSharedToken() {
    const queryToken = new URLSearchParams(window.location.search).get("share");
    if (queryToken) return queryToken.trim();
    const match = window.location.pathname.match(/^\/s\/([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]) : "";
  }
})();

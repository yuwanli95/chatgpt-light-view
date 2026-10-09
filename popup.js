(() => {
  const defaults = { enabled: true, turns: 5, cards: 5, cardSelectors: [] };
  const get = (id) => document.getElementById(id);
  let tabId;

  // 显示实际加载的扩展版本，便于确认浏览器已经使用修复后的文件。
  get("version").textContent = `版本 ${chrome.runtime.getManifest().version}`;

  /** 限制浏览器操作等待时间；入参为异步结果和超时提示，返回操作结果，避免弹窗永久停留在读取状态。 */
  async function withTimeout(operation, message) {
    let timer;
    try {
      return await Promise.race([operation, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }

  /** 将配置或操作发给当前聊天；入参为消息，返回页面响应，用于即时更新显示。 */
  async function send(message) {
    if (!tabId) throw new Error("请先打开 ChatGPT 聊天页面。");
    const response = await withTimeout(chrome.tabs.sendMessage(tabId, message).catch(() => {
      throw new Error("请刷新 ChatGPT 页面后再试，扩展需要在刷新时加载。");
    }), "聊天页面超过 5 秒未响应，暂时无法读取轮次或卡片数量。请等待页面恢复，或刷新后重试。");
    if (!response) throw new Error("页面未返回扩展状态，请刷新 ChatGPT 页面后重试。");
    return response;
  }

  /** 根据页面统计更新提示；入参为轮次与卡片计数，无返回值，帮助确认隐藏是否生效。 */
  function showStatus(stats) {
    if (stats.pending) {
      get("status").textContent = "页面脚本尚未完成初始化，请稍后重新打开弹窗。";
      return;
    }
    if (!stats.totalTurns) {
      get("status").textContent = "未识别到会话轮次。请打开聊天；页面结构变化时可能需要适配。";
      return;
    }
    get("status").textContent = `会话 ${stats.shownTurns}/${stats.totalTurns} 轮；工具卡片 ${stats.shownCards}/${stats.totalCards} 张。${stats.all ? "当前显示全部。" : ""}`;
    get("all").textContent = stats.all ? "恢复精简显示" : "临时显示全部";
  }

  /** 统一显示操作结果；入参为异步动作，无返回值，避免连接失败被用户误认为已应用。 */
  async function perform(action) {
    try { await action(); }
    catch (error) { get("status").textContent = error.message; }
  }

  get("save").addEventListener("click", () => perform(async () => {
    if (!get("turns").reportValidity() || !get("cards").reportValidity()) return;
    // 先确认当前页面能够响应，再保存全局偏好，避免操作失败却提示成功。
    await send({ type: "status" });
    const settings = { enabled: get("enabled").checked, turns: Number(get("turns").value), cards: Number(get("cards").value) };
    await withTimeout(chrome.storage.local.set(settings), "保存设置超时，请重新打开扩展后重试。");
    showStatus(await send({ type: "apply", settings }));
  }));
  get("all").addEventListener("click", () => perform(async () => showStatus(await send({ type: "toggleAll" }))));
  get("pick").addEventListener("click", () => perform(async () => {
    await send({ type: "pick" });
    window.close();
  }));
  get("reset").addEventListener("click", () => perform(async () => {
    await withTimeout(chrome.storage.local.set({ cardSelectors: [] }), "保存设置超时，请重新打开扩展后重试。");
    showStatus(await send({ type: "apply", settings: { cardSelectors: [] } }));
  }));
  get("diagnose").addEventListener("click", () => perform(async () => {
    // 由用户主动查看并复制结构线索，避免自动上传聊天页面信息。
    const diagnostic = await send({ type: "diagnose" });
    get("diagnostic-text").value = JSON.stringify(diagnostic, null, 2);
    get("diagnostic").hidden = false;
    get("diagnostic-text").focus();
    get("diagnostic-text").select();
  }));

  perform(async () => {
    const settings = await withTimeout(chrome.storage.local.get(defaults), "读取扩展设置超时，请重新加载扩展后重试。");
    get("enabled").checked = settings.enabled;
    get("turns").value = settings.turns;
    get("cards").value = settings.cards;
    const [tab] = await withTimeout(chrome.tabs.query({ active: true, currentWindow: true }), "读取当前标签页超时，请重新打开扩展后重试。");
    if (!tab || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "")) {
      throw new Error("请在 ChatGPT 聊天标签页中打开此扩展。");
    }
    tabId = tab.id;
    showStatus(await send({ type: "status" }));
  });
})();

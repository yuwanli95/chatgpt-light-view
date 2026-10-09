(() => {
  const defaults = { enabled: true, turns: 5, cards: 5, cardSelectors: [] };
  const turnSelector = '[data-testid^="conversation-turn-"], [data-testid="conversation-turn"], [data-turn="user"], [data-turn="assistant"], [data-talvt-turn-state]';
  const messageSelector = '[data-message-author-role]';
  const cardSelector = '[data-testid*="tool-call" i], [data-testid*="tool_call" i], [data-testid*="mcp-tool" i], [data-tool-call-id], [data-tool-name]';
  const mcpCardSelector = '[data-mcp-app-inline-surface], [data-mcp-app-frame]';
  const toolLabel = /(?:mcp__\w+|(?:^|[^a-z0-9_]|__)(?:read[_ -]files?|write[_ -]files?|read|write)(?=$|[^a-z0-9_])|读取文件|写入文件)/i;
  let settings = { ...defaults };
  let showAll = false;
  let timer;
  let picker;
  let initialized = false;
  let lastStats = { totalTurns: 0, shownTurns: 0, totalCards: 0, shownCards: 0, all: false };
  const marked = new Set();

  /** 识别有待用户处理的授权；入参为卡片，无返回数据，仅返回是否需要保留可见。 */
  function needsAction(node) {
    return Boolean(node.querySelector('[data-testid*="approval" i], [role="dialog"]')) ||
      [...node.querySelectorAll('button')].some((button) => !button.disabled &&
        /^(?:(?:allow|always allow|approve|deny|reject|confirm)(\b|\s|$)|允许|始终允许|批准|拒绝|确认)/i.test(button.textContent.trim()));
  }

  /** 校验卡片边界；入参为候选节点及是否允许工具结果正文，返回是否安全，避免隐藏用户输入或整条消息。 */
  function safeCard(node, allowOutput = false) {
    if (!node || node === document.body || node === document.documentElement || node.id === 'cgl-picker') return false;
    if (!node.closest(turnSelector + ', ' + messageSelector)) return false;
    if (node.matches(turnSelector + ', ' + messageSelector + ', article, .markdown, [data-markdown-text-style], pre, code, form')) return false;
    if (node.closest('[data-message-author-role="user"], [data-turn="user"], [data-user-message-bubble], .markdown, [data-markdown-text-style], pre, code, form')) return false;
    if (node.querySelector(messageSelector + ', [data-user-message-bubble], [data-conversation-role], textarea, [contenteditable="true"]')) return false;
    // 已确认的工具卡片可以包含 Markdown 结果，但卡片边界仍不得覆盖整条消息。
    return allowOutput || !node.querySelector('.markdown, [data-markdown-text-style]');
  }

  /** 收集单次提问及后续回复；无入参，返回按页面顺序排列的轮次，用于保留完整问答。 */
  function collectTurns() {
    let nodes = [...document.querySelectorAll(turnSelector)];
    if (!nodes.length) nodes = [...new Set([...document.querySelectorAll(messageSelector)].map((node) => {
      const article = node.closest('article');
      return article?.querySelectorAll(messageSelector).length === 1 ? article : node;
    }))];
    // 兼容嵌套容器时仅采用最外层轮次，避免同一条消息重复计数。
    const nodeSet = new Set(nodes);
    const roots = nodes.filter((node) => {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) if (nodeSet.has(parent)) return false;
      return true;
    });
    const groups = [];
    for (const root of roots) {
      const role = root.getAttribute('data-turn') || root.getAttribute('data-message-author-role') || root.querySelector(messageSelector)?.getAttribute('data-message-author-role');
      // 新版页面的状态容器已经包含一次完整问答，必须逐个计轮，不能合并其中的工具活动。
      if (root.hasAttribute('data-talvt-turn-state') || role === 'user' || !groups.length) groups.push([]);
      groups[groups.length - 1].push(root);
    }
    return groups;
  }

  /** 找到调用标题对应的完整卡片；入参为标题按钮，返回容器或按钮本身，兼容无边框的折叠组件。 */
  function findCard(button) {
    if (button.closest('.markdown, [data-markdown-text-style], pre, code')) return null;
    const panel = button.closest(cardSelector + ', details, [class*="rounded"][class*="border"]');
    if (safeCard(panel, true)) return panel;
    const controlled = (button.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id));
    if (controlled.length && controlled.every(Boolean)) {
      for (let parent = button.parentElement; safeCard(parent, true); parent = parent.parentElement) {
        if (controlled.every((node) => parent.contains(node))) return parent;
      }
    }
    return safeCard(button) ? button : null;
  }

  /** 收集自动或手动识别的卡片；入参为会话根节点，返回去重卡片，限制扫描范围以减少开销。 */
  function collectCards(roots) {
    const found = new Set();
    const selectors = [cardSelector, ...settings.cardSelectors];
    for (const root of roots) {
      // MCP 应用的标题与内容是兄弟节点；隐藏门户的父容器，才能同时移除标题、加载占位和 iframe 的显示。
      for (const node of root.querySelectorAll(mcpCardSelector)) {
        const panel = node.closest('[data-mcp-app-portal-target]')?.parentElement || node;
        if (safeCard(panel, true)) found.add(panel);
      }
      for (const selector of selectors) {
        try {
          for (const node of root.querySelectorAll(selector)) if (safeCard(node, true)) found.add(node);
        } catch { /* 旧版本保存的规则失效时继续使用其他规则，避免阻断整个聊天显示。 */ }
      }
      for (const button of root.querySelectorAll('button, [role="button"], summary')) {
        const label = button.textContent.trim();
        if (label.length > 180 || !toolLabel.test(label)) continue;
        const panel = findCard(button);
        if (panel) found.add(panel);
      }
    }
    // 优先保留外层卡片，防止同一张卡片的标题和正文占用多个名额。
    return [...found].filter((node) => {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) if (found.has(parent)) return false;
      return true;
    }).sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1);
  }

  /** 调整隐藏标记；入参为节点、标记和状态，无返回值，仅改变本扩展拥有的属性。 */
  function mark(node, attribute, hidden) {
    if (hidden) {
      if (!node.hasAttribute(attribute)) node.setAttribute(attribute, '');
      marked.add(node);
    } else node.removeAttribute(attribute);
  }

  /** 应用当前显示数量；无入参，返回统计，隐藏旧轮次并在可见轮次中保留最近卡片。 */
  function apply() {
    if (picker) return lastStats;
    const groups = collectTurns();
    const roots = groups.flat();
    const cards = collectCards(roots);
    const limited = settings.enabled && !showAll;
    document.documentElement.setAttribute('data-cgl-enabled', String(limited));
    const current = new Set([...roots, ...cards]);
    for (const node of marked) {
      if (!node.isConnected || !current.has(node)) {
        node.removeAttribute('data-cgl-hide-turn');
        node.removeAttribute('data-cgl-hide-card');
        marked.delete(node);
      }
    }
    let shownTurns = 0;
    groups.forEach((group, index) => {
      const hidden = limited && index < groups.length - settings.turns && !group.some(needsAction);
      if (!hidden) shownTurns++;
      for (const root of group) {
        mark(root, 'data-cgl-hide-turn', hidden);
      }
    });
    const visibleCards = cards.filter((card) => !card.closest('[data-cgl-hide-turn]'));
    const visibleSet = new Set(visibleCards);
    const protectedCards = new Set(visibleCards.filter(needsAction));
    const ordinaryCards = visibleCards.filter((card) => !protectedCards.has(card));
    const keepCards = new Set(ordinaryCards.slice(Math.max(0, ordinaryCards.length - settings.cards)));
    let shownCards = 0;
    for (const card of cards) {
      const hidden = limited && !keepCards.has(card) && !protectedCards.has(card);
      mark(card, 'data-cgl-hide-card', hidden);
      if (visibleSet.has(card) && !hidden) shownCards++;
    }
    lastStats = { totalTurns: groups.length, shownTurns, totalCards: cards.length, shownCards, all: !limited };
    initialized = true;
    return lastStats;
  }

  /** 合并页面变动；无入参或返回值，在持续生成时每隔 400 毫秒最多扫描一次。 */
  function schedule() {
    if (!timer) timer = setTimeout(() => { timer = null; apply(); }, 400);
  }

  /** 收集识别失败的结构线索；无入参，返回节点标记与数量，供适配页面使用，不读取聊天正文或输入值。 */
  function diagnose() {
    const scope = document.querySelector('main, [role="main"]') || document.body || document.documentElement;
    const candidates = [...scope.querySelectorAll('article, section, h1, h2, h3, h4, h5, h6, [data-testid], [data-message-id], [data-turn], [data-message-author-role], [data-talvt-turn-state], [data-mcp-app-inline-surface], [role="log"], [role="feed"]')];
    const nodes = candidates.length ? candidates : [...scope.querySelectorAll('div')];
    const samples = nodes.length > 40 ? [...nodes.slice(0, 20), ...nodes.slice(-20)] : nodes;
    /** 描述节点的识别特征；入参为元素，返回结构对象，排除文本、链接、标题和表单内容。 */
    function describe(node) {
      const result = { tag: node.tagName.toLowerCase() };
      for (const name of ['class', 'role', 'data-testid', 'data-turn', 'data-message-author-role', 'data-talvt-turn-state', 'data-mcp-app-inline-surface', 'data-mcp-app-frame']) {
        if (node.hasAttribute(name)) result[name] = node.getAttribute(name).slice(0, 180);
      }
      return result;
    }
    return {
      version: chrome.runtime.getManifest().version,
      readyState: document.readyState,
      conversationPath: /^\/c\//.test(location.pathname),
      scope: describe(scope),
      counts: {
        turns: document.querySelectorAll(turnSelector).length,
        messages: document.querySelectorAll(messageSelector).length,
        articles: document.querySelectorAll('article').length,
        tools: document.querySelectorAll(cardSelector + ', ' + mcpCardSelector).length,
        frames: document.querySelectorAll('iframe').length
      },
      samples: samples.map((node) => {
        const chain = [];
        for (let current = node; current && chain.length < 5; current = current.parentElement) chain.push(describe(current));
        return chain;
      })
    };
  }

  /** 生成手动卡片规则；入参为选中节点，返回 CSS 规则，用于识别同类组件而不记录聊天文本。 */
  function selectorFor(node) {
    const testId = node.getAttribute('data-testid');
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    const classes = [...node.classList].filter((name) => !name.startsWith('cgl-'));
    return classes.length ? node.tagName.toLowerCase() + classes.map((name) => '.' + CSS.escape(name)).join('') : '';
  }

  /** 启动卡片点选；无入参或返回值，让网页结构变化后的用户确认隐藏范围并保存识别规则。 */
  function startPicker() {
    if (picker) return;
    const host = document.createElement('div');
    host.id = 'cgl-picker';
    host.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>:host{font:14px/1.6 system-ui;color:#fff}.box{background:#123b30;border:1px solid #50c9a9;padding:12px 18px;border-radius:10px;max-width:600px}button{margin:8px 8px 0 0;padding:5px 12px;cursor:pointer}</style><div class="box"><div id="tip">点选卡片空白处；↑ 扩大范围，↓ 缩小范围。Enter 确认，Esc 取消。</div><button id="confirm">确认同类卡片</button><button id="cancel">取消</button></div>';
    document.documentElement.append(host);
    document.documentElement.setAttribute('data-cgl-enabled', 'false');
    let selected;
    let smaller;
    picker = host;

    /** 预览用户选择；入参为节点，无返回值，显示匹配数量以确认不会误选整个回答。 */
    function select(node) {
      if (!safeCard(node, true)) return;
      selected?.removeAttribute('data-cgl-picked');
      selected = node;
      selected.setAttribute('data-cgl-picked', '');
      const selector = selectorFor(selected);
      const count = selector ? collectTurns().flat().flatMap((root) => [...root.querySelectorAll(selector)].filter((node) => safeCard(node, true))).length : 0;
      shadow.getElementById('tip').textContent = `同类组件 ${count} 个。确认绿色边框只包住卡片。↑ 扩大，↓ 缩小，Enter 确认，Esc 取消。`;
    }

    /** 结束点选并恢复显示；无入参或返回值，清理临时监听器和边框，避免影响聊天操作。 */
    function finish() {
      selected?.removeAttribute('data-cgl-picked');
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
      host.remove();
      picker = null;
      apply();
    }

    /** 保存确认后的结构；无入参或返回值，将选择应用到所有聊天，保存失败时保留提示。 */
    async function confirm() {
      const selector = selected && selectorFor(selected);
      if (!selector) { shadow.getElementById('tip').textContent = '请先选中带有边框的卡片容器。'; return; }
      const cardSelectors = [...new Set([...settings.cardSelectors, selector])];
      try {
        await chrome.storage.local.set({ cardSelectors });
        settings.cardSelectors = cardSelectors;
        finish();
      } catch { shadow.getElementById('tip').textContent = '无法保存规则，请刷新页面后重试。'; }
    }

    /** 阻止点选触发原网页按钮；入参为点击事件，无返回值，保持点选过程可撤销。 */
    function click(event) {
      if (event.composedPath().includes(host)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const node = event.target.closest('details, [class*="rounded"][class*="border"], [data-testid*="tool"]') || event.target.closest('div');
      smaller = null;
      select(node);
    }

    /** 调整或确认卡片范围；入参为键盘事件，无返回值，让用户选择完整卡片容器。 */
    function key(event) {
      if (!['Escape', 'Enter', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') finish();
      else if (event.key === 'Enter') confirm();
      else if (event.key === 'ArrowUp' && safeCard(selected?.parentElement, true)) { smaller = selected; select(selected.parentElement); }
      else if (event.key === 'ArrowDown') select(smaller || selected?.firstElementChild);
    }
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
    shadow.getElementById('confirm').addEventListener('click', confirm);
    shadow.getElementById('cancel').addEventListener('click', finish);
  }

  /** 合并并校验保存的偏好；入参为配置对象，无返回值，确保数量始终处于界面允许范围。 */
  function updateSettings(value) {
    settings = { ...settings, ...value };
    settings.turns = Math.max(1, Math.min(100, Math.trunc(Number(settings.turns)) || 5));
    settings.cards = Math.max(0, Math.min(100, Math.trunc(Number(settings.cards)) || 0));
    settings.cardSelectors = Array.isArray(settings.cardSelectors) ? settings.cardSelectors.filter((item) => typeof item === 'string') : [];
  }

  // 合并结构变动和卡片标题更新，忽略回复正文逐字生成与扩展属性，避免反复扫描造成卡顿。
  const observer = new MutationObserver((records) => {
    if (records.some((record) => !record.target.closest?.('#cgl-picker') &&
      (record.type === 'attributes' ||
        (record.type === 'characterData' && record.target.parentElement?.closest('button, [role="button"], summary')) ||
        [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE || record.target.closest?.('button, [role="button"], summary'))))) schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-testid', 'data-message-author-role', 'data-turn', 'data-tool-call-id', 'data-tool-name', 'aria-controls', 'data-talvt-turn-state', 'data-mcp-app-inline-surface', 'data-mcp-app-frame'] });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    updateSettings(Object.fromEntries(Object.entries(changes).filter(([key]) => key in defaults).map(([key, value]) => [key, value.newValue ?? defaults[key]])));
    apply();
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.type === 'diagnose') { reply(diagnose()); return; }
    // 弹窗只读取最近统计；页面变动仍由观察器更新，避免打开弹窗时再次扫描大量工具输出。
    if (message.type === 'status') { reply(initialized ? lastStats : { pending: true }); return; }
    if (message.type === 'apply') { updateSettings(message.settings); showAll = false; }
    else if (message.type === 'toggleAll') showAll = !showAll;
    else if (message.type === 'pick') startPicker();
    else return;
    reply(apply());
  });
  chrome.storage.local.get(defaults).then((value) => { updateSettings(value); apply(); });
})();

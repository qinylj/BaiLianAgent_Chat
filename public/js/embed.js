/**
 * iframe 嵌入支持
 * ---------------------------------------------------------------------------
 * 1) 环境识别：URL 参数 ?embed=1 / ?embed=auto，或自动识别「被 iframe 引用」
 * 2) 双向通信：宿主 ←→ 子页，走 window.postMessage，带 origin 白名单校验
 *
 * 消息信封（两边一致）：
 *   { source: 'agent-chat'      , type, payload, ts }   子页 → 宿主（上行事件）
 *   { source: 'agent-chat-host' , type, payload, id? }  宿主 → 子页（下行命令）
 * 兼容写法：用 { action } 替代 { type } 也能识别。
 *
 * 上行事件（子页 → 宿主）
 *   ready          { version, agents[], agentId, conversationId, mock, embed, storage }
 *   user-message   { text, params }
 *   delta          { text, accumulated }     流式增量（已节流 120ms）
 *   thought        { text }                  思考过程增量
 *   reply          { text, thought, sessionId, requestId, taskId, messageId, images[], durationMs, error }
 *   error          { message }
 *   state          { busy, sessionId }
 *   command-done   { id, ok, error? }        对下行命令的应答
 *   height         { height }                ?embed=auto 时上报内容高度
 *
 * 下行命令（宿主 → 子页）
 *   ping / get-state   查询状态（会重新发一次 ready）
 *   ask                { text, params?, agentId?, newConversation?, autosend? } 直接提问
 *   set-params         { params }                    合并链接参数
 *   set-agent          { agentId }
 *   set-visual         { bg?, bgUrl?, theme?, veil?, blur? }
 *   stop                                             终止当前生成
 *   clear              { agentId? }                  新建会话（清空当前上下文）
 *   focus                                            聚焦输入框
 * ---------------------------------------------------------------------------
 */

const SOURCE = 'agent-chat';
const HOST_SOURCE = 'agent-chat-host';
export const PROTOCOL_VERSION = 1;

/** 识别嵌入环境与展示模式 */
export function detectEmbed() {
  const sp = new URLSearchParams(location.search);
  const forced = (sp.get('embed') || '').toLowerCase();

  let framed = false;
  try {
    framed = window.self !== window.top;
  } catch {
    // 跨域访问 window.top 抛异常，说明确实被跨域 iframe 引用
    framed = true;
  }

  let mode = null; // null | 'compact' | 'auto'
  if (forced === '1' || forced === 'true' || forced === 'yes' || forced === 'compact') mode = 'compact';
  else if (forced === 'auto') mode = 'auto';
  else if (forced === '0' || forced === 'false' || forced === 'no') mode = null;
  else if (framed) mode = 'compact'; // 被嵌入且没显式声明 → 默认走紧凑模式

  return { framed, mode, forced, autoHeight: mode === 'auto' };
}

function normalizeOrigin(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s === '*') return '*';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).origin;
  } catch {
    return '';
  }
}

/**
 * 解析宿主 origin。
 * 优先取 URL 的 ?parent=<origin>；否则用 document.referrer（跨站时浏览器只给 origin）；
 * 最后退化成本站 origin（同源宿主场景）。
 */
function resolveParentOrigin() {
  const explicit = normalizeOrigin(new URLSearchParams(location.search).get('parent'));
  if (explicit) return explicit;
  try {
    if (document.referrer) return new URL(document.referrer).origin;
  } catch {
    /* ignore */
  }
  return location.origin;
}

/**
 * 创建通信桥。
 * @param {object} opts
 * @param {(type: string, payload: object, meta: {id: string, origin: string}) => any} opts.onCommand 下行命令处理
 * @param {() => object} [opts.getState] 供 get-state / ready 使用的状态快照
 */
export function createBridge({ onCommand, getState } = {}) {
  const env = detectEmbed();
  const parentOrigin = resolveParentOrigin();
  const warnings = [];

  // 未处于 iframe 中：返回空实现，让 app.js 调用逻辑保持统一
  if (!env.framed) {
    return {
      env,
      parentOrigin: '',
      warnings,
      active: false,
      emit() {},
      reply() {},
      emitDelta() {},
      flushDelta() {},
      startAutoHeight() {},
      destroy() {},
    };
  }

  if (parentOrigin === '*') {
    warnings.push('?parent=* 表示不校验来源，仅建议在本地联调时使用。');
  }

  let seq = 0;
  const post = (type, payload) => {
    try {
      window.parent.postMessage({ source: SOURCE, version: PROTOCOL_VERSION, type, payload, ts: Date.now() }, parentOrigin || '*');
    } catch (err) {
      warnings.push(`postMessage 失败：${err.message}`);
    }
  };

  /* ---------------- 上行：事件 ---------------- */
  const emit = (type, payload = {}) => post(type, payload);

  let deltaBuf = '';
  let deltaAcc = '';
  let deltaTimer = null;
  const flushDelta = () => {
    if (deltaTimer) {
      clearTimeout(deltaTimer);
      deltaTimer = null;
    }
    if (!deltaBuf) return;
    post('delta', { text: deltaBuf, accumulated: deltaAcc });
    deltaBuf = '';
  };
  const emitDelta = (text, accumulated) => {
    deltaBuf += text || '';
    deltaAcc = accumulated || deltaAcc;
    if (deltaTimer) return;
    deltaTimer = setTimeout(() => {
      deltaTimer = null;
      flushDelta();
    }, 120);
  };

  /* ---------------- 下行：命令 ---------------- */
  const ack = (id, ok, extra = {}) => {
    if (id) post('command-done', { id, ok, ...extra });
  };

  async function handleMessage(event) {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    // 只认宿主的信封，避免和页面上其它 postMessage 广播互相干扰
    if (data.source !== HOST_SOURCE && data.source !== SOURCE) return;
    if (data.source === SOURCE && !data.id) return; // 自己发出的、非命令

    if (parentOrigin !== '*' && event.origin !== parentOrigin) {
      console.warn(`[embed] 忽略来自非白名单来源的消息：${event.origin}（期望 ${parentOrigin}）`);
      return;
    }

    const type = String(data.type || data.action || '');
    const payload = data.payload || data.data || {};
    if (!type) return;

    if (type === 'ping' || type === 'get-state') {
      emit('ready', { ...(getState ? getState() : {}), pong: true });
      ack(data.id, true);
      return;
    }

    if (!onCommand) {
      ack(data.id, false, { error: `不支持的命令：${type}` });
      return;
    }

    try {
      const result = await onCommand(type, payload, { id: data.id, origin: event.origin });
      ack(data.id, true, result && typeof result === 'object' ? { result } : {});
    } catch (err) {
      console.warn(`[embed] 命令执行失败 ${type}:`, err);
      ack(data.id, false, { error: err && err.message ? err.message : String(err) });
      emit('error', { message: err && err.message ? err.message : String(err) });
    }
  }

  window.addEventListener('message', handleMessage);

  /* ---------------- 自适应高度（?embed=auto） ---------------- */
  let observer = null;
  let heightTimer = null;
  function startAutoHeight() {
    if (!env.autoHeight) return;
    const target = document.getElementById('app') || document.body;
    const report = () => {
      clearTimeout(heightTimer);
      heightTimer = setTimeout(() => {
        const h = Math.ceil(Math.max(target.scrollHeight, document.body.scrollHeight, target.offsetHeight));
        post('height', { height: h });
      }, 60);
    };
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(report);
      observer.observe(target);
    }
    window.addEventListener('resize', report);
    report();
  }

  return {
    env,
    parentOrigin,
    warnings,
    active: true,
    emit,
    reply: (payload) => {
      flushDelta();
      post('reply', payload);
    },
    emitDelta,
    flushDelta,
    startAutoHeight,
    destroy() {
      window.removeEventListener('message', handleMessage);
      if (observer) observer.disconnect();
      clearTimeout(deltaTimer);
      clearTimeout(heightTimer);
    },
  };
}

/* ---------------- 宿主侧辅助（放进宿主页面即可用） ---------------- */

/**
 * 生成 iframe src。
 * @param {string} base 例：http://127.0.0.1:5178/
 * @param {object} opts { agent, q, params, bg, theme, embed:'1', parent, title, sidebar }
 */
export function buildEmbedUrl(base, opts = {}) {
  const url = new URL(base, location.href);
  const sp = url.searchParams;
  if (opts.embed !== null) sp.set('embed', opts.embed || '1');
  if (opts.agent) sp.set('agent', opts.agent);
  if (opts.q) sp.set('q', opts.q);
  if (opts.title) sp.set('title', opts.title);
  if (opts.bg) sp.set('bg', opts.bg);
  if (opts.theme) sp.set('theme', opts.theme);
  if (opts.autosend === false) sp.set('autosend', '0');
  // 侧栏默认展开；宿主窄容器里想要干净界面时传 sidebar:false / '0'
  if (opts.sidebar === false || opts.sidebar === '0' || opts.sidebar === 0) sp.set('sidebar', '0');
  else if (opts.sidebar === true) sp.set('sidebar', '1');
  if (opts.parent) sp.set('parent', normalizeOrigin(opts.parent));
  else if (location.origin) sp.set('parent', location.origin);
  for (const [k, v] of Object.entries(opts.params || {})) sp.set(k, v);
  return url.toString();
}

/**
 * 宿主侧轻量封装：一行接入。
 *   const chat = mountAgentChat(document.querySelector('#box'), { base:'http://127.0.0.1:5178/', q:'你好' });
 *   chat.on('reply', (p) => console.log(p.text));
 *   chat.ask('再帮我查一下');
 */
export function mountAgentChat(container, opts = {}) {
  const iframe = document.createElement('iframe');
  iframe.src = buildEmbedUrl(opts.base || location.origin + '/', opts);
  iframe.title = opts.title || '智能体对话';
  iframe.setAttribute('allow', 'clipboard-write');
  iframe.style.cssText =
    opts.iframeStyle || 'width:100%;height:100%;border:0;border-radius:12px;display:block;background:transparent';
  container.innerHTML = '';
  container.appendChild(iframe);

  const handlers = new Map();
  const origin = normalizeOrigin(opts.base) || location.origin;
  const ready = new Promise((resolve) => handlers.set('__ready', resolve));

  window.addEventListener('message', (event) => {
    const d = event.data;
    if (!d || d.source !== SOURCE) return;
    if (origin !== '*' && event.origin !== origin) return;
    if (d.type === 'ready') {
      const r = handlers.get('__ready');
      if (r) {
        handlers.delete('__ready');
        r(d.payload);
      }
    }
    (handlers.get(d.type) || []).forEach((fn) => fn(d.payload, d));
  });

  const on = (type, fn) => {
    const list = handlers.get(type);
    if (Array.isArray(list)) list.push(fn);
    else handlers.set(type, [fn]);
    return api;
  };

  let seq = 0;
  const send = (type, payload) => {
    const id = `c${++seq}`;
    iframe.contentWindow.postMessage({ source: HOST_SOURCE, type, payload, id }, origin);
    return id;
  };

  const api = {
    iframe,
    ready,
    on,
    send,
    ask: (text, payload = {}) => send('ask', { text, ...payload }),
    setParams: (params) => send('set-params', { params }),
    setAgent: (agentId) => send('set-agent', { agentId }),
    setVisual: (payload) => send('set-visual', payload),
    setSidebar: (collapsed) => send('set-sidebar', { collapsed: !!collapsed }),
    stop: () => send('stop', {}),
    clear: (agentId) => send('clear', { agentId }),
    focus: () => send('focus', {}),
    getState: () => send('get-state', {}),
    destroy: () => iframe.remove(),
  };
  return api;
}

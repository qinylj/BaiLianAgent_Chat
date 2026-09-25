/**
 * 会话与设置的本地持久化（localStorage）
 * 数据结构：
 *   agentchat.convos.v1  → { [id]: Conversation }
 *   agentchat.settings.v1 → UISettings
 *   agentchat.active.v1   → 当前会话 id
 *
 * Conversation = {
 *   id, title, agentId, sessionId, createdAt, updatedAt,
 *   kind: 'agent' | 'model',   // 归属类型，缺省视为 'agent'（老数据兼容）
 *   messages: Message[]
 * }
 *
 * ⚠️ `agentId` 在 kind === 'model' 时存的是 **config/models.json 里的模型 id**，
 *    不是智能体 id。之所以复用这个字段而不是新开一个，是为了让老会话数据（没有 kind）
 *    与既有代码路径继续可用；判断归属类型一律走 `kind`，别靠 agentId 猜。
 *    大模型的会话**没有 sessionId**：OpenAI 兼容接口是无状态的，每轮都带完整历史。
 * Message = {
 *   id, role: 'user' | 'assistant', text, thought, images: [],
 *   params: {}, attachments: [], requestId, taskId, messageId,
 *   vote: '' | 'LIKE' | 'DISLIKE', status: 'ok' | 'error' | 'streaming', ts
 * }
 */
const K_CONVOS = 'agentchat.convos.v1';
const K_SETTINGS = 'agentchat.settings.v1';
const K_ACTIVE = 'agentchat.active.v1';

const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);

/* --------------------------------------------------------------------------
   存储层
   跨站 iframe（第三方嵌入）里浏览器会禁用 localStorage，读写直接抛 SecurityError。
   如果只静默吞掉异常，会出现「当前会话能用、但侧栏历史列表空白」的诡异现象：
   因为 listConversations() 每次都读不到东西。所以这里探测一次，
   不可用时整体降级为内存 Map，至少保证本次会话内数据自洽。
   -------------------------------------------------------------------------- */
const memory = new Map();
let persistentFlag = null;

function canPersist() {
  if (persistentFlag !== null) return persistentFlag;
  try {
    const probe = '__agentchat_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    persistentFlag = true;
  } catch {
    persistentFlag = false;
    console.warn(
      '[store] localStorage 不可用（跨站 iframe / 隐私模式 / 存储被禁用），已降级为内存存储：' +
        '刷新或更换会话后历史将丢失。请在宿主页面用 allow-same-origin 的 sandbox，或改由 postMessage 接管历史。'
    );
  }
  return persistentFlag;
}

/** 是否具备真正的持久化能力（false = 内存降级） */
export const isPersistent = () => canPersist();
/** 'localStorage' | 'memory' */
export const storageMode = () => (canPersist() ? 'localStorage' : 'memory');

function read(key, fallback) {
  if (!canPersist()) return memory.has(key) ? memory.get(key) : fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  if (!canPersist()) {
    memory.set(key, value);
    return true;
  }
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('[store] 写入失败（可能超出容量）', err);
    return false;
  }
}

/* ---------------- 会话 ---------------- */
export function listConversations() {
  const map = read(K_CONVOS, {});
  return Object.values(map).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function getConversation(id) {
  return read(K_CONVOS, {})[id] || null;
}

export function saveConversation(conv) {
  const map = read(K_CONVOS, {});
  map[conv.id] = { ...conv, updatedAt: Date.now() };
  return write(K_CONVOS, map);
}

export function deleteConversation(id) {
  const map = read(K_CONVOS, {});
  delete map[id];
  write(K_CONVOS, map);
  if (getActiveId() === id) setActiveId('');
}

export function clearAllConversations() {
  write(K_CONVOS, {});
  setActiveId('');
}

export function createConversation(agentId, extra = {}) {
  const now = Date.now();
  const conv = {
    id: uid(),
    title: extra.title || '新对话',
    agentId,
    sessionId: '',
    createdAt: now,
    updatedAt: now,
    messages: [],
    ...extra,
  };
  saveConversation(conv);
  return conv;
}

export const getActiveId = () => read(K_ACTIVE, '');
export const setActiveId = (id) => write(K_ACTIVE, id);

export function newMessage(role, patch = {}) {
  return {
    id: uid(),
    role,
    text: '',
    thought: '',
    images: [],
    params: {},
    attachments: [],
    requestId: '',
    taskId: '',
    messageId: '',
    vote: '',
    status: 'ok',
    ts: Date.now(),
    ...patch,
  };
}

export const newId = uid;

/* ---------------- 设置 ---------------- */

/** 可选主题。新增主题时这里和 css 的 [data-theme=...] 一起加，app.js 用它做入参校验 */
export const THEMES = ['cockpit', 'dark', 'light'];

export const DEFAULT_SETTINGS = {
  agentId: '',
  /** 当前选中的大模型（config/models.json 的 id） */
  modelId: '',
  /** 侧栏当前选中的归属类型：'agent' 走网关智能体，'model' 走 OpenAI 兼容接口 */
  targetKind: 'agent',
  bgId: '',
  bgCustom: '',
  bgName: '',
  veil: 45,
  blur: 0,
  /**
   * 空串表示「跟随服务端默认」（config/settings.json 的 ui.defaultTheme）。
   * 只有用户主动点过主题按钮、或链接里显式传了 ?theme=，themeExplicit 才会变 true，
   * 此时才用 theme 的值。否则服务端改默认配色能直接生效 —— 老版本把 'dark' 写死在
   * 默认值里，会永久盖住服务端配置。
   */
  theme: '',
  themeExplicit: false,
  stream: true,
  delta: true,
  trace: true,
  serverHistory: true,
  params: {},
  attachments: [],
};

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...read(K_SETTINGS, {}) };
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  if (!write(K_SETTINGS, next)) {
    // 容量超限时优先丢弃自定义背景图片
    const slim = { ...next, bgCustom: '' };
    write(K_SETTINGS, slim);
    return slim;
  }
  return next;
}

/* ---------------- 导入 / 导出 ---------------- */
export function exportAll() {
  return { version: 1, exportedAt: new Date().toISOString(), conversations: listConversations() };
}

export function importAll(data) {
  const items = Array.isArray(data) ? data : data && data.conversations;
  if (!Array.isArray(items)) throw new Error('文件格式不正确');
  const map = read(K_CONVOS, {});
  let n = 0;
  for (const c of items) {
    if (!c || !c.id) continue;
    map[c.id] = c;
    n++;
  }
  write(K_CONVOS, map);
  return n;
}

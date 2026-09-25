#!/usr/bin/env node
/**
 * 阿里百炼 · 智能体对话服务端（零依赖）
 * ---------------------------------------------------------------------------
 * 职责：
 *   1) 静态托管 public/ 前端
 *   2) 代理网关 6 个接口（createSession / run / clearSession / deleteSession
 *      / feedback / taskFinishNotice），APP_KEY 只留在服务端，同时解决跨域
 *   3) 把网关的流式响应归一化成标准 SSE 事件推给浏览器
 *   4) 会话历史落盘 data/history/*.json（可选，浏览器 localStorage 为主）
 *   5) Mock 模式：无内网 / 无 APP_KEY 时也能完整跑通 UI 与链接传参
 *
 * 启动：node server.mjs
 * 配置：config/settings.json、config/agents.json
 *      APP_KEY 可全局配（settings.json 的 gateway.apiKey），
 *      也可**按智能体分别配**（agents.json 里每个智能体的 apiKey / baseUrl）；
 *      优先级：环境变量 > 智能体配置 > 全局配置
 *      环境变量覆盖：AGENT_APP_KEY / AGENT_BASE_URL；AGENT_MOCK=1 强制 Mock
 * ---------------------------------------------------------------------------
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_DIR = path.join(__dirname, 'config');
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const DEFAULT_PATHS = {
  createSession: '/createSession',
  run: '/run',
  clearSession: '/clearSession',
  deleteSession: '/deleteSession',
  feedback: '/feedback',
  taskFinishNotice: '/taskFinishNotice',
};

// ---------------------------------------------------------------------------
// 配置读取（带 mtime 缓存，改完 json 刷新页面即生效）
// ---------------------------------------------------------------------------
const _cfgCache = new Map();
function readJsonCached(file) {
  try {
    const st = fs.statSync(file);
    const hit = _cfgCache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.value;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    _cfgCache.set(file, { mtime: st.mtimeMs, value });
    return value;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[config] 解析失败 ${file}: ${err.message}`);
    return null;
  }
}

function getSettings() {
  const raw = readJsonCached(path.join(CONFIG_DIR, 'settings.json')) || {};
  const gw = raw.gateway || {};
  const envMock = process.env.AGENT_MOCK;
  return {
    port: Number(process.env.PORT || raw.port || 5178),
    // 监听地址：AGENT_HOST（推荐） / HOST（通用） > settings.json host > 127.0.0.1
    host: process.env.AGENT_HOST || process.env.HOST || raw.host || '127.0.0.1',
    mock: envMock !== undefined ? envMock === '1' : !!raw.mock,
    gateway: {
      baseUrl: String(process.env.AGENT_BASE_URL || gw.baseUrl || '').replace(/\/+$/, ''),
      apiKey: process.env.AGENT_APP_KEY || gw.apiKey || '',
      timeoutMs: Number(gw.timeoutMs || 120000),
      paths: { ...DEFAULT_PATHS, ...(gw.paths || {}) },
    },
    ui: raw.ui || {},
    history: raw.history || {},
    tool: raw.tool || {},
    embed: {
      // enabled=false → 禁止被任何页面 iframe 嵌入（frame-ancestors 'self'）
      enabled: (raw.embed && raw.embed.enabled) !== false,
      // 允许嵌入本页的宿主站点白名单，例：["https://portal.xxx.gov.cn"]
      allowOrigins: Array.isArray(raw.embed && raw.embed.allowOrigins)
        ? raw.embed.allowOrigins.map(normalizeOrigin).filter(Boolean)
        : [],
      // true = 允许任意站点嵌入（内网自用方便，公网慎开）
      allowAllOrigins: !!(raw.embed && raw.embed.allowAllOrigins),
      // 允许哪些站点跨域直连本服务 API（浏览器端）。默认空 = 只有同源能用
      corsOrigins: Array.isArray(raw.cors && raw.cors.allowOrigins)
        ? raw.cors.allowOrigins.map(normalizeOrigin).filter(Boolean)
        : [],
    },
    raw,
  };
}

/** 把 "https://a.com/x" / "a.com" 归一成 "https://a.com" */
function normalizeOrigin(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).origin;
  } catch {
    return '';
  }
}

/**
 * 读 agents.json 并归一化，结果**分两层**：
 *   - agents  ：可以下发给浏览器的公开字段（白名单，**绝不含任何密钥**）
 *   - secrets ：Map<id, {apiKey, baseUrl}>，服务端内部用 —— 每个智能体可以有自己的密钥
 *
 * 为什么要拆两层：`/api/config` 是把 agents 数组**整包发给浏览器**的。
 * 密钥只要混进这个数组，就等于对外公开了。所以密钥根本不进 agents，
 * 而是单独放在 secrets 里，只有 `resolveAgent()`（服务端内部）才去取。
 */
function readAgentsConfig() {
  const raw = readJsonCached(path.join(CONFIG_DIR, 'agents.json')) || {};
  const list = Array.isArray(raw.agents) ? raw.agents : [];
  const secrets = new Map();
  const agents = list.map((a, i) => {
    const id = a.id || `agent-${i + 1}`;
    // 每个智能体可以挂自己的 APP_KEY（覆盖 settings.json 的全局 key）。
    // 少数场景下还挂在不同的网关入口上（不同厂商 / 不同区域），所以 baseUrl 也允许按智能体覆盖。
    const apiKey = typeof a.apiKey === 'string' ? a.apiKey.trim() : '';
    const baseUrl = typeof a.baseUrl === 'string' ? a.baseUrl.trim().replace(/\/+$/, '') : '';
    if (apiKey || baseUrl) secrets.set(id, { apiKey, baseUrl });
    return {
      id,
      name: a.name || `智能体 ${i + 1}`,
      agentCode: a.agentCode || '',
      agentVersion: a.agentVersion || '',
      avatar: a.avatar || '🤖',
      // 图标 id（对应 public/js/agent-icons.js 里的键）。图形场景一律用它渲染内联 SVG，
      // avatar 那个 emoji 只作为纯文本场景 / 老配置的兜底。
      icon: a.icon || '',
      accent: a.accent || '#4f8cff',
      description: a.description || '',
      // 状态标签（如「建设中」）：纯展示字段，不参与任何逻辑，空值等于不显示。
      // 注意这里是**显式白名单** —— agents.json 里新增任何字段，都得同步加到这里，
      // 否则配置看着改了、前端却拿不到（本次 status 就是踩了这个）。
      status: a.status || '',
      welcome: a.welcome || '',
      suggestions: Array.isArray(a.suggestions) ? a.suggestions : [],
      urlTemplate: a.urlTemplate || '',
      defaultParams: a.defaultParams && typeof a.defaultParams === 'object' ? a.defaultParams : {},
      background: a.background || '',
      stream: a.stream !== false,
      delta: a.delta !== false,
      trace: a.trace !== false,
      // 只报「有没有自己的密钥」，不报值 —— 前端与排障需要知道谁在用自己的 key
      hasOwnKey: !!apiKey,
      hasOwnBaseUrl: !!baseUrl,
    };
  });
  return {
    // default 也必须是**存在的** id：用户可能把 default 指向的智能体删掉，
    // 这时若原样下发，前端会拿一个失效 id 存进设置，currentAgent() 再静默回退到列表第一个。
    default: agents.some((a) => a.id === raw.default) ? raw.default : (agents[0] && agents[0].id) || null,
    agents,
    secrets,
  };
}

/** 下发给浏览器的智能体列表（公开字段）—— `/api/config` 用它 */
function getAgents() {
  const { default: def, agents } = readAgentsConfig();
  return { default: def, agents };
}

/**
 * 服务端内部按 id / agentCode / name 解析智能体。
 * ⚠️ 返回值额外带上了该智能体自己的 `apiKey` / `baseUrl`（用来选对凭证），
 *    因此**只允许在服务端内部使用**，任何情况下都不得塞进响应体。
 */
function resolveAgent(key) {
  const { agents, default: def, secrets } = readAgentsConfig();
  const pick = (fn) => agents.find(fn);
  let found = null;
  if (!key) found = pick((a) => a.id === def) || agents[0] || null;
  else {
    const k = String(key).trim();
    found =
      pick((a) => a.id === k) ||
      pick((a) => a.agentCode === k) ||
      pick((a) => a.name === k) ||
      pick((a) => a.id.toLowerCase() === k.toLowerCase()) ||
      null;
  }
  if (!found) return null;
  const s = secrets.get(found.id);
  return s ? { ...found, ...s } : { ...found, apiKey: '', baseUrl: '' };
}

/**
 * 读 models.json 并归一化，同样**分两层**（与 readAgentsConfig 同一套路）：
 *   - models  ：可以下发给浏览器的公开字段（白名单，**绝不含 apiKey / baseUrl / system**）
 *   - secrets ：Map<id, {apiKey, baseUrl, system, temperature, maxTokens}>，仅服务端内部使用
 *
 * 与「智能体」的本质区别：大模型不需要 agentCode / agentVersion，
 * 走的是标准 OpenAI 兼容接口 `POST {baseUrl}/chat/completions`，
 * 所以一条配置只要有 id + model + baseUrl + apiKey 就能跑。
 */
function readModelsConfig() {
  const raw = readJsonCached(path.join(CONFIG_DIR, 'models.json')) || {};
  const list = Array.isArray(raw.models) ? raw.models : [];
  const secrets = new Map();
  const models = list.map((m, i) => {
    const id = m.id || `model-${i + 1}`;
    // 环境变量优先：探针要把请求指到本地假服务时，不必去改用户的 models.json
    // （与 AGENT_APP_KEY 同理，是给排障留的安全阀）
    const apiKey = String(process.env.AGENT_MODEL_APP_KEY || m.apiKey || '').trim();
    const baseUrl = String(process.env.AGENT_MODEL_BASE_URL || m.baseUrl || '').trim().replace(/\/+$/, '');
    const system = typeof m.system === 'string' ? m.system : '';
    const temperature = Number.isFinite(Number(m.temperature)) ? Number(m.temperature) : undefined;
    const maxTokens = Number(m.maxTokens) > 0 ? Number(m.maxTokens) : undefined;
    secrets.set(id, { apiKey, baseUrl, system, temperature, maxTokens });
    return {
      id,
      name: m.name || `模型 ${i + 1}`,
      // 服务商侧的模型名（如 qwen-plus / gpt-4o）—— 不是密钥，可以下发，前端也会显示
      model: m.model || '',
      avatar: m.avatar || '🧠',
      icon: m.icon || '',
      accent: m.accent || '#4f8cff',
      description: m.description || '',
      status: m.status || '',
      welcome: m.welcome || '',
      suggestions: Array.isArray(m.suggestions) ? m.suggestions : [],
      // 与智能体条目保持一致的命名，前端可以用同一套 `hasOwnKey` 逻辑做提示
      hasOwnKey: !!apiKey,
      hasOwnBaseUrl: !!baseUrl,
    };
  });
  return {
    // default 必须落在**存在的** id 上（与 agents 同理：指向已删条目时静默回退第一个）
    default: models.some((m) => m.id === raw.default) ? raw.default : (models[0] && models[0].id) || null,
    models,
    secrets,
  };
}

/** 下发给浏览器的大模型列表（公开字段）—— `/api/config` 用它 */
function getModels() {
  const { default: def, models } = readModelsConfig();
  return { default: def, models };
}

/**
 * 服务端内部按 id / model 名 / 展示名解析大模型。
 * ⚠️ 返回值带上了该模型的 `apiKey` / `baseUrl` / `system`，
 *    因此**只允许在服务端内部使用**，任何情况下都不得塞进响应体。
 */
function resolveModel(key) {
  const { models, default: def, secrets } = readModelsConfig();
  const pick = (fn) => models.find(fn);
  let found = null;
  if (!key) found = pick((m) => m.id === def) || models[0] || null;
  else {
    const k = String(key).trim();
    found =
      pick((m) => m.id === k) ||
      pick((m) => m.model === k) ||
      pick((m) => m.name === k) ||
      pick((m) => m.id.toLowerCase() === k.toLowerCase()) ||
      null;
  }
  if (!found) return null;
  const s = secrets.get(found.id) || {};
  return { ...found, ...s };
}

/**
 * 大模型缺配置时的报错：点名是哪个模型、缺什么、去哪配（照抄智能体那套体验）
 */
function missingModelMessage(model, which) {
  const where = '请在 config/models.json 给它加 "baseUrl" 与 "apiKey"，或设置环境变量 AGENT_MODEL_BASE_URL / AGENT_MODEL_APP_KEY';
  return `大模型「${model && model.name ? model.name : '(未知)'}」缺少 ${which} —— ${where}`;
}

/**
 * 把上游的失败响应翻译成「照着就能改」的报错。
 *
 * 起因是一个真实故障：baseUrl 填了 DeepSeek 的 Anthropic 兼容入口
 * （`https://api.deepseek.com/anthropic`），拼出来的 `/anthropic/chat/completions`
 * 返回 **404 且响应体为空** —— 原报错只剩「大模型接口返回 HTTP 404：」，等于什么都没说，
 * 只能靠猜。所以这里必须三样一起给：状态码、**实际请求的 URL**、上游原文（空也要说明是空的），
 * 能一眼看出的情况再直接给出改法。
 */
function modelErrorHint(model, url, status, bodyText) {
  const body = String(bodyText || '').trim();
  const lines = [`大模型接口返回 HTTP ${status}${body ? `：${body.slice(0, 400)}` : '（上游响应体为空，没给原因）'}`];
  lines.push(`请求地址：${url}`);

  const base = String((model && model.baseUrl) || '');
  if (/\/anthropic\/?$/i.test(base)) {
    lines.push(
      `⚠️ baseUrl 指向的是 Anthropic 兼容入口，本服务只支持 OpenAI 兼容接口（{baseUrl}/chat/completions）。` +
        `把结尾的 /anthropic 去掉即可，例如 ${base.replace(/\/anthropic\/?$/i, '')}`
    );
  } else if (status === 404 && !body) {
    lines.push('⚠️ baseUrl 路径多半不对：只填到 /v1（或域名根）为止，本服务会自动补 /chat/completions');
  } else if (status === 404) {
    lines.push('⚠️ 上游没有这个路径：核对 baseUrl，以及该地址是否提供 OpenAI 兼容接口');
  }
  if (status === 401 || status === 403) lines.push('⚠️ 多半是 apiKey 无效，或这把 key 没有该模型的权限');
  if (status === 429) lines.push('⚠️ 触发限流或额度不足');
  if (status >= 500) lines.push('⚠️ 上游服务端异常，稍后重试');
  return lines.join('\n');
}

/** baseUrl 指向 Anthropic 兼容入口时，启动阶段就提醒（别等第一条消息失败才发现） */
function anthropicBaseUrlWarning(model, baseUrl) {
  if (!/\/anthropic\/?$/i.test(baseUrl)) return '';
  return (
    `    ⚠️ ${model.name}：baseUrl 是 Anthropic 兼容入口（${baseUrl}），` +
    `本服务只支持 OpenAI 兼容接口，请去掉结尾的 /anthropic` +
    `（如 ${baseUrl.replace(/\/anthropic\/?$/i, '')}）`
  );
}

/**
 * 解析「这一次调用」真正要用的网关凭证。
 * 优先级：**环境变量 > 智能体自身配置 > settings.json 全局配置**。
 *
 * 环境变量放最高位是有意的：探针（`AGENT_BASE_URL` 指向假网关）与临时排障必须能压住
 * 任何智能体级配置，否则会误打真实网关、白烧额度。环境变量是「一次性/调试用」的强覆盖。
 */
function gatewayFor(settings, agent) {
  const g = settings.gateway;
  const envKey = String(process.env.AGENT_APP_KEY || '').trim();
  const envBase = String(process.env.AGENT_BASE_URL || '').trim();
  const aKey = String((agent && agent.apiKey) || '').trim();
  const aBase = String((agent && agent.baseUrl) || '').trim();
  const apiKey = envKey || aKey || g.apiKey || '';
  const baseUrl = (envBase || aBase || g.baseUrl || '').replace(/\/+$/, '');
  return {
    baseUrl,
    apiKey,
    // 来源标记：报错信息与启动日志都要说清楚「这个 key 是从哪来的」，
    // 否则用户改完 agents.json 发现没生效会无从下手（本项目为「配置改了不生效」踩过多次）。
    apiKeyFrom: envKey ? 'env' : aKey ? 'agent' : g.apiKey ? 'global' : 'none',
    baseUrlFrom: envBase ? 'env' : aBase ? 'agent' : g.baseUrl ? 'global' : 'none',
    timeoutMs: g.timeoutMs,
    paths: g.paths,
    agentName: (agent && agent.name) || '',
  };
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

const uid = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// 网关请求
// ---------------------------------------------------------------------------
/** 密钥脱敏：日志里只留前 3 后 4，够区分是哪个 key，又不至于泄露 */
const maskKey = (k) => {
  const s = String(k || '');
  if (!s) return '【未配置】';
  if (s.length <= 8) return `${s[0]}****`;
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
};

/** 缺 key 时的报错：必须说清「是哪个智能体缺」以及「去哪配」，否则用户不知道改哪个文件 */
function missingKeyMessage(gw) {
  const base = '未配置 APP_KEY';
  if (gw.agentName) {
    return (
      `智能体「${gw.agentName}」没有可用的 APP_KEY —— ` +
      `请在 config/agents.json 给它加 "apiKey"，` +
      `或在 config/settings.json 配全局 gateway.apiKey / 用环境变量 AGENT_APP_KEY 启动`
    );
  }
  return `${base}：config/settings.json 的 gateway.apiKey 为空，且未设置环境变量 AGENT_APP_KEY`;
}

function gatewayUrl(gw, name) {
  if (!gw.baseUrl) throw new HttpError(500, '未配置网关地址（config/settings.json 的 gateway.baseUrl）');
  return gw.baseUrl + (gw.paths[name] || `/${name}`);
}

async function gatewayFetch(gw, name, payload, signal) {
  if (!gw.apiKey) throw new HttpError(500, missingKeyMessage(gw));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('网关请求超时')), gw.timeoutMs);
  const signals = signal ? [signal, ctrl.signal] : [ctrl.signal];
  try {
    const resp = await fetch(gatewayUrl(gw, name), {
      method: 'POST',
      headers: {
        // 这里用的是 gatewayFor() 解析出来的**这一次调用专属**的 key：
        // 智能体若配了自己的 apiKey，就用它；否则回落到全局 key。
        Authorization: `Bearer ${gw.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.any(signals),
    });
    return { resp, clear: () => clearTimeout(timer) };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new HttpError(499, '请求已取消');
    throw new HttpError(502, `网关连接失败：${err.message}`);
  }
}

/** JSON 型接口：统一校验 success */
async function gatewayJson(gw, name, payload) {
  const { resp, clear } = await gatewayFetch(gw, name, payload);
  try {
    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new HttpError(502, `网关返回非 JSON（HTTP ${resp.status}）：${text.slice(0, 200)}`);
    }
    if (!resp.ok) throw new HttpError(resp.status, json.errorMsg || json.errorCode || `网关错误 HTTP ${resp.status}`, json);
    if (json.success === false) throw new HttpError(400, json.errorMsg || json.errorCode || '业务失败', json);
    return json;
  } finally {
    clear();
  }
}

// ---------------------------------------------------------------------------
// 流式响应归一化
// ---------------------------------------------------------------------------
function pickStr(...vals) {
  for (const v of vals) if (typeof v === 'string' && v) return v;
  if (typeof vals[0] === 'string') return vals[0];
  return '';
}

/** 从任意嵌套结构里把文本抠出来 */
function extractText(node, depth = 0) {
  if (node == null || depth > 8) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map((n) => extractText(n, depth + 1)).join('');
  if (typeof node === 'object') {
    let out = '';
    if (typeof node.value === 'string') out += node.value;
    if (typeof node.data === 'string' && node.data !== out) out += node.data;
    if (node.text !== undefined) out += extractText(node.text, depth + 1);
    if (node.content !== undefined) out += extractText(node.content, depth + 1);
    return out;
  }
  return '';
}

function extractImages(node, acc = [], depth = 0) {
  if (node == null || depth > 8) return acc;
  if (Array.isArray(node)) {
    node.forEach((n) => extractImages(n, acc, depth + 1));
    return acc;
  }
  if (typeof node === 'object') {
    if (node.type === 'image') {
      const url = (node.image && node.image.url) || node.url;
      if (url) acc.push({ url, name: node.name || '' });
    }
    if (node.content !== undefined) extractImages(node.content, acc, depth + 1);
    if (node.image !== undefined) extractImages(node.image, acc, depth + 1);
  }
  return acc;
}

class StreamNormalizer {
  constructor(send) {
    this.send = send;
    this.acc = { text: '', thought: '', sessionId: '', requestId: '', taskId: '', messageId: '' };
    this.ended = false;
    this.lastMeta = '';
  }

  pushLine(line) {
    let s = String(line).trim();
    if (!s || s.startsWith(':')) return; // 空行 / 心跳
    if (/^(event|id|retry)\s*:/i.test(s)) return;
    if (/^data\s*:/i.test(s)) s = s.replace(/^data\s*:/i, '').trim();
    if (!s) return;
    if (s === '[DONE]') {
      this.finish();
      return;
    }
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      return; // 半包 / 非 JSON 片段，忽略
    }
    this.emit(obj);
  }

  emit(obj) {
    if (!obj || typeof obj !== 'object') return;
    const meta = obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {};

    const sessionId = pickStr(obj.sessionId, meta.sessionId);
    const requestId = pickStr(obj.requestId, meta.requestId);
    const taskId = pickStr(obj.taskId, meta.usage && meta.usage.taskId);
    const messageId = pickStr(obj.id, meta.id);
    if (sessionId) this.acc.sessionId = sessionId;
    if (requestId) this.acc.requestId = requestId;
    if (taskId) this.acc.taskId = taskId;
    if (messageId) this.acc.messageId = messageId;

    const metaKey = [this.acc.sessionId, this.acc.requestId, this.acc.taskId, this.acc.messageId].join('|');
    if (metaKey !== this.lastMeta) {
      this.lastMeta = metaKey;
      this.send('meta', { ...this.acc });
    }

    const object = String(obj.object || '').toLowerCase();

    // 错误帧
    if (object === 'error' || obj.errorCode) {
      const msg =
        extractText(obj) ||
        (obj.content && obj.content.errorMsg) ||
        obj.errorMsg ||
        '智能体返回错误';
      this.send('error', { message: String(msg), code: obj.errorCode || null });
      return;
    }

    const isThought = object.includes('thought');
    const text = extractText(obj.content !== undefined ? obj.content : obj.data);

    // end 帧通常只带标记，不带正文，避免重复拼接
    const isEnd = obj.end === true || object === 'message.completed' || obj.status === 'completed';

    if (text && !isEnd) {
      if (isThought) {
        this.acc.thought += text;
        this.send('thought', { text });
      } else {
        this.acc.text += text;
        this.send('delta', { text });
      }
    } else if (text && isEnd && !this.acc.text) {
      this.acc.text = text;
      this.send('delta', { text });
    }

    const images = extractImages(obj.content);
    if (images.length) this.send('image', { images });

    if (isEnd) this.finish();
  }

  finish() {
    if (this.ended) return;
    this.ended = true;
    this.send('end', { message: this.acc.text, thought: this.acc.thought, ...this.acc });
  }
}

// ---------------------------------------------------------------------------
// Mock 模式（无内网时验证 UI / 链传参）
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mockRun({ agent, payload, send, isClosed }) {
  const sessionId = payload.sessionId || `mock-${uid()}`;
  const requestId = uid();
  const taskId = uid();
  const text = String((payload.message && payload.message.text) || '');
  const meta = (payload.message && payload.message.metadata) || {};

  send('meta', { sessionId, requestId, taskId, messageId: uid() });
  await sleep(120);

  const thinkChunks = [
    `[Mock] 已接收会话 sessionId=${sessionId.slice(0, 8)}…`,
    ` 智能体=${agent.name}（${agent.agentCode || '未配置 agentCode'}）`,
    ' 正在解析链接传入参数并组织回答…',
  ];
  for (const c of thinkChunks) {
    if (isClosed()) return;
    send('thought', { text: c });
    await sleep(140);
  }

  const paramLines = Object.entries(meta).length
    ? Object.entries(meta)
        .map(([k, v]) => `| \`${k}\` | ${typeof v === 'object' ? JSON.stringify(v) : String(v)} |`)
        .join('\n')
    : '| — | 未传入额外参数 |';

  const body = [
    `### 来自「${agent.name}」的模拟回复`,
    '',
    `**你说的是：** ${text || '（空）'}`,
    '',
    '**已随请求写入 `message.metadata` 的参数：**',
    '',
    '| 参数 | 值 |',
    '| --- | --- |',
    paramLines,
    '',
    '> 当前为 **Mock 模式**，数据由本地服务端生成。把 `config/settings.json` 里的 `mock` 改为 `false`、',
    '> 填入政务外网 `gateway.baseUrl` 与 `APP_KEY` 后，即可切换到真实网关。',
    '',
    '**已验证的链路能力：**',
    '',
    '1. 多轮对话（sessionId 复用，历史上下文由网关侧维护）',
    '2. 流式增量输出（`message.delta` 归一化为 `event: delta`）',
    '3. 思考链路（`thought.delta` → `event: thought`）',
    '4. 链接参数透传 → `metadata` + prompt',
    '5. 终止 / 删除 / 点赞点踩 回调',
    '',
  ].join('\n');

  // 按字符切片，模拟打字机
  const step = 6;
  for (let i = 0; i < body.length; i += step) {
    if (isClosed()) return;
    send('delta', { text: body.slice(i, i + step) });
    await sleep(12);
  }
  send('end', { message: body, thought: thinkChunks.join(''), sessionId, requestId, taskId, messageId: '' });
}

// ---------------------------------------------------------------------------
// 业务处理器
// ---------------------------------------------------------------------------
async function handleConfig(res) {
  const settings = getSettings();
  const { agents, default: def, secrets } = readAgentsConfig();
  const { models, default: defModel } = getModels();
  const own = [...secrets.values()];
  const anyOwnKey = own.some((s) => !!s.apiKey);
  const anyOwnBaseUrl = own.some((s) => !!s.baseUrl);
  sendJson(res, 200, {
    ok: true,
    mock: settings.mock,
    // 能调通网关 = 有地址且有权钥。地址与权钥都允许来自「全局配置」或「某个智能体自带」，
    // 所以只要任一来源齐备就算配置完成（具体某个智能体能不能跑，看它那一条的 hasOwnKey）。
    gatewayConfigured: !!(
      (settings.gateway.baseUrl || anyOwnBaseUrl) &&
      (settings.gateway.apiKey || anyOwnKey)
    ),
    gatewayBaseUrl: settings.gateway.baseUrl,
    defaultAgent: def,
    // ⚠️ agents 是**公开字段**列表（不含 apiKey / baseUrl），只带 hasOwnKey 布尔标记。
    //    密钥绝不能出现在这里 —— 这个响应是直接发给浏览器的。
    agents,
    // 大模型同理：走同一条公开/私有分层，apiKey、baseUrl、system 提示词都不下发。
    // defaultModel 用于前端「没选过就落到默认模型」的兜底。
    defaultModel: defModel,
    models,
    // ui 段原样下发，其中 showModels / showAgents 决定侧栏两个分组是否显示
    // （链接里显式带 ?model= / ?agent= 时可以强制显示，见 public/js/app.js 的 applyRegions）
    ui: settings.ui,
    embed: {
      enabled: settings.embed.enabled,
      allowOrigins: settings.embed.allowOrigins,
      allowAllOrigins: settings.embed.allowAllOrigins,
    },
  });
}

// sessionId → agentId 的**内存**记忆（重启即失）：
// clearSession / deleteSession / feedback 只有 sessionId，不知道属于哪个智能体。
// 前端新版本会显式带 agentId；这里兜底老版本 / 第三方调用，
// 免得拿着全局 key 去调别的智能体建的会话（网关会报「会话不存在」）。
const sessionAgentMap = new Map();
function rememberSession(sessionId, agentId) {
  if (!sessionId || !agentId) return;
  if (sessionAgentMap.size > 2000) sessionAgentMap.delete(sessionAgentMap.keys().next().value);
  sessionAgentMap.set(sessionId, agentId);
}
/** 由 body.agentId（优先）或会话记忆推出该用哪个智能体的凭证；推不出来返回 null（走全局配置） */
function agentForBody(body, sessionId) {
  const key = body.agentId || body.agentCode || sessionAgentMap.get(sessionId) || '';
  // ⚠️ 这里**不能**走 resolveAgent('') 的「回落默认智能体」语义：
  //    算不出来时若随便挑一个智能体，就会把它的专属 key 用到别人的会话上。
  //    宁可退回全局配置（配置不全时网关会明确报错，好过静默用错凭证）。
  return key ? resolveAgent(key) : null;
}

async function handleCreateSession(req, res) {
  const body = await readJsonBody(req);
  const settings = getSettings();
  const agent = resolveAgent(body.agentId || body.agentCode);
  if (!agent) throw new HttpError(400, `未知智能体：${body.agentId || body.agentCode || '(空)'}`);

  if (settings.mock) {
    await sleep(180);
    return sendJson(res, 200, { ok: true, mock: true, agentId: agent.id, sessionId: `mock-${uid()}` });
  }
  if (!agent.agentCode) throw new HttpError(400, `智能体「${agent.name}」未配置 agentCode`);

  const payload = { agentCode: agent.agentCode };
  if (agent.agentVersion) payload.agentVersion = agent.agentVersion;
  const json = await gatewayJson(gatewayFor(settings, agent), 'createSession', payload);
  const sessionId = (json.data && (json.data.uniqueCode || json.data.sessionId)) || '';
  if (!sessionId) throw new HttpError(502, '网关未返回 uniqueCode', json);
  rememberSession(sessionId, agent.id);
  sendJson(res, 200, { ok: true, agentId: agent.id, sessionId, raw: json });
}

async function handleRun(req, res) {
  const body = await readJsonBody(req);
  const settings = getSettings();
  const agent = resolveAgent(body.agentId);
  if (!agent) throw new HttpError(400, `未知智能体：${body.agentId || '(空)'}`);

  const message = body.message || {};
  const payload = {
    sessionId: body.sessionId || '',
    stream: body.stream !== undefined ? !!body.stream : agent.stream,
    delta: body.delta !== undefined ? !!body.delta : agent.delta,
    trace: body.trace !== undefined ? !!body.trace : agent.trace,
    message: {
      text: String(message.text || body.text || ''),
      metadata: message.metadata && typeof message.metadata === 'object' ? message.metadata : {},
      attachments: Array.isArray(message.attachments)
        ? message.attachments.filter((a) => a && a.url).map((a) => ({ url: a.url, name: a.name || '' }))
        : [],
    },
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  const abort = new AbortController();
  req.on('close', () => {
    closed = true;
    if (!res.writableEnded) abort.abort();
  });
  const send = (event, data) => {
    if (closed || res.writableEnded) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      closed = true;
    }
  };

  const normalizer = new StreamNormalizer(send);
  try {
    if (settings.mock) {
      await mockRun({ agent, payload, send, isClosed: () => closed });
    } else {
      const { resp, clear } = await gatewayFetch(gatewayFor(settings, agent), 'run', payload, abort.signal);
      try {
        if (!resp.ok) {
          const t = await resp.text();
          send('error', { message: `网关错误 HTTP ${resp.status}：${t.slice(0, 300)}` });
          normalizer.finish();
          return;
        }
        const ct = (resp.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('application/json')) {
          const json = await resp.json();
          const d = json.data || {};
          const msgContent = (d.message && d.message.content) || [];
          const thoughts = Array.isArray(d.thoughts)
            ? d.thoughts.map((t) => extractText(t.content)).filter(Boolean).join('\n')
            : '';
          const finalText = extractText(msgContent);
          const sessionId = pickStr(d.sessionId, payload.sessionId);
          const requestId = pickStr(d.requestId, d.message && d.message.requestId);
          const taskId = pickStr(d.taskId, d.message && d.message.taskId);
          send('meta', { sessionId, requestId, taskId, messageId: '' });
          if (thoughts) {
            normalizer.acc.thought = thoughts;
            send('thought', { text: thoughts });
          }
          if (finalText) {
            normalizer.acc.text = finalText;
            send('delta', { text: finalText });
          }
          const imgs = extractImages(msgContent);
          if (imgs.length) send('image', { images: imgs });
          send('end', { message: finalText, thought: thoughts, sessionId, requestId, taskId, messageId: '' });
          normalizer.ended = true;
        } else {
          const decoder = new TextDecoder('utf-8');
          let buf = '';
          for await (const chunk of resp.body) {
            buf += decoder.decode(chunk, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
              normalizer.pushLine(buf.slice(0, idx).replace(/\r$/, ''));
              buf = buf.slice(idx + 1);
            }
          }
          buf += decoder.decode();
          if (buf.trim()) normalizer.pushLine(buf);
        }
      } finally {
        clear();
      }
    }
  } catch (err) {
    if (err && err.status !== 499) send('error', { message: err.message || '调用失败' });
  } finally {
    if (!normalizer.ended) normalizer.finish();
    if (!closed && !res.writableEnded) res.end();
  }
}

// ---------------------------------------------------------------------------
// 大模型（OpenAI 兼容接口）
// ---------------------------------------------------------------------------
/**
 * Mock 模式下的大模型回复：结构与真实链路一致（meta → delta… → end），
 * 但内容是本地生成的，方便在没有厂商 key 时把 UI 与新链路整条跑通。
 */
async function mockModelChat({ model, messages, send, isClosed }) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  send('meta', { modelId: model.id, model: model.model, mock: true });
  await sleep(120);

  const thought = ['[Mock] 未配置真实大模型接口，本次由本地生成回复。', ` 模型：${model.name}（${model.model || '未填 model'}）`];
  for (const c of thought) {
    if (isClosed()) return '';
    send('thought', { text: c });
    await sleep(120);
  }

  const body = [
    `### 来自「${model.name}」的模拟回复`,
    '',
    `**你说的是：** ${(lastUser && lastUser.content) || '（空）'}`,
    '',
    `**本次发送的 messages 条数：** ${messages.length}`,
    '',
    '> 当前为 **Mock 模式**。把 `config/settings.json` 的 `mock` 改为 `false`，',
    '> 并在 `config/models.json` 里填好 `baseUrl` 与 `apiKey`，即可调用真实大模型。',
    '',
  ].join('\n');

  for (let i = 0; i < body.length; i += 6) {
    if (isClosed()) return '';
    send('delta', { text: body.slice(i, i + 6) });
    await sleep(12);
  }
  return body;
}

/**
 * 大模型对话：本项目把配置里的模型当成一个**无状态对话端点**。
 *
 * 与智能体链路的根本区别：
 *   - 智能体**有状态**：先 createSession，之后每轮只发增量，历史由网关侧维护；
 *   - OpenAI 兼容接口**无状态**：每轮都要把完整历史（messages 数组）带上。
 * 所以前端对大模型会话不建 sessionId，直接把会话里的消息整段转过来。
 *
 * 出口仍统一成与智能体一致的 SSE 事件（meta / delta / thought / end / error），
 * 前端渲染管线因此可以完全复用，不必为两条链路各写一套。
 */
async function handleModelChat(req, res) {
  const body = await readJsonBody(req);
  const settings = getSettings();
  const model = resolveModel(body.modelId);
  if (!model) throw new HttpError(400, `未配置大模型：${body.modelId || '(未指定)'}（请检查 config/models.json）`);

  // 只认 role / content：前端消息对象上还挂着 id / ts / vote 等字段，绝不能整包透传给服务商
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .map((m) => ({
      role: m && m.role === 'assistant' ? 'assistant' : 'user',
      content: String((m && m.content) || ''),
    }))
    .filter((m) => m.content.trim());
  if (!messages.length) throw new HttpError(400, 'messages 不能为空');
  // system 提示词来自配置（不下发浏览器），放在最前面
  if (model.system) messages.unshift({ role: 'system', content: model.system });

  const wantStream = body.stream !== false;
  if (!settings.mock) {
    if (!model.baseUrl) throw new HttpError(400, missingModelMessage(model, 'baseUrl（接口地址）'));
    if (!model.apiKey) throw new HttpError(400, missingModelMessage(model, 'apiKey（密钥）'));
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  const abort = new AbortController();
  req.on('close', () => {
    closed = true;
    if (!res.writableEnded) abort.abort();
  });
  const send = (event, data) => {
    if (closed || res.writableEnded) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      closed = true;
    }
  };

  let fullText = '';
  let fullThought = '';
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    send('end', { message: fullText, thought: fullThought, modelId: model.id });
  };

  try {
    if (settings.mock) {
      fullText = await mockModelChat({ model, messages, send, isClosed: () => closed });
      finish();
      return;
    }

    // baseUrl 允许两种写法：到 /v1 为止，或直接写到 /chat/completions
    const url = /\/chat\/completions\/?$/.test(model.baseUrl)
      ? model.baseUrl
      : `${model.baseUrl}/chat/completions`;
    const payload = { model: model.model || model.id, messages, stream: wantStream };
    const temperature = Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : model.temperature;
    if (temperature !== undefined) payload.temperature = temperature;
    if (model.maxTokens) payload.max_tokens = model.maxTokens;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('大模型请求超时')), settings.gateway.timeoutMs);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${model.apiKey}`,
          'Content-Type': 'application/json',
          Accept: wantStream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([abort.signal, ctrl.signal]),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const t = await resp.text();
      send('error', { message: modelErrorHint(model, url, resp.status, t) });
      finish();
      return;
    }

    // 服务商不认 stream 时可能仍然回 JSON，这里按 content-type 分流，避免解析炸掉
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (!wantStream || ct.includes('application/json')) {
      const json = await resp.json();
      const choice = (json.choices && json.choices[0]) || {};
      const msg = choice.message || {};
      fullText = extractText(msg.content) || '';
      fullThought = extractText(msg.reasoning_content) || '';
      if (fullThought) send('thought', { text: fullThought });
      if (fullText) send('delta', { text: fullText });
      if (!fullText) send('error', { message: '大模型未返回任何内容' });
      finish();
      return;
    }

    const decoder = new TextDecoder('utf-8');
    let buf = '';
    const onLine = (line) => {
      const s = line.trim();
      if (!s || s.startsWith(':')) return; // 空行 / SSE 注释（部分服务商用心跳）
      if (!s.startsWith('data:')) return; // 忽略 event: / id: 等字段
      const data = s.slice(5).trim();
      if (data === '[DONE]') return;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        return; // 上游偶发半包，跳过即可，不必打断整段输出
      }
      const delta = (json.choices && json.choices[0] && json.choices[0].delta) || {};
      // reasoning_content 是国产推理模型（如 qwen / deepseek 系列）的思考链字段
      const think = extractText(delta.reasoning_content);
      if (think) {
        fullThought += think;
        send('thought', { text: think });
      }
      const text = extractText(delta.content);
      if (text) {
        fullText += text;
        send('delta', { text });
      }
    };

    for await (const chunk of resp.body) {
      if (closed) break;
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) onLine(buf);
    finish();
  } catch (err) {
    if (err && err.name !== 'AbortError') send('error', { message: `大模型调用失败：${err.message}` });
    finish();
  } finally {
    if (!closed && !res.writableEnded) res.end();
  }
}

function makeSimpleSessionHandler(name, extra = {}) {
  return async function handler(req, res) {
    const body = await readJsonBody(req);
    const settings = getSettings();
    const sessionId = String(body.sessionId || '').trim();
    if (!sessionId) throw new HttpError(400, '缺少 sessionId');
    if (settings.mock) {
      await sleep(120);
      return sendJson(res, 200, { ok: true, mock: true, sessionId, ...extra });
    }
    // 会话属于哪个智能体必须问清楚：不同智能体可能用不同的 APP_KEY / 网关地址，
    // 拿错 key 去操作别人的会话，网关会直接报「会话不存在」。
    const agent = agentForBody(body, sessionId);
    const json = await gatewayJson(gatewayFor(settings, agent), name, { sessionId });
    if (name === 'deleteSession') sessionAgentMap.delete(sessionId);
    sendJson(res, 200, { ok: true, sessionId, raw: json });
  };
}

async function handleFeedback(req, res) {
  const body = await readJsonBody(req);
  const settings = getSettings();
  const { sessionId, requestId, taskId, vote, subject, comment, uniqueCode } = body;
  if (!sessionId) throw new HttpError(400, '缺少 sessionId');
  if (!requestId) throw new HttpError(400, '缺少 requestId（反馈必须由某次 run 产生）');
  if (!taskId) throw new HttpError(400, '缺少 taskId（取自 run 返回的 metadata.usage.taskId）');
  const payload = {
    sessionId,
    requestId,
    taskId,
    subject: subject || 'REQUEST',
    provider: { source: 'USER', extendInfo: {} },
    extendInfo: {},
    vote: String(vote || '').toUpperCase() === 'DISLIKE' ? 'DISLIKE' : 'LIKE',
    extCommentsInfo: { comment: comment || '' },
  };
  if (uniqueCode) payload.uniqueCode = uniqueCode;
  if (settings.mock) {
    await sleep(150);
    return sendJson(res, 200, { ok: true, mock: true, data: payload });
  }
  const json = await gatewayJson(gatewayFor(settings, agentForBody(body, sessionId)), 'feedback', payload);
  sendJson(res, 200, { ok: true, raw: json });
}

async function handleTaskFinishNotice(req, res) {
  const body = await readJsonBody(req);
  const settings = getSettings();
  const { taskId, success, data, errorCode, errorMsg } = body;
  if (!taskId) throw new HttpError(400, '缺少 taskId');
  // data 必须是 JSON 字符串
  let dataStr;
  if (typeof data === 'string') dataStr = data;
  else dataStr = JSON.stringify(data === undefined ? {} : data);
  try {
    JSON.parse(dataStr);
  } catch {
    throw new HttpError(400, 'data 必须是合法 JSON 字符串');
  }
  const payload = { taskId, success: success !== false, data: dataStr };
  if (errorCode) payload.errorCode = errorCode;
  if (errorMsg) payload.errorMsg = errorMsg;
  if (settings.mock) {
    await sleep(120);
    return sendJson(res, 200, { ok: true, mock: true, taskId });
  }
  const json = await gatewayJson(gatewayFor(settings, agentForBody(body, body.sessionId)), 'taskFinishNotice', payload);
  sendJson(res, 200, { ok: true, raw: json });
}

// ---------------------------------------------------------------------------
// 会话历史落盘
// ---------------------------------------------------------------------------
const safeId = (id) => String(id).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);

async function handleHistoryList(res) {
  await fsp.mkdir(HISTORY_DIR, { recursive: true });
  const files = await fsp.readdir(HISTORY_DIR);
  const items = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(await fsp.readFile(path.join(HISTORY_DIR, f), 'utf8'));
      items.push({
        id: j.id,
        title: j.title || '(未命名)',
        agentId: j.agentId,
        sessionId: j.sessionId,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        messageCount: Array.isArray(j.messages) ? j.messages.length : 0,
      });
    } catch {
      /* 跳过坏文件 */
    }
  }
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  sendJson(res, 200, { ok: true, items });
}

async function handleHistorySave(req, res) {
  const conv = await readJsonBody(req);
  if (!conv || !conv.id) throw new HttpError(400, '缺少会话 id');
  await fsp.mkdir(HISTORY_DIR, { recursive: true });
  const file = path.join(HISTORY_DIR, `${safeId(conv.id)}.json`);
  await fsp.writeFile(file, JSON.stringify(conv, null, 2), 'utf8');
  sendJson(res, 200, { ok: true, id: conv.id });
}

async function handleHistoryGet(res, id) {
  const file = path.join(HISTORY_DIR, `${safeId(id)}.json`);
  try {
    const j = JSON.parse(await fsp.readFile(file, 'utf8'));
    sendJson(res, 200, { ok: true, conversation: j });
  } catch {
    throw new HttpError(404, '会话不存在');
  }
}

async function handleHistoryDelete(res, id) {
  const file = path.join(HISTORY_DIR, `${safeId(id)}.json`);
  try {
    await fsp.unlink(file);
  } catch {
    /* 不存在也算成功 */
  }
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// 静态资源
// ---------------------------------------------------------------------------
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { ok: false, error: '非法路径' });
    return;
  }
  try {
    const st = await fsp.stat(target);
    if (st.isDirectory()) return serveStatic(req, res, path.join(rel, 'index.html'));
    const ext = path.extname(target).toLowerCase();

    // HTML 之外的静态资源（js/css）必须走「协商缓存」而不是强缓存：
    //   原先发 public, max-age=300，而 index.html 里引用的是不带版本号的裸路径
    //   （/js/app.js），于是改完代码后浏览器最长 5 分钟仍拿旧文件 ——
    //   表现为「明明修好了，用户刷新还是老问题」。
    //   改成 no-cache + ETag：没变就 304（省流量），一变立刻生效。
    if (ext === '.html') {
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'text/html',
        'Content-Length': st.size,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(target).pipe(res);
      return;
    }

    const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim() === etag)) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      ETag: etag,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(target).pipe(res);
  } catch {
    // SPA 兜底
    try {
      const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(html);
    } catch {
      sendJson(res, 404, { ok: false, error: 'Not Found' });
    }
  }
}

// ---------------------------------------------------------------------------
// 安全响应头：允许被 iframe 嵌入 + 收敛跨域
// ---------------------------------------------------------------------------
/**
 * 说明：
 *   - 本服务默认允许被 iframe 嵌入（否则宿主页面会白屏）。
 *     生产环境请用 config/settings.json 的 embed.allowOrigins 把宿主站点列白名单。
 *   - CORS 不再回显任意 Origin：默认只允许同源。
 *     否则任意第三方网页都能跨域直连 /api/session/run，白烧 APP_KEY 的调用额度。
 *     iframe 场景下子页与宿主同源或直接访问本服务，本来就不需要 CORS。
 */
function applySecurityHeaders(res, settings, reqOrigin) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  const embed = settings.embed;
  if (!embed.enabled) {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  } else if (embed.allowAllOrigins) {
    res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  } else if (embed.allowOrigins.length) {
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${embed.allowOrigins.join(' ')}`);
  } else {
    // 白名单为空 = 不限制嵌入来源（开发/内网默认），不写 header 让浏览器放行
    res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  }

  // 同源请求不需要 CORS 头（浏览器自动放行），这里只处理显式配置的跨域来源
  if (!reqOrigin) return;
  if (embed.corsOrigins.includes(reqOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Callback-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const method = (req.method || 'GET').toUpperCase();

  applySecurityHeaders(res, getSettings(), req.headers.origin);
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (!pathname.startsWith('/api/')) return await serveStatic(req, res, pathname);

    const route = `${method} ${pathname}`;
    switch (route) {
      case 'GET /api/health':
        return sendJson(res, 200, { ok: true, ts: Date.now() });
      case 'GET /api/config':
        return await handleConfig(res);
      case 'POST /api/session/create':
        return await handleCreateSession(req, res);
      case 'POST /api/session/run':
        return await handleRun(req, res);
      // 大模型走独立路由：它不是网关智能体，而是配置里的 OpenAI 兼容端点
      case 'POST /api/model/chat':
        return await handleModelChat(req, res);
      case 'POST /api/session/clear':
        return await makeSimpleSessionHandler('clearSession')(req, res);
      case 'POST /api/session/delete':
        return await makeSimpleSessionHandler('deleteSession')(req, res);
      case 'POST /api/feedback':
        return await handleFeedback(req, res);
      case 'POST /api/tool/taskFinishNotice':
      case 'POST /api/tool/callback':
      case 'POST /api/taskFinishNotice': {
        const settings = getSettings();
        const token = settings.tool && settings.tool.callbackToken;
        if (token) {
          const got = req.headers['x-callback-token'] || url.searchParams.get('token');
          if (got !== token) throw new HttpError(401, '回调 token 不合法');
        }
        return await handleTaskFinishNotice(req, res);
      }
      case 'GET /api/history':
        return await handleHistoryList(res);
      case 'POST /api/history':
        return await handleHistorySave(req, res);
      case 'DELETE /api/history':
        return await handleHistoryDelete(res, url.searchParams.get('id'));
      default:
        break;
    }
    if (method === 'GET' && pathname.startsWith('/api/history/')) {
      return await handleHistoryGet(res, pathname.slice('/api/history/'.length));
    }
    throw new HttpError(404, `未定义的接口：${route}`);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[error]', req.method, pathname, err.message);
    if (!res.headersSent) {
      sendJson(res, status, { ok: false, error: err.message || '服务端异常', detail: err.detail || null });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

const boot = getSettings();
server.listen(boot.port, boot.host, () => {
  const base = `http://${boot.host === '0.0.0.0' ? 'localhost' : boot.host}:${boot.port}`;
  console.log('');
  console.log('  阿里百炼 · 智能体对话服务已启动');
  console.log('  ------------------------------------------------');
  console.log(`  本地访问   ${base}/`);
  console.log(`  带参调用   ${base}/?agent=<智能体id>&q=你好&user=张三`);
  console.log(`  嵌入模式   ${base}/?embed=1&agent=<智能体id>`);
  console.log(`  宿主示例   ${base}/embed-demo.html`);
  console.log(`  模式       ${boot.mock ? 'MOCK（未连真实网关）' : 'REAL（已连网关）'}`);
  if (!boot.embed.enabled) {
    console.log('  嵌入       【已禁止】frame-ancestors \'self\'');
  } else if (boot.embed.allowOrigins.length) {
    console.log(`  嵌入白名单 ${boot.embed.allowOrigins.join(', ')}`);
  } else {
    console.log('  嵌入       【不限来源】生产环境建议配置 embed.allowOrigins 白名单');
  }
  if (!boot.mock) {
    console.log(`  网关地址   ${boot.gateway.baseUrl || '【未配置】'}`);
    console.log(`  全局 APP_KEY ${maskKey(boot.gateway.apiKey)}${process.env.AGENT_APP_KEY ? '（来自环境变量 AGENT_APP_KEY，会压过所有智能体自己的 key）' : ''}`);
    // 逐个智能体交代「这次调用到底用哪个 key」—— 密钥按智能体配置后，最容易踩的坑就是
    // 「我改了 agents.json，怎么还是用全局那个 key」，所以启动时直接说清楚来源。
    const { agents, secrets } = readAgentsConfig();
    if (agents.length) {
      console.log('  各智能体凭证：');
      for (const a of agents) {
        const s = secrets.get(a.id) || {};
        const from = process.env.AGENT_APP_KEY
          ? '环境变量 key（覆盖）'
          : s.apiKey
            ? `独立 key ${maskKey(s.apiKey)}`
            : boot.gateway.apiKey
              ? `沿用全局 key ${maskKey(boot.gateway.apiKey)}`
              : '⚠️ 无可用 key';
        const base = process.env.AGENT_BASE_URL
          ? '环境变量地址'
          : s.baseUrl
            ? `独立地址 ${s.baseUrl}`
            : '全局地址';
        console.log(`    · ${a.name}：${from} ／ ${base}`);
      }
    }
    // 大模型（config/models.json）的凭证来源也逐个交代 —— 与智能体同理，
    // 「改了 models.json 怎么没生效」十有八九是环境变量盖住了，或者 baseUrl 写到了 /v1 以外
    const { models, secrets: modelSecrets } = readModelsConfig();
    if (models.length) {
      console.log('  各大模型凭证：');
      for (const m of models) {
        const s = modelSecrets.get(m.id) || {};
        const key = s.apiKey ? `key ${maskKey(s.apiKey)}` : '⚠️ 无 key';
        const base = s.baseUrl ? s.baseUrl : '⚠️ 无 baseUrl';
        const sys = s.system ? '／带 system 提示词' : '';
        console.log(`    · ${m.name}（${m.model || '未填 model'}）：${key} ／ ${base}${sys}`);
        const warn = anthropicBaseUrlWarning(m, s.baseUrl || '');
        if (warn) console.log(warn);
      }
    } else {
      console.log('  各大模型凭证：（config/models.json 未配置模型，侧栏「大模型」分组会自动隐藏）');
    }
  }
  console.log('');
});

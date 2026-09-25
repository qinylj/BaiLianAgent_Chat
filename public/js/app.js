/**
 * 主应用：会话管理 / 智能体切换 / 链接传参 / 背景 / 流式渲染
 */
import { BACKGROUNDS, getBackground } from './backgrounds.js';
import { agentIconSvg } from './agent-icons.js';
import { renderMarkdown, escapeHtml } from './markdown.js';
import { createBridge, detectEmbed } from './embed.js';
import * as ui from './ui.js';
import * as api from './api.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);

/**
 * 智能体图标的统一出口。
 * 智能体没有 icon（老配置 / 兜底）时 agentIconSvg 会返回默认图标，所以这里不用再判空。
 * agent 可能为 null（会话找不到对应智能体、清空会话时的空态），故仍要防一手。
 */
const agentIconOf = (agent) => agentIconSvg(agent && agent.icon ? agent.icon : '');
/** 头像容器的品牌色：色底与描边都从 --a 用 color-mix 派生，改配置里的 accent 即整块换色 */
const accentOf = (agent) => (agent && agent.accent ? agent.accent : '#4f8cff');
const avatarBlock = (agent, cls = 'avatar', extra = '') =>
  `<div class="${cls}" style="--a:${escapeHtml(accentOf(agent))}">${agentIconOf(agent)}${extra}</div>`;

/** 服务端配置还没拉回来时用的兜底外观，需与 config/settings.json 的 ui.* 保持一致 */
const FALLBACK_THEME = 'cockpit';
const FALLBACK_BG = 'cockpit';

const el = {
  bgLayer: $('bgLayer'),
  bgVeil: $('bgVeil'),
  sidebar: $('sidebar'),
  modelList: $('modelList'),
  modelCount: $('modelCount'),
  agentList: $('agentList'),
  agentCount: $('agentCount'),
  convList: $('convList'),
  btnNewConv: $('btnNewConv'),
  brandTitle: $('brandTitle'),
  brandSub: $('brandSub'),
  agentBadge: $('agentBadge'),
  curAgentName: $('curAgentName'),
  curSessionId: $('curSessionId'),
  connState: $('connState'),
  btnStop: $('btnStop'),
  btnExport: $('btnExport'),
  messages: $('messages'),
  input: $('input'),
  btnSend: $('btnSend'),
  btnAttach: $('btnAttach'),
  attachBar: $('attachBar'),
  paramsBar: $('paramsBar'),
  tipText: $('tipText'),
  tokenHint: $('tokenHint'),
  btnToggleSidebar: $('btnToggleSidebar'),
  // drawer
  drawer: $('drawer'),
  drawerMask: $('drawerMask'),
  btnCloseDrawer: $('btnCloseDrawer'),
  // 品牌区右侧的 ⚙ 是打开抽屉的唯一入口（侧栏底部那排按钮已删除），
  // 背景 / 链接参数 / 设置三块内容由抽屉顶部的 .tab 切换
  btnOpenSettings: $('btnOpenSettings'),
  bgGrid: $('bgGrid'),
  btnPickBg: $('btnPickBg'),
  btnClearBg: $('btnClearBg'),
  bgFile: $('bgFile'),
  veilRange: $('veilRange'),
  veilVal: $('veilVal'),
  blurRange: $('blurRange'),
  blurVal: $('blurVal'),
  themeSeg: $('themeSeg'),
  paramList: $('paramList'),
  kvKey: $('kvKey'),
  kvVal: $('kvVal'),
  btnAddKv: $('btnAddKv'),
  shareLink: $('shareLink'),
  btnCopyLink: $('btnCopyLink'),
  btnApplyLink: $('btnApplyLink'),
  promptPreview: $('promptPreview'),
  setMode: $('setMode'),
  setBase: $('setBase'),
  setKey: $('setKey'),
  optStream: $('optStream'),
  optDelta: $('optDelta'),
  optTrace: $('optTrace'),
  optServerHistory: $('optServerHistory'),
  btnImport: $('btnImport'),
  btnClearAll: $('btnClearAll'),
  importFile: $('importFile'),
  callbackUrl: $('callbackUrl'),
  toast: $('toast'),
};

const state = {
  config: null,
  agents: [],
  /** 大模型列表（config/models.json 的公开字段，不含密钥） */
  models: [],
  settings: store.loadSettings(),
  conv: null,
  busy: false,
  abort: null,
  linkParams: {},
  autoSendText: '',
  live: null, // 流式过程中缓存的 DOM 引用
};

/* ==========================================================================
   通用工具
   ========================================================================== */
let toastTimer = null;
function toast(msg, isErr = false) {
  el.toast.textContent = msg;
  el.toast.className = `toast${isErr ? ' err' : ''}`;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 2600);
}

/* ---------------------------------------------------------------------------
   剪贴板：为什么必须三级降级
   ---------------------------------------------------------------------------
   navigator.clipboard.writeText 看着是个普通 API，实际有三道硬门槛，任一不满足就抛错，
   而调用点原来只有 try/catch + 一句「复制失败」，用户根本不知道卡在哪：

     ① 安全上下文：只有 https:// 或 localhost / 127.0.0.1 才存在 navigator.clipboard。
        用 http://192.168.x.x:端口 打开时它整个是 undefined，取 .writeText 直接 TypeError。
     ② 文档聚焦：抛 NotAllowedError: Document is not focused。
        切走窗口、自动化环境、或在宿主页里点（焦点不在 iframe 内）都会撞上。
     ③ 权限策略：被**跨域 iframe** 嵌入时 clipboard-write 默认只授给 self，
        宿主 iframe 没写 allow="clipboard-write" 就被拒（同样是 NotAllowedError）。

   所以这里「能用哪个用哪个」逐级降级，最后兜底到手动复制弹层，
   保证任何承载方式下点「复制」都不会静默失效。
--------------------------------------------------------------------------- */

/**
 * 把文本写进剪贴板，返回 { ok, how }，how ∈ 'clipboard' | 'execCommand' | 'none'
 * @param {string} text
 */
async function copyText(text) {
  const s = String(text ?? '');

  // ① 标准 Clipboard API（最优：不碰 DOM、不抢焦点）
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(s);
      return { ok: true, how: 'clipboard' };
    } catch {
      /* 失焦 / 被权限策略拒绝，继续往下试 */
    }
  }

  // ② execCommand 兜底：不看安全上下文、不受 clipboard-write 策略限制，
  //    只要仍在一次用户手势内就能成功 —— http 访问和跨域 iframe 主要靠它救。
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    try {
      ta.select();
      ta.setSelectionRange(0, s.length);
      if (document.execCommand('copy')) return { ok: true, how: 'execCommand' };
    } finally {
      ta.remove();
    }
  } catch {
    /* 落到 ③ */
  }

  return { ok: false, how: 'none' };
}

/**
 * 复制并给出反馈。自动复制彻底失败时，退到「已全选、按 Ctrl+C」的手动弹层，
 * 而不是只丢一句「复制失败」让人干瞪眼。
 */
async function copyWithFeedback(text, okMsg = '已复制') {
  const s = String(text ?? '');
  if (!s.trim()) return toast('没有可复制的内容', true);

  const r = await copyText(s);
  if (r.ok) return toast(okMsg);

  await ui.form({
    title: '请手动复制',
    message: '浏览器拒绝了自动写入剪贴板（常见于 http 访问或跨域 iframe 嵌入）。下方内容已选中，按 Ctrl+C 复制。',
    okText: '完成',
    cancelText: '关闭',
    fields: [{ key: 'text', label: '内容', value: s, multiline: true }],
  });
}

const fmtTime = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const shortId = (id) => (id ? `${String(id).slice(0, 8)}…${String(id).slice(-4)}` : '—');

/* ==========================================================================
   归属对象：智能体 or 大模型
   ==========================================================================
   侧栏有两个平行的可选分组（大模型 / 智能体），二者互斥：
   `settings.targetKind` 记住当前选的是哪一类，`settings.agentId` / `settings.modelId`
   分别记住各自选中的 id —— 来回切换时能直接落回原来那个，不用重新找。

   会话用 `conv.kind` 标记归属（缺省 'agent'，老数据照旧）：
   发消息走哪条链路、历史里显示谁的名字、要不要显示点赞按钮，**一律以会话自己的 kind 为准**，
   而不是当前侧栏选中的 kind —— 否则打开一条旧会话、侧栏还没切过来时，就会拿错对象去发。
   ========================================================================== */
const currentAgent = () =>
  state.agents.find((a) => a.id === state.settings.agentId) || state.agents[0] || null;

const currentModel = () =>
  state.models.find((m) => m.id === state.settings.modelId) || state.models[0] || null;

/** 会话的归属类型。老数据没有 kind 字段，一律当智能体处理 */
const convKind = (conv) => (conv && conv.kind === 'model' ? 'model' : 'agent');

/** 按类型 + id 找对象（可能是智能体，也可能是大模型） */
function targetOf(kind, id) {
  const pool = kind === 'model' ? state.models : state.agents;
  return pool.find((x) => x.id === id) || null;
}

/** 当前侧栏选中的对象（智能体或大模型，由 targetKind 决定） */
const currentTarget = () =>
  state.settings.targetKind === 'model' ? currentModel() : currentAgent();

/**
 * 当前**会话**的归属对象 —— 渲染头像、配色、欢迎语都用它。
 * 会话的 kind 才是事实来源；会话对象找不到时（被删了）退回侧栏选中项，
 * 保证头像与品牌色任何时候都有值、不会渲染出空白。
 */
function currentOwner() {
  const conv = state.conv;
  return (conv && targetOf(convKind(conv), conv.agentId)) || currentTarget();
}

/**
 * 会话所属的对象是否已不在配置里。
 *
 * 把某个智能体从 agents.json（或某个模型从 models.json）删掉后，它名下的旧会话就成了孤儿：
 * `openConversation()` 会把那个失效 id 写进设置，而 currentAgent() / currentModel() 找不到就
 * **静默回退到列表第一个** —— 结果是顶栏显示 A、对话却属于 B，
 * 在里面发消息会真的发给 A，用户完全察觉不到。所以发送前必须显式拦住。
 */
function convTargetGone(conv) {
  if (!conv || !conv.agentId) return false;
  return !targetOf(convKind(conv), conv.agentId);
}

const GONE_TARGET_MSG = (conv) =>
  `该对话所属的${convKind(conv) === 'model' ? '大模型' : '智能体'}「${conv.agentId}」已不在配置中，` +
  '为避免发错对象已阻止发送。请点左上角「＋ 新建」开始新对话。';


/* ==========================================================================
   链接参数
   ========================================================================== */
const RESERVED = new Set([
  'agent', 'agentid', 'code', 'agentcode',
  // 大模型的对应参数：?model=<id|模型名|展示名>。注意它同时是「强制显示大模型分组」的开关，
  // 所以绝不能落进业务参数里被透传给服务端（见 applyRegions）
  'model', 'modelid', 'modelname',
  'q', 'prompt', 'query', 'message', 'text', 'question',
  'bg', 'background', 'theme', 'title', 'sys', 'pre', 'suffix',
  'autosend', 'new', 'send', 'veil', 'blur', 'opacity',
  // iframe 嵌入用的结构性参数，绝不能当成业务参数透传给智能体
  'embed', 'parent', 'sidebar',
]);

function parseLinkParams() {
  const sp = new URLSearchParams(location.search);
  const out = { reserved: {}, params: {} };
  sp.forEach((value, rawKey) => {
    const key = rawKey.trim();
    if (RESERVED.has(key.toLowerCase())) {
      out.reserved[key.toLowerCase()] = value;
    } else if (/^meta[._]/i.test(key)) {
      out.params[key.replace(/^meta[._]/i, '')] = value;
    } else {
      out.params[key] = value;
    }
  });
  return out;
}

function renderTemplate(tpl, ctx) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (ctx[k] !== undefined && ctx[k] !== '' ? String(ctx[k]) : ''));
}

/** 把链接参数拼装成真正发给智能体的 prompt */
function buildPrompt(agent, question, params) {
  const merged = { ...(agent.defaultParams || {}), ...params };
  const ctx = { ...merged, question, q: question, prompt: question, text: question };
  if (agent.urlTemplate) {
    const rendered = renderTemplate(agent.urlTemplate, ctx);
    // 模板没覆盖到的参数继续追加，避免丢参
    const used = new Set([...Object.keys(ctx), 'question']);
    const rest = Object.entries(merged).filter(([k]) => !used.has(k));
    return rest.length
      ? `${rendered}\n${rest.map(([k, v]) => `${k}: ${v}`).join('\n')}`
      : rendered;
  }
  const entries = Object.entries(merged);
  if (!entries.length) return question;
  return `${question}\n\n【链接传入参数】\n${entries.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
}

function buildMetadata(agent, params) {
  return {
    ...(agent.defaultParams || {}),
    ...params,
    _source: location.origin || 'local',
    _url: (state.linkQuery && state.linkQuery.raw) || location.href,
    _agent: agent.id,
    _ts: new Date().toISOString(),
  };
}

function buildShareLink() {
  const sp = new URLSearchParams();
  // 按**当前归属对象**生成：大模型会话带 ?model=，智能体会话带 ?agent=。
  // 注意 ?model= / ?agent= 在对方页面同样有「强制显示该分组」的副作用，这正是分享时想要的。
  const kind = state.conv ? convKind(state.conv) : state.settings.targetKind;
  const owner = (state.conv && targetOf(kind, state.conv.agentId)) || currentTarget();
  if (owner) sp.set(kind === 'model' ? 'model' : 'agent', owner.id);
  const lq = state.linkQuery || {};
  if (lq.q) sp.set('q', lq.q);
  if (lq.sys) sp.set('sys', lq.sys);
  if (lq.suffix) sp.set('suffix', lq.suffix);
  if (lq.autosend === false) sp.set('autosend', '0');
  if (state.conv && state.conv.title) sp.set('title', state.conv.title);
  for (const [k, v] of Object.entries(state.settings.params || {})) sp.set(k, v);
  return `${location.origin}${location.pathname}?${sp.toString()}`;
}

/* ==========================================================================
   背景 / 主题
   ========================================================================== */
/** 读服务端 ui.* 默认值（config/settings.json），拉不到就用本地兜底 */
function serverDefault(key, fallback) {
  const uiCfg = (state.config && state.config.ui) || {};
  return uiCfg[key] || fallback;
}
/**
 * 生效主题：用户显式选过就用用户的，否则跟随服务端配置。
 * 不用 settings.theme 直接判定，是因为空串代表「跟随服务端」。
 */
function resolvedTheme() {
  const s = state.settings;
  if (s.themeExplicit && s.theme) return s.theme;
  const def = serverDefault('defaultTheme', FALLBACK_THEME);
  return store.THEMES.includes(def) ? def : FALLBACK_THEME;
}
/** 生效背景：同上，链接/用户选过优先 */
function resolvedBgId() {
  return state.settings.bgId || serverDefault('defaultBackground', FALLBACK_BG);
}

function applyVisual() {
  const s = state.settings;
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  const layer = el.bgLayer;
  // 预设字符串是按 background 简写写的（含「位置 / 尺寸」和末尾底色）。
  // 千万别赋给 background-image —— 浏览器会因语法非法把整条声明丢掉，
  // 表现为「换了背景没反应」（曾导致网格/圆点/纸纹/光斑/纯色 5 套预设全部失效）。
  if (s.bgCustom) {
    layer.style.background = `url("${s.bgCustom}") center / cover no-repeat`;
  } else {
    const bg = getBackground(resolvedBgId());
    layer.style.background = bg && bg.css !== 'none' ? bg.css : 'none';
  }
  document.documentElement.style.setProperty('--veil', String((s.veil ?? 45) / 100));
  document.documentElement.style.setProperty('--blur', `${s.blur ?? 0}px`);

  el.veilRange.value = s.veil ?? 45;
  el.veilVal.textContent = `${s.veil ?? 45}%`;
  el.blurRange.value = s.blur ?? 0;
  el.blurVal.textContent = `${s.blur ?? 0}px`;
  [...el.themeSeg.children].forEach((b) => b.classList.toggle('active', b.dataset.theme === theme));

  // 背景选中态
  [...el.bgGrid.children].forEach((c) =>
    c.classList.toggle('active', !s.bgCustom && c.dataset.id === resolvedBgId())
  );

  // 顶栏强调色跟随**当前归属对象**（智能体或大模型，两者都有自己的 accent）
  const owner = currentOwner();
  if (owner) el.agentBadge.style.setProperty('--accent', owner.accent);
}

function renderBgGrid() {
  el.bgGrid.innerHTML = '';
  for (const bg of BACKGROUNDS) {
    const d = document.createElement('div');
    d.className = 'bg-cell';
    d.dataset.id = bg.id;
    d.title = bg.name;
    // 同上：预设有「位置 / 尺寸」和底色，只能走 background 简写
    d.style.background = bg.css === 'none' ? 'var(--bg)' : bg.css;
    d.innerHTML = `<span>${escapeHtml(bg.name)}</span>`;
    d.addEventListener('click', () => {
      state.settings = store.saveSettings({ bgId: bg.id, bgCustom: '', bgName: '' });
      applyVisual();
    });
    el.bgGrid.appendChild(d);
  }
}

function setCustomBackground(dataUrl, name) {
  const next = store.saveSettings({ bgCustom: dataUrl, bgName: name || '自定义图片' });
  state.settings = next;
  if (!next.bgCustom && dataUrl) toast('图片过大，未能保存到本地', true);
  else toast(`背景已切换：${name || '自定义图片'}`);
  applyVisual();
}

function readImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return toast('请选择图片文件', true);
  if (file.size > 4 * 1024 * 1024) return toast('图片不能超过 4MB', true);
  const fr = new FileReader();
  fr.onload = () => setCustomBackground(String(fr.result), file.name);
  fr.readAsDataURL(file);
}

/* ==========================================================================
   侧栏渲染（两个平行分组：大模型 / 智能体）
   ========================================================================== */
/**
 * 渲染一个可选项（智能体或大模型）。两者外观完全一致 —— 都是「图标 + 名称 + 描述」，
 * 所以共用这份构造逻辑，差异只有三处：语义类名、active 判定、点击后的动作。
 *
 * 类名约定：
 *   .pick-item            —— 外观样式全挂在它上面（CSS 里所有条目样式都写 .pick-item）
 *   .agent-item/.model-item —— 只作语义标记与差异化钩子，不承载样式
 * 这样以后再加第三类可选项（比如「知识库」）时，样式零改动。
 */
function renderPickItem(target, { kind, active, onClick }) {
  const d = document.createElement('div');
  d.className = `pick-item ${kind}-item${active ? ' active' : ''}`;
  // dataset 锚点与 .conv-item 对齐：给测试/外部脚本一个稳定的定位方式（对应 [data-agent] / [data-model]）。
  // 别再按 :nth-child(N) 定位业务项 —— 增删一个条目就会整体错位（踩过一次）。
  d.dataset[kind] = target.id;
  // 状态（如「建设中」）刻意不写进 name 里：名称那一行是 ellipsis 单行，塞进名字会直接吃掉
  // 可用宽度（实测「水污染事件辅助溯源（建设中）」需 182px，最窄的侧栏只有 173px，必被截断）。
  // 抽成独立标签后名字只占 117px，且以后别的条目要标状态可以直接复用。
  const statusTag = target.status ? `<i class="tag">${escapeHtml(target.status)}</i>` : '';
  // 副标题：智能体用它的描述（兜底 agentCode），大模型优先描述（兜底服务商侧的模型名）
  const sub = target.description || target.model || target.agentCode || '';
  d.innerHTML = `${avatarBlock(target)}<div class="txt"><div class="nm-row"><strong>${escapeHtml(target.name)}</strong>${statusTag}</div><span>${escapeHtml(sub)}</span></div>`;
  d.addEventListener('click', onClick);
  return d;
}

function renderModels() {
  el.modelList.innerHTML = '';
  el.modelCount.textContent = String(state.models.length);
  for (const m of state.models) {
    el.modelList.appendChild(
      renderPickItem(m, {
        kind: 'model',
        active: state.settings.targetKind === 'model' && m.id === state.settings.modelId,
        onClick: () => switchModel(m.id),
      })
    );
  }
}

function renderAgents() {
  el.agentList.innerHTML = '';
  el.agentCount.textContent = String(state.agents.length);
  for (const a of state.agents) {
    el.agentList.appendChild(
      renderPickItem(a, {
        kind: 'agent',
        active: state.settings.targetKind === 'agent' && a.id === state.settings.agentId,
        onClick: () => switchAgent(a.id),
      })
    );
  }
}

/** 两个可选项分组一起重画（选中态是互斥的，只画一个会出现「两边都高亮」） */
function renderTargets() {
  renderModels();
  renderAgents();
}

function renderConvList() {
  const items = store.listConversations();
  el.convList.innerHTML = '';
  if (!items.length) {
    el.convList.innerHTML = '<p class="hint" style="padding:8px 10px">暂无历史对话</p>';
    return;
  }
  for (const c of items) {
    // 历史对话**共用**一个列表：智能体会话与大模型会话混排，靠第二行的来源名区分。
    // 归属对象按会话自己的 kind 找 —— 模型会话的 agentId 存的是 models.json 的 id。
    const kind = convKind(c);
    const owner = targetOf(kind, c.agentId);
    const d = document.createElement('div');
    d.className = `conv-item${state.conv && c.id === state.conv.id ? ' active' : ''}`;
    d.dataset.id = c.id;
    // data-agent 保持原样（老脚本/测试的锚点），另加 data-kind 供区分两种来源
    d.dataset.agent = c.agentId || '';
    d.dataset.kind = kind;
    const ownerName = owner ? owner.name : kind === 'model' ? '未知大模型' : '未知智能体';
    d.innerHTML = `<div class="t">${escapeHtml(c.title || '新对话')}</div>
      <div class="s"><span title="${kind === 'model' ? '大模型' : '智能体'}">${escapeHtml(ownerName)}</span><span>· ${c.messages.length} 条 · ${fmtTime(c.updatedAt)}</span></div>
      <button class="del" title="删除对话" aria-label="删除对话">🗑</button>`;
    d.addEventListener('click', (e) => {
      if (e.target.closest('.del')) return;
      openConversation(c.id);
    });
    d.querySelector('.del').addEventListener('click', (e) => {
      e.stopPropagation();
      openDeleteConfirm(c);
    });
    el.convList.appendChild(d);
  }
}

/** 删除确认弹层（不用 window.confirm：它在 sandbox iframe 里会被浏览器静默忽略） */
async function openDeleteConfirm(conv) {
  const ok = await ui.confirm({
    title: '删除对话',
    message: `「${conv.title || '新对话'}」将被删除，本地记录与服务端会话数据都会一并清除，且无法恢复。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  await removeConversation(conv.id);
}

/**
 * 删除一个会话。
 * 关键点：删掉「当前会话」时要切到剩下的会话，而不是无脑新建一个同名空对话——
 * 后者会让用户看到列表里又冒出一条一模一样的「新对话」，误以为删除没生效。
 */
async function removeConversation(id) {
  const conv = store.getConversation(id);
  if (!conv) return;
  const isCurrent = !!state.conv && state.conv.id === id;
  const others = store.listConversations().filter((c) => c.id !== id);

  // 正在生成时先终止，避免流式回调继续往已删除的会话里写数据
  if (isCurrent && state.busy) await stopGeneration().catch(() => {});

  store.deleteConversation(id);

  if (isCurrent) {
    if (others.length) openConversation(others[0].id);
    else newConversationForCurrent({ silent: true });
  } else {
    renderConvList();
    renderBadge();
  }

  if (conv.sessionId) await api.deleteSession(conv.sessionId, conv.agentId).catch(() => {});
  await api.historyRemove(id).catch(() => {});

  toast(others.length || !isCurrent ? '对话已删除' : '对话已删除，已新建空白对话');
}

/**
 * 顶栏徽章：显示**当前会话的归属对象**（智能体或大模型），而不是侧栏选中的那个。
 * 两者可能短暂不一致（打开一条属于别的对象的旧会话、侧栏还没切过来），
 * 这时以会话为准才不会指鹿为马。
 */
function renderBadge() {
  const kind = state.conv ? convKind(state.conv) : state.settings.targetKind;
  const target = (state.conv && targetOf(kind, state.conv.agentId)) || currentTarget();
  if (!target) return;
  el.curAgentName.textContent = target.name;
  if (kind === 'model') {
    // 大模型没有 sessionId（无状态接口，每轮带全量历史），第二行改为交代服务商侧的模型名
    el.curSessionId.textContent = target.model ? `大模型 · ${target.model}` : '大模型对话（无会话 ID）';
  } else {
    el.curSessionId.textContent = state.conv && state.conv.sessionId ? state.conv.sessionId : '未建立会话（首轮自动创建）';
  }
  const ava = el.agentBadge.querySelector('.avatar');
  if (ava) {
    ava.style.setProperty('--a', accentOf(target));
    ava.innerHTML = agentIconOf(target);
  }
}

/* ==========================================================================
   会话流程
   ========================================================================== */
/**
 * 新建会话。
 * @param {string} ownerId 归属对象 id：智能体 id，或 models.json 里的模型 id
 * @param {object} opts kind 归属类型，缺省取当前侧栏选中的类型
 */
function startNewConversation(ownerId, { title, silent, kind } = {}) {
  const k = kind || state.settings.targetKind || 'agent';
  // ownerId 省略时按**侧栏当前选中的对象**兜底，绝不能写死 state.settings.agentId：
  // 大模型模式下那样会造出一条 `kind:'model'` 但 agentId 是智能体 id 的会话 ——
  // 历史里显示成「未知大模型」，发消息还会被孤儿拦截挡下，而提示让用户去点「＋ 新建」，
  // 点了还是坏的（死循环）。kind 与 id 必须来自同一个来源。
  const id = ownerId || (currentTarget() || {}).id || (k === 'model' ? state.settings.modelId : state.settings.agentId);
  const conv = store.createConversation(id, { title: title || '新对话', kind: k });
  state.conv = conv;
  store.setActiveId(conv.id);
  renderConvList();
  renderBadge();
  renderMessages();
  refreshParamsUI();
  if (!silent && !EMBED.mode) el.input.focus();
  return conv;
}

/**
 * 按**侧栏当前选中的对象**新建会话（大模型或智能体都可能）。
 * 新建的三个入口（「＋ 新建」按钮 / 删掉最后一个会话 / 清空全部对话）统一走这里，
 * 免得哪一处漏了 kind 而写出归属错乱的会话（见 startNewConversation 的注释）。
 */
const newConversationForCurrent = ({ title, silent } = {}) =>
  startNewConversation(undefined, { title, silent, kind: state.settings.targetKind });

function openConversation(id) {
  const conv = store.getConversation(id);
  if (!conv) return;
  state.conv = conv;
  store.setActiveId(id);
  // 只在「该会话的归属对象仍然存在」时才跟进切换侧栏选中态。否则会把一个失效 id 持久化进设置，
  // 让 currentAgent() / currentModel() 静默回退到列表第一个（顶栏显示 A、对话却属于 B）。
  const kind = convKind(conv);
  if (conv.agentId && !convTargetGone(conv)) {
    const patch =
      kind === 'model'
        ? { targetKind: 'model', modelId: conv.agentId }
        : { targetKind: 'agent', agentId: conv.agentId };
    const changed =
      state.settings.targetKind !== patch.targetKind ||
      (kind === 'model' ? conv.agentId !== state.settings.modelId : conv.agentId !== state.settings.agentId);
    if (changed) {
      state.settings = store.saveSettings(patch);
      renderTargets();
    }
  }
  renderConvList();
  renderBadge();
  renderMessages();
  refreshParamsUI();
  applyVisual();
}

async function switchAgent(agentId) {
  if (state.busy) return toast('正在生成中，请先停止', true);
  state.settings = store.saveSettings({ agentId, targetKind: 'agent' });
  renderTargets();
  applyVisual();
  // 只找**同类型**的会话：智能体与大模型可能取到同一个 id 字符串，
  // 不按 kind 过滤就会把大模型的会话当成本智能体的打开（顶栏立刻指鹿为马）
  const mine = store.listConversations().filter((c) => convKind(c) === 'agent' && c.agentId === agentId);
  if (mine.length) openConversation(mine[0].id);
  else startNewConversation(agentId, { silent: true, kind: 'agent' });
  const agent = currentAgent();
  if (agent && agent.background) {
    state.settings = store.saveSettings({ bgId: agent.background, bgCustom: '' });
    applyVisual();
  }
}

/** 切到大模型：与 switchAgent 结构对称，只是模型配置里没有 background 字段，不套用背景 */
async function switchModel(modelId) {
  if (state.busy) return toast('正在生成中，请先停止', true);
  const model = state.models.find((m) => m.id === modelId);
  if (!model) return toast(`大模型「${modelId}」不在 config/models.json 中`, true);
  state.settings = store.saveSettings({ modelId, targetKind: 'model' });
  renderTargets();
  const mine = store.listConversations().filter((c) => convKind(c) === 'model' && c.agentId === modelId);
  if (mine.length) openConversation(mine[0].id);
  else startNewConversation(modelId, { silent: true, kind: 'model' });
  applyVisual();
}

/* ---------------- 消息渲染 ---------------- */
function renderMessages() {
  el.messages.innerHTML = '';
  const conv = state.conv;
  const owner = currentOwner();
  if (!conv) {
    // 兜底：会话被清空时给个明确出口，而不是留一片空白
    const empty = document.createElement('div');
    empty.className = 'welcome';
    empty.innerHTML = `
      ${avatarBlock(owner, 'big')}
      <h2>暂无对话</h2>
      <p>点击左上角「＋ 新建」开始一段新对话。</p>`;
    el.messages.appendChild(empty);
    return;
  }

  if (!conv.messages.length) {
    const w = document.createElement('div');
    w.className = 'welcome';
    w.innerHTML = `
      ${avatarBlock(owner, 'big')}
      <h2>${escapeHtml(owner ? owner.name : '就绪')}</h2>
      <p>${escapeHtml((owner && owner.welcome) || '开始你的第一个问题吧。')}</p>
      <div class="sugs"></div>`;
    const sugs = w.querySelector('.sugs');
    ((owner && owner.suggestions) || []).forEach((s) => {
      const b = document.createElement('button');
      b.className = 'sug';
      b.textContent = s;
      b.addEventListener('click', () => sendMessage(s));
      sugs.appendChild(b);
    });
    el.messages.appendChild(w);
    return;
  }

  conv.messages.forEach((m) => el.messages.appendChild(renderMessage(m)));
  scrollToBottom();
}

function renderMessage(m) {
  const owner = currentOwner();
  const wrap = document.createElement('div');
  wrap.className = `msg ${m.role}`;
  wrap.dataset.id = m.id;

  const ava = document.createElement('div');
  ava.className = 'ava';
  if (m.role === 'user') {
    /* 自己的头像：中性人形 SVG，**不设 --a**，于是颜色落回 CSS 里 .msg.user .ava 的中性文字色，
       不会跟当前智能体/大模型的品牌色抢注意力（图标本身用 currentColor 描边，给个 color 就够了）。 */
    ava.innerHTML = agentIconSvg('user');
  } else {
    ava.style.setProperty('--a', accentOf(owner));
    ava.innerHTML = agentIconOf(owner);
  }

  const body = document.createElement('div');
  body.className = 'body';

  // 思考过程
  if (m.thought) {
    const details = document.createElement('details');
    details.className = 'think';
    details.open = m.status === 'streaming';
    details.innerHTML = `<summary>思考过程</summary><pre>${escapeHtml(m.thought)}</pre>`;
    body.appendChild(details);
  }

  // 附件
  if (m.attachments && m.attachments.length) {
    const chips = document.createElement('div');
    chips.className = 'attach-chips';
    m.attachments.forEach((a) => {
      const c = document.createElement('span');
      c.className = 'chip';
      c.innerHTML = `📎 <span>${escapeHtml(a.name || a.url)}</span>`;
      chips.appendChild(c);
    });
    body.appendChild(chips);
  }

  const bubble = document.createElement('div');
  bubble.className = `bubble${m.status === 'error' ? ' err' : ''}`;
  bubble.innerHTML = renderMarkdown(m.text || (m.status === 'streaming' ? '' : '（无内容）'));
  if (m.status === 'streaming') bubble.insertAdjacentHTML('beforeend', '<span class="cursor"></span>');
  body.appendChild(bubble);

  // 图片
  if (m.images && m.images.length) {
    m.images.forEach((img) => {
      const i = document.createElement('img');
      i.src = img.url;
      i.alt = img.name || '生成图片';
      bubble.appendChild(i);
    });
  }

  // 工具条
  const tools = document.createElement('div');
  tools.className = 'msg-tools';
  const addTool = (label, title, handler) => {
    const b = document.createElement('button');
    b.className = 'tool-btn';
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', handler);
    tools.appendChild(b);
    return b;
  };
  addTool('复制', '复制内容', () => copyWithFeedback(m.text));
  if (m.role === 'assistant') {
    if (m.thought) addTool('思考', '展开/收起思考过程', () => toast('思考内容已在气泡上方'));
    // 点赞点踩走的是网关的 /feedback（必须带 requestId + taskId），
    // 大模型链路没有这两个东西，渲染出来只会一点就报错，所以模型会话不显示这对按钮。
    if (convKind(state.conv) === 'agent') {
      const like = addTool('👍', '点赞（调用 /feedback）', () => vote(m, 'LIKE', like, dislike));
      const dislike = addTool('👎', '点踩（调用 /feedback）', () => vote(m, 'DISLIKE', like, dislike));
      if (m.vote === 'LIKE') like.classList.add('on');
      if (m.vote === 'DISLIKE') dislike.classList.add('on');
    }
    addTool('重答', '重新生成本条回答', () => regenerate(m));
    if (m.requestId)
      addTool('请求ID', `requestId=${m.requestId}\ntaskId=${m.taskId || '—'}`, () =>
        copyWithFeedback(`requestId=${m.requestId}\ntaskId=${m.taskId || ''}`, '已复制 requestId')
      );
  }
  body.appendChild(tools);
  wrap.append(ava, body);
  return wrap;
}

function scrollToBottom(force = false) {
  const nearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 200;
  if (force || nearBottom) el.messages.scrollTop = el.messages.scrollHeight;
}

/* ---------------- 发送 ---------------- */
function setConn(text, stateName = 'idle') {
  el.connState.textContent = text;
  el.connState.dataset.state = stateName;
}

function setBusy(busy) {
  state.busy = busy;
  el.btnSend.disabled = busy;
  el.btnStop.disabled = !busy;
  setConn(busy ? '生成中…' : '就绪', busy ? 'running' : 'idle');
  if (bridge) {
    bridge.emit('state', { busy, sessionId: state.conv ? state.conv.sessionId : '' });
  }
}

/**
 * 智能体链路才需要会话：先 createSession 拿 uniqueCode，之后每轮复用（历史由网关侧维护）。
 * 大模型（OpenAI 兼容）是**无状态**的，没有会话概念 —— sendMessage 会直接带着完整历史
 * 去调 /api/model/chat，压根不会走到这里。
 */
async function ensureSession() {
  const conv = state.conv;
  // 用**会话归属**的智能体（而不是侧栏当前选中的）：会话才是事实来源，两者不一致时会拿错 key 建会话
  const agent = (conv && targetOf('agent', conv.agentId)) || currentAgent();
  if (!agent) throw new Error('未选择智能体');
  if (conv && convTargetGone(conv)) throw new Error(GONE_TARGET_MSG(conv));
  if (conv.sessionId) return conv.sessionId;
  setConn('创建会话…', 'running');
  const r = await api.createSession(agent.id);
  conv.sessionId = r.sessionId;
  store.saveConversation(conv);
  if (state.settings.serverHistory) api.historySave(conv);
  renderBadge();
  return r.sessionId;
}

async function sendMessage(rawText, opts = {}) {
  if (state.busy) return toast('正在生成中，请先停止', true);
  if (!state.conv) {
    const owner = currentTarget();
    if (!owner) return toast('没有可用的智能体或大模型', true);
    startNewConversation(owner.id, { silent: true, kind: state.settings.targetKind });
  }
  // 孤儿会话拦截：必须在建用户消息气泡之前返回，否则会留下一条「发了但没回复」的假记录
  if (convTargetGone(state.conv)) return toast(GONE_TARGET_MSG(state.conv), true);

  const conv = state.conv;
  const kind = convKind(conv);
  // 归属对象一律取**会话**的，而不是侧栏当前选中的 —— 刚打开一条旧会话时两者可能不一致，
  // 用侧栏的会把消息发错对象（顶栏却显示的是会话的对象，用户看不出来）
  const agent = kind === 'agent' ? targetOf('agent', conv.agentId) || currentAgent() : null;

  const attachments = [...(state.settings.attachments || [])];
  const text = String(rawText ?? '').trim();
  if (!text && !attachments.length) return;

  const params = { ...(state.settings.params || {}), ...(opts.params || {}) };

  // 用户消息
  const userMsg = store.newMessage('user', {
    text,
    params,
    attachments,
    displayText: text,
  });
  conv.messages.push(userMsg);

  // 助手占位
  const aiMsg = store.newMessage('assistant', { status: 'streaming' });
  conv.messages.push(aiMsg);

  if (conv.title === '新对话' && text) conv.title = text.slice(0, 22);
  store.saveConversation(conv);
  renderConvList();
  el.messages.innerHTML = '';
  conv.messages.forEach((m) => el.messages.appendChild(renderMessage(m)));
  scrollToBottom(true);

  // 清空输入
  if (!opts.keepInput) {
    el.input.value = '';
    autoGrow();
    state.settings = store.saveSettings({ attachments: [] });
    renderAttachBar();
  }

  const startedAt = Date.now();
  if (bridge) bridge.emit('user-message', { text, params, conversationId: conv.id });

  setBusy(true);
  state.abort = new AbortController();
  const aiNode = el.messages.querySelector(`.msg[data-id="${aiMsg.id}"] .bubble`);

  const paint = () => {
    if (!aiNode) return;
    aiNode.innerHTML = renderMarkdown(aiMsg.text || '') + (aiMsg.status === 'streaming' ? '<span class="cursor"></span>' : '');
    scrollToBottom();
  };

  // 两条链路（网关智能体 / OpenAI 兼容大模型）的事件名完全一致 —— 服务端已把两种响应
  // 都归一化成 meta / delta / thought / image / end / error，所以这里共用同一个回调，
  // 渲染逻辑只写一份。这是「大模型只要求兼容 OpenAI 接口」带来的额外好处。
  const onStreamEvent = (event, data) => {
    switch (event) {
      case 'meta':
        if (data.sessionId && data.sessionId !== conv.sessionId) {
          conv.sessionId = data.sessionId;
          store.saveConversation(conv);
          renderBadge();
        }
        if (data.requestId) aiMsg.requestId = data.requestId;
        if (data.taskId) aiMsg.taskId = data.taskId;
        if (data.messageId) aiMsg.messageId = data.messageId;
        break;
      case 'delta':
        aiMsg.text += data.text || '';
        paint();
        if (bridge) bridge.emitDelta(data.text || '', aiMsg.text);
        break;
      case 'thought': {
        const had = !!aiMsg.thought;
        aiMsg.thought += data.text || '';
        if (bridge) bridge.emit('thought', { text: data.text || '' });
        const node = el.messages.querySelector(`.msg[data-id="${aiMsg.id}"]`);
        if (!had && node) {
          const d = document.createElement('details');
          d.className = 'think';
          d.open = true;
          d.innerHTML = `<summary>思考过程</summary><pre>${escapeHtml(aiMsg.thought)}</pre>`;
          node.querySelector('.body').prepend(d);
        } else if (node) {
          const pre = node.querySelector('details.think pre');
          if (pre) pre.textContent = aiMsg.thought;
        }
        break;
      }
      case 'image':
        aiMsg.images.push(...(data.images || []));
        break;
      case 'error':
        aiMsg.status = 'error';
        aiMsg.text += `${aiMsg.text ? '\n\n' : ''}⚠️ ${data.message || '调用失败'}`;
        paint();
        toast(data.message || '调用失败', true);
        if (bridge) bridge.emit('error', { message: data.message || '调用失败' });
        break;
      case 'end':
        if (!aiMsg.text && data.message) aiMsg.text = data.message;
        if (!aiMsg.thought && data.thought) aiMsg.thought = data.thought;
        if (data.requestId) aiMsg.requestId = data.requestId;
        if (data.taskId) aiMsg.taskId = data.taskId;
        break;
      default:
        break;
    }
  };

  try {
    if (kind === 'model') {
      // 大模型：**无状态**，每轮都要把完整历史带上（OpenAI 的 [{role, content}] 格式）。
      // 排除正在流式的这条占位消息 —— 它此刻还是空的。
      // 用户那侧取 displayText（原始输入），而不是 text（可能已被 buildPrompt 拼过参数）。
      const history = conv.messages
        .filter((m) => m.id !== aiMsg.id)
        .map((m) => ({
          role: m.role,
          content: String((m.role === 'assistant' ? m.text : m.displayText ?? m.text) || ''),
        }))
        .filter((m) => m.content.trim());
      if (!history.length) throw new Error('没有可发送的内容');
      setConn('请求大模型…', 'running');
      await api.streamModelChat(
        { modelId: conv.agentId, messages: history, stream: state.settings.stream },
        onStreamEvent,
        state.abort.signal
      );
    } else {
      const sessionId = await ensureSession();
      const prompt = buildPrompt(agent, text, params);
      const metadata = buildMetadata(agent, params);
      await api.streamRun(
        {
          agentId: agent.id,
          sessionId,
          stream: state.settings.stream,
          delta: state.settings.delta,
          trace: state.settings.trace,
          message: { text: prompt, metadata, attachments },
        },
        onStreamEvent,
        state.abort.signal
      );
    }
    if (aiMsg.status === 'streaming') aiMsg.status = 'ok';
  } catch (err) {
    if (err.name === 'AbortError') {
      aiMsg.status = 'ok';
      aiMsg.text += `${aiMsg.text ? '\n\n' : ''}_（已终止生成）_`;
    } else {
      aiMsg.status = 'error';
      aiMsg.text += `${aiMsg.text ? '\n\n' : ''}⚠️ ${err.message}`;
      toast(err.message, true);
    }
  } finally {
    state.abort = null;
    setBusy(false);
    const node = el.messages.querySelector(`.msg[data-id="${aiMsg.id}"]`);
    if (node) {
      const cursor = node.querySelector('.cursor');
      if (cursor) cursor.remove();
      const bub = node.querySelector('.bubble');
      if (bub) bub.innerHTML = renderMarkdown(aiMsg.text || '（无内容）');
      node.replaceWith(renderMessage(aiMsg));
    }
    store.saveConversation(conv);
    if (state.settings.serverHistory) api.historySave(conv);
    renderConvList();
    scrollToBottom();
    if (bridge) {
      bridge.reply({
        conversationId: conv.id,
        // 归属 id：智能体会话是智能体 id，大模型会话是模型 id（配合 kind 一起看）
        agentId: conv.agentId,
        kind,
        text: aiMsg.text || '',
        thought: aiMsg.thought || '',
        images: aiMsg.images || [],
        sessionId: conv.sessionId || '',
        requestId: aiMsg.requestId || '',
        taskId: aiMsg.taskId || '',
        messageId: aiMsg.messageId || '',
        status: aiMsg.status,
        durationMs: Date.now() - startedAt,
      });
    }
    // 嵌入场景不要抢宿主页面的焦点（会带着外层滚动条跳动）
    if (!EMBED.mode) el.input.focus();
  }
}

async function regenerate(aiMsg) {
  if (state.busy) return toast('正在生成中', true);
  const conv = state.conv;
  const idx = conv.messages.findIndex((m) => m.id === aiMsg.id);
  if (idx < 1) return;
  const userMsg = conv.messages[idx - 1];
  if (!userMsg || userMsg.role !== 'user') return;
  conv.messages.splice(idx, 1);
  store.saveConversation(conv);
  el.messages.innerHTML = '';
  conv.messages.forEach((m) => el.messages.appendChild(renderMessage(m)));
  // 复用输入的文本，不重复追加用户气泡
  conv.messages.pop();
  store.saveConversation(conv);
  await sendMessage(userMsg.displayText ?? userMsg.text, { params: userMsg.params, keepInput: true });
}

async function vote(msg, voteValue, likeBtn, dislikeBtn) {
  if (!state.conv || !state.conv.sessionId) return toast('会话尚未建立', true);
  if (!msg.requestId || !msg.taskId) return toast('缺少 requestId / taskId，无法反馈', true);
  try {
    await api.sendFeedback({
      sessionId: state.conv.sessionId,
      agentId: state.conv.agentId,
      requestId: msg.requestId,
      taskId: msg.taskId,
      subject: 'REQUEST',
      vote: voteValue,
      comment: '',
    });
    msg.vote = msg.vote === voteValue ? '' : voteValue;
    likeBtn.classList.toggle('on', msg.vote === 'LIKE');
    dislikeBtn.classList.toggle('on', msg.vote === 'DISLIKE');
    store.saveConversation(state.conv);
    toast(msg.vote ? '反馈已提交' : '已取消反馈');
  } catch (err) {
    toast(`反馈失败：${err.message}`, true);
  }
}

async function stopGeneration() {
  if (!state.busy) return;
  if (state.abort) state.abort.abort();
  if (state.conv && state.conv.sessionId) {
    await api.clearSession(state.conv.sessionId, state.conv.agentId).catch(() => {});
  }
  toast('已终止本次生成');
}

/* ==========================================================================
   输入区
   ========================================================================== */
/* 输入框高度跟着内容长，但最多长到「两行」（上限来自 CSS 的
   .composer textarea { max-height: var(--ta-max-h) }），到顶后由框内滚动接管。
   上限必须从 CSS 现读，别在这里写死数字 —— 以前 JS 写 180、嵌入模式下 CSS 写 118，
   JS 设的 180 被 CSS 夹到 118，两边各说各话，改一处另一处就悄悄失效了。

   +1px 是必须的：scrollHeight 返回整数，一行文字的真实高度是 36.4px 却报 36，
   照 36 设高就等于自己把自己压矮 0.4px，浏览器立刻判定「装不下」并冒出一条滚动条
   —— 用户要的是「一行不出条、超过两行才出条」，差这 0.4px 就全错了。
   顶到上限后这 1px 无所谓（上限本身已留了 1px 余量）。 */
function autoGrow() {
  const cap = parseFloat(getComputedStyle(el.input).maxHeight);
  el.input.style.height = 'auto';
  const need = Math.ceil(el.input.scrollHeight) + 1;
  el.input.style.height = `${Number.isFinite(cap) ? Math.min(need, cap) : need}px`;
}

function renderAttachBar() {
  const list = state.settings.attachments || [];
  el.attachBar.hidden = !list.length;
  el.attachBar.innerHTML = '';
  list.forEach((a, i) => {
    const c = document.createElement('span');
    c.className = 'chip';
    c.innerHTML = `📎 <span>${escapeHtml(a.name || a.url)}</span><button title="移除">✕</button>`;
    c.querySelector('button').addEventListener('click', () => {
      const next = list.filter((_, j) => j !== i);
      state.settings = store.saveSettings({ attachments: next });
      renderAttachBar();
    });
    el.attachBar.appendChild(c);
  });
}

function renderParamsBar() {
  const params = state.settings.params || {};
  const entries = Object.entries(params);
  el.paramsBar.hidden = !entries.length;
  el.paramsBar.innerHTML = '';
  entries.forEach(([k, v]) => {
    const c = document.createElement('span');
    c.className = 'chip';
    c.innerHTML = `🔗 <span>${escapeHtml(k)}=${escapeHtml(v)}</span><button title="移除">✕</button>`;
    c.querySelector('button').addEventListener('click', () => {
      const next = { ...params };
      delete next[k];
      state.settings = store.saveSettings({ params: next });
      renderParamsBar();
      refreshParamsUI();
    });
    el.paramsBar.appendChild(c);
  });
}

function refreshParamsUI() {
  // 「链接参数」是给智能体业务用的（拼进 prompt 与 metadata）；大模型链路只把原始问句发过去，
  // 参数不会被用上 —— 所以模型会话下预览区改为说明这一点，而不是渲染一段根本发不出去的文本。
  const isModel = state.conv ? convKind(state.conv) === 'model' : state.settings.targetKind === 'model';
  const agent = isModel ? null : (state.conv && targetOf('agent', state.conv.agentId)) || currentAgent();
  const params = state.settings.params || {};
  const entries = Object.entries(params);

  el.paramList.innerHTML = '';
  if (!entries.length) {
    el.paramList.innerHTML = '<p class="hint">当前没有链接参数。可用 <code>?agent=service&amp;q=你好&amp;user=张三&amp;phone=138…</code> 形式调用。</p>';
  } else {
    entries.forEach(([k, v]) => {
      const d = document.createElement('div');
      d.className = 'param-row';
      d.innerHTML = `<code>${escapeHtml(k)}</code><span>${escapeHtml(v)}</span>`;
      el.paramList.appendChild(d);
    });
  }

  el.shareLink.textContent = buildShareLink();
  const sample = el.input.value.trim() || '（在上方输入框写一句问题，这里预览最终发给智能体的内容）';
  el.promptPreview.textContent = isModel
    ? '大模型会话不拼装链接参数：输入框内容原样发送。'
    : agent
      ? buildPrompt(agent, sample, params)
      : '—';
}

/* ==========================================================================
   抽屉
   ========================================================================== */
function openDrawer(tab) {
  el.drawer.hidden = false;
  el.drawerMask.hidden = false;
  if (tab) selectTab(tab);
}
function closeDrawer() {
  el.drawer.hidden = true;
  el.drawerMask.hidden = true;
}
function selectTab(tab) {
  [...el.drawer.querySelectorAll('.tab')].forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  [...el.drawer.querySelectorAll('.drawer-body')].forEach((p) => (p.hidden = p.dataset.panel !== tab));
  if (tab === 'params') refreshParamsUI();
}

/* ==========================================================================
   iframe 嵌入模式
   ========================================================================== */
const EMBED = detectEmbed();
let bridge = null;

// 立刻打标，避免布局闪一下（CSS 里 html[data-embed] 生效）
if (EMBED.mode) document.documentElement.dataset.embed = EMBED.mode;

/** 应用嵌入模式的布局行为 */
function applyEmbedMode(link) {
  if (!EMBED.mode) return;
  // 侧栏默认展开（与直接打开时一致），宿主可用 ?sidebar=0 让它初始收起。
  setSidebarCollapsed(sidebarPref(link) === 'collapsed');
}

/**
 * 浮层侧栏的「点主区 / Esc 收起」。
 *
 * **为什么必须有**：窄屏（≤860px）与嵌入模式下侧栏是 fixed 浮层（z-index 45），
 * 会把主区顶栏里的 ☰ 整块盖住 —— 那时 ☰ 点不到，屏幕上就没有任何能收起侧栏的按钮。
 * 早先品牌区摆过一枚 ⇤ 专门补这个死角，但和 ⚙ 并排看着重复，已撤掉；
 * 改用抽屉的标准交互补：点主区一下、或按 Esc 收起，收起后 ☰ 重新露出来负责展开。
 * 这样**不增加任何可见图标**，也不会和顶栏那个开关重复。
 *
 * 判据用「侧栏此刻是否真的浮层」（实测 position）而不是重算媒体查询：
 * 嵌入模式下侧栏是浮层还是正常占位，取决于容器实际宽度（见 css 的 620px 那条），
 * 实测最准，也免了在 css 与 js 里各维护一份宽度阈值。
 * 容器够宽（侧栏正常占位）时点对话内容不会收起 —— 否则只是看一眼消息就跳版，很烦。
 */
function bindOverlaySidebarDismiss() {
  const isOverlay = () => getComputedStyle(el.sidebar).position === 'fixed';
  document.querySelector('.main').addEventListener('mousedown', (e) => {
    if (!isOverlay()) return;
    if (e.target.closest('#btnToggleSidebar')) return;
    setSidebarCollapsed(true);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOverlay()) setSidebarCollapsed(true);
  });
}

/** 链接参数 ?sidebar=0|1 决定侧栏初始状态，默认展开 */
function sidebarPref(link) {
  const raw = String((link && link.reserved && link.reserved.sidebar) ?? '').toLowerCase();
  if (['0', 'false', 'off', 'collapsed', 'hide'].includes(raw)) return 'collapsed';
  return 'expanded';
}

/**
 * 侧栏收起 / 展开的**唯一出口**。三个入口全走这里：
 *   ① 主区顶栏的 ☰（唯一的 UI 开关，收起与展开都是它）；
 *   ② 宿主下发的 postMessage `set-sidebar`；③ 链接 `?sidebar=0` 的初始状态。
 *
 * 为什么不各处直接 `classList.add('collapsed')`：光切类不会更新 aria-expanded，
 * 读屏用户点完按钮听到的状态还是旧的。集中一处才能保证「状态与语义一起变」。
 */
function setSidebarCollapsed(collapsed) {
  const on = !!collapsed;
  el.sidebar.classList.toggle('collapsed', on);
  el.btnToggleSidebar.setAttribute('aria-expanded', String(!on));
}

/* ==========================================================================
   侧栏分组显隐
   ========================================================================== */
/**
 * 决定「大模型」「智能体」两个分组是否显示。三层优先级（后者压前者）：
 *
 *   1. **没内容就不显示** —— models.json / agents.json 为空时摆一个「大模型 0」的空标题毫无意义；
 *   2. `config/settings.json` 的 `ui.showModels` / `ui.showAgents`（默认 true）；
 *   3. **链接显式点名就强制显示** —— `?model=xxx` 强制显示大模型分组，`?agent=xxx` 强制显示智能体分组。
 *      这是需求里明确要的行为：配置里默认关掉，但链接带着这个对象时仍要把它显示出来。
 *      （对象本身还得真实存在，否则第 1 条会挡掉 —— 一个选不中的空栏位显示出来也没用）
 *
 * 实现上只是给 .sidebar 挂/摘 data-hide-* 属性，样式与理由见 css 里同名那段注释。
 */
function applyRegions(link = {}) {
  const ui = (state.config && state.config.ui) || {};
  const r = (link && link.reserved) || {};
  const forceModels = !!(r.model || r.modelid || r.modelname);
  const forceAgents = !!(r.agent || r.agentid || r.code || r.agentcode);
  const showModels = state.models.length > 0 && (ui.showModels !== false || forceModels);
  const showAgents = state.agents.length > 0 && (ui.showAgents !== false || forceAgents);
  el.sidebar.toggleAttribute('data-hide-models', !showModels);
  el.sidebar.toggleAttribute('data-hide-agents', !showAgents);
  updateBrandTitle();
}

/**
 * 侧栏品牌标题自适应：
 *   只有大模型 → 「大模型对话」；只有智能体 → 「智能体对话」；两者都有 / 都没有 → 「AI对话」。
 *
 * 判据是**分区此刻是否真的显示**（读 applyRegions 刚挂上的 data-hide-*），而不是
 * 「配置里各配了几条」：`ui.showAgents` 关掉之后，即使 agents.json 里还躺着 5 个智能体，
 * 用户在界面上也确实只能跟大模型说话，标题就该如实变成「大模型对话」。
 * 这样判定只存在一处（applyRegions），不会出现「标题说有、侧栏没有」的两套口径。
 */
function updateBrandTitle() {
  const hasModels = !el.sidebar.hasAttribute('data-hide-models');
  const hasAgents = !el.sidebar.hasAttribute('data-hide-agents');
  el.brandTitle.textContent =
    hasModels && hasAgents ? 'AI对话' : hasModels ? '大模型对话' : hasAgents ? '智能体对话' : 'AI对话';
}

/** 给宿主的状态快照（ready / get-state 用） */
function snapshotState() {
  return {
    embed: EMBED.mode,
    framed: EMBED.framed,
    parentOrigin: bridge ? bridge.parentOrigin : '',
    storage: store.storageMode(),
    mock: state.config ? !!state.config.mock : null,
    agents: state.agents.map((a) => ({ id: a.id, name: a.name, agentCode: a.agentCode })),
    models: state.models.map((m) => ({ id: m.id, name: m.name, model: m.model })),
    // 侧栏选中的归属类型与两类 id 都报出去：宿主据此知道此刻的对话对象是智能体还是大模型
    targetKind: state.settings.targetKind,
    agentId: state.settings.agentId,
    modelId: state.settings.modelId,
    kind: state.conv ? convKind(state.conv) : state.settings.targetKind,
    conversationId: state.conv ? state.conv.id : '',
    sessionId: state.conv ? state.conv.sessionId : '',
    messageCount: state.conv ? state.conv.messages.length : 0,
    busy: state.busy,
    title: state.conv ? state.conv.title : '',
  };
}

async function applyAgentById(agentId) {
  if (!agentId) return;
  const hit =
    state.agents.find((a) => a.id === agentId) ||
    state.agents.find((a) => a.agentCode === agentId) ||
    state.agents.find((a) => a.name === agentId);
  if (!hit) throw new Error(`未知智能体：${agentId}`);
  if (state.settings.targetKind === 'agent' && hit.id === state.settings.agentId) return;
  // switchAgent 在忙碌时只会 toast 一声就返回，对程序化调用方是「静默失败」，这里必须显式拒绝
  if (state.busy) throw new Error('正在生成中，请先发送 stop 命令');
  await switchAgent(hit.id);
}

/** 宿主侧切大模型（与 applyAgentById 对称） */
async function applyModelById(modelId) {
  if (!modelId) return;
  const hit =
    state.models.find((m) => m.id === modelId) ||
    state.models.find((m) => m.model === modelId) ||
    state.models.find((m) => m.name === modelId);
  if (!hit) throw new Error(`未知大模型：${modelId}`);
  if (state.settings.targetKind === 'model' && hit.id === state.settings.modelId) return;
  if (state.busy) throw new Error('正在生成中，请先发送 stop 命令');
  await switchModel(hit.id);
}

/** 宿主通过 postMessage 下发的命令 */
async function handleHostCommand(type, payload = {}) {
  switch (type) {
    case 'ask': {
      if (state.busy) throw new Error('正在生成中，请先发送 stop 命令');
      const text = String(payload.text ?? payload.q ?? '').trim();
      if (!text) throw new Error('ask 命令缺少 text');
      await applyAgentById(payload.agentId);
      if (payload.params && typeof payload.params === 'object') {
        state.settings = store.saveSettings({ params: { ...(state.settings.params || {}), ...payload.params } });
        renderParamsBar();
        refreshParamsUI();
      }
      if (payload.newConversation) {
        const owner = currentTarget();
        if (!owner) throw new Error('没有可用的智能体或大模型');
        startNewConversation(owner.id, { silent: true, kind: state.settings.targetKind });
      }
      // 孤儿会话不能静默吞掉：sendMessage 内部只会 toast，对宿主是「无声无息」。
      // 这里显式抛错，让宿主通过 error 事件拿到明确原因。
      if (convTargetGone(state.conv)) throw new Error(GONE_TARGET_MSG(state.conv));
      // 提问不阻塞回执：整段流式可能跑几十秒，宿主不该等它。
      // 结果通过 reply / error 事件异步送达，command-done 只表示「已受理」。
      sendMessage(text, { params: payload.params || {} }).catch((err) => {
        if (bridge) bridge.emit('error', { message: err.message || String(err) });
      });
      return {
        accepted: true,
        conversationId: state.conv ? state.conv.id : '',
        sessionId: state.conv ? state.conv.sessionId : '',
      };
    }
    case 'set-params': {
      const params = payload.params && typeof payload.params === 'object' ? payload.params : {};
      state.settings = store.saveSettings({ params: { ...(state.settings.params || {}), ...params } });
      renderParamsBar();
      refreshParamsUI();
      return { params: state.settings.params };
    }
    case 'set-sidebar': {
      const want = payload.collapsed ?? payload.hide ?? payload.value;
      const collapsed = want === true || want === 1 || want === '1' || want === 'true' || want === 'collapsed';
      setSidebarCollapsed(collapsed);
      return { collapsed };
    }
    case 'set-agent':
      await applyAgentById(payload.agentId);
      return { agentId: state.settings.agentId, targetKind: state.settings.targetKind };
    case 'set-model':
      await applyModelById(payload.modelId || payload.model);
      return { modelId: state.settings.modelId, targetKind: state.settings.targetKind };
    case 'set-visual': {
      const patch = {};
      if (payload.bg) {
        const bg = getBackground(payload.bg);
        if (bg) patch.bgId = bg.id;
      }
      if (payload.bgUrl === null) patch.bgCustom = '';
      else if (typeof payload.bgUrl === 'string') patch.bgCustom = payload.bgUrl;
      if (store.THEMES.includes(payload.theme)) {
        patch.theme = payload.theme;
        patch.themeExplicit = true;
      }
      if (payload.veil !== undefined) patch.veil = Math.max(0, Math.min(95, Number(payload.veil) || 0));
      if (payload.blur !== undefined) patch.blur = Math.max(0, Math.min(24, Number(payload.blur) || 0));
      if (Object.keys(patch).length) {
        state.settings = store.saveSettings(patch);
        applyVisual();
      }
      return { ...patch };
    }
    case 'stop':
      await stopGeneration();
      return { stopped: true };
    case 'clear': {
      if (state.busy) throw new Error('正在生成中，请先发送 stop 命令');
      // 允许顺带切换归属对象；都没传就沿用当前选中项
      if (payload.agentId) await applyAgentById(payload.agentId);
      if (payload.modelId) await applyModelById(payload.modelId);
      const owner = currentTarget();
      if (!owner) throw new Error('没有可用的智能体或大模型');
      startNewConversation(owner.id, { silent: true, kind: state.settings.targetKind });
      return { conversationId: state.conv.id, kind: convKind(state.conv) };
    }
    case 'focus':
      el.input.focus();
      return {};
    default:
      throw new Error(`不支持的命令：${type}`);
  }
}

function initBridge() {
  bridge = createBridge({ onCommand: handleHostCommand, getState: snapshotState });
  if (!bridge.active) return;
  for (const w of bridge.warnings) console.warn('[embed]', w);
  bridge.emit('ready', snapshotState());
  bridge.startAutoHeight();
  if (EMBED.framed && bridge.parentOrigin === '*' && !EMBED.autoHeight) {
    console.warn('[embed] 未指定宿主来源，已用宽松模式接收命令。生产环境请传 ?parent=https://your-host');
  }
  // 只读调试出口：宿主/运维可在控制台查看状态，测试也依赖它
  window.__agentChat = {
    version: 1,
    embed: { ...EMBED },
    parentOrigin: bridge.parentOrigin,
    storage: store.storageMode(),
    get state() {
      return snapshotState();
    },
  };
}

/* ==========================================================================
   初始化
   ========================================================================== */
function bindEvents() {
  el.input.addEventListener('input', () => {
    autoGrow();
    refreshParamsUI();
  });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage(el.input.value);
    }
  });
  el.btnSend.addEventListener('click', () => sendMessage(el.input.value));
  el.btnStop.addEventListener('click', stopGeneration);
  el.btnNewConv.addEventListener('click', () => newConversationForCurrent());
  // 侧栏开关：全站只有 ☰ 这一个 UI 入口，按当前状态取反（收起 / 展开都是它）。
  // 品牌区不再放同功能的箭头 —— 那是重复入口，已撤掉。
  el.btnToggleSidebar.addEventListener('click', () =>
    setSidebarCollapsed(!el.sidebar.classList.contains('collapsed'))
  );

  // 附件入口已按需求常隐（CSS 里 #btnAttach { display: none }），
  // 但绑定与弹层都留着：谁要恢复入口，删掉那条 CSS 就行，功能不用重写。
  el.btnAttach.addEventListener('click', async () => {
    const v = await ui.form({
      title: '添加附件',
      message: '附件以 URL 形式随消息一起提交给智能体。',
      fields: [
        { key: 'url', label: '附件地址', placeholder: 'https://…' },
        { key: 'name', label: '附件名称（可留空）', placeholder: '留空则取文件名' },
      ],
      okText: '添加',
    });
    if (!v || !v.url) return;
    const name = v.name || v.url.split('/').pop() || v.url;
    const next = [...(state.settings.attachments || []), { url: v.url, name }];
    state.settings = store.saveSettings({ attachments: next });
    renderAttachBar();
  });

  el.curSessionId.addEventListener('click', async () => {
    if (!state.conv || !state.conv.sessionId) return;
    await copyWithFeedback(state.conv.sessionId, 'sessionId 已复制');
  });

  // 抽屉：入口只有一个（品牌区的 ⚙），默认落在「设置」页，其余两页点顶部切页
  el.btnOpenSettings.addEventListener('click', () => openDrawer('settings'));
  el.btnCloseDrawer.addEventListener('click', closeDrawer);
  el.drawerMask.addEventListener('click', closeDrawer);
  [...el.drawer.querySelectorAll('.tab')].forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  // 背景
  el.btnPickBg.addEventListener('click', () => el.bgFile.click());
  el.bgFile.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) readImageFile(f);
    e.target.value = '';
  });
  el.btnClearBg.addEventListener('click', () => {
    state.settings = store.saveSettings({ bgCustom: '', bgName: '' });
    applyVisual();
    toast('已恢复预设背景');
  });
  el.veilRange.addEventListener('input', () => {
    state.settings = store.saveSettings({ veil: Number(el.veilRange.value) });
    el.veilVal.textContent = `${el.veilRange.value}%`;
    applyVisual();
  });
  el.blurRange.addEventListener('input', () => {
    state.settings = store.saveSettings({ blur: Number(el.blurRange.value) });
    el.blurVal.textContent = `${el.blurRange.value}px`;
    applyVisual();
  });
  [...el.themeSeg.children].forEach((b) =>
    b.addEventListener('click', () => {
      // themeExplicit 一旦置位就固定用用户选择，不再跟随服务端默认
      state.settings = store.saveSettings({ theme: b.dataset.theme, themeExplicit: true });
      applyVisual();
    })
  );

  // 拖拽图片设为背景
  const onDrop = (e) => {
    e.preventDefault();
    el.messages.classList.remove('dragging');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readImageFile(f);
  };
  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    el.messages.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) el.messages.classList.remove('dragging');
  });
  window.addEventListener('drop', onDrop);

  // 参数
  el.btnAddKv.addEventListener('click', () => {
    const k = el.kvKey.value.trim();
    const v = el.kvVal.value.trim();
    if (!k) return toast('请输入参数名', true);
    state.settings = store.saveSettings({ params: { ...(state.settings.params || {}), [k]: v } });
    el.kvKey.value = '';
    el.kvVal.value = '';
    renderParamsBar();
    refreshParamsUI();
  });
  el.btnCopyLink.addEventListener('click', async () => {
    await copyWithFeedback(buildShareLink(), '链接已复制');
  });
  el.btnApplyLink.addEventListener('click', () => {
    history.replaceState(null, '', buildShareLink());
    refreshParamsUI();
    toast('链接已更新到地址栏');
  });

  // 设置
  const bindToggle = (node, key) =>
    node.addEventListener('change', () => {
      state.settings = store.saveSettings({ [key]: node.checked });
    });
  bindToggle(el.optStream, 'stream');
  bindToggle(el.optDelta, 'delta');
  bindToggle(el.optTrace, 'trace');
  bindToggle(el.optServerHistory, 'serverHistory');

  el.btnExport.addEventListener('click', () => {
    if (!state.conv || !state.conv.messages.length) return toast('当前对话为空', true);
    const md = [
      `# ${state.conv.title}`,
      '',
      `- ${convKind(state.conv) === 'model' ? '大模型' : '智能体'}：${(currentOwner() || {}).name || '—'}`,
      `- sessionId：${state.conv.sessionId || '—'}`,
      `- 导出时间：${new Date().toLocaleString()}`,
      '',
      ...state.conv.messages.map(
        (m) => `## ${m.role === 'user' ? '我' : '智能体'}\n\n${m.thought ? `> 思考过程\n> ${m.thought.replace(/\n/g, '\n> ')}\n\n` : ''}${m.text}\n`
      ),
    ].join('\n');
    download(`对话-${state.conv.title}-${Date.now()}.md`, md, 'text/markdown');
  });

  el.btnImport.addEventListener('click', () => el.importFile.click());
  el.importFile.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const n = store.importAll(JSON.parse(await f.text()));
      renderConvList();
      // 同步到服务端
      for (const c of store.listConversations()) api.historySave(c);
      toast(`已导入 ${n} 个对话`);
    } catch (err) {
      toast(`导入失败：${err.message}`, true);
    }
  });

  el.btnClearAll.addEventListener('click', async () => {
    const n = store.listConversations().length;
    const ok = await ui.confirm({
      title: '清空全部对话',
      message: `将删除本地 ${n} 个对话记录，同时清除服务端会话数据。该操作不可恢复。`,
      okText: '全部清空',
      danger: true,
    });
    if (!ok) return;
    for (const c of store.listConversations()) {
      if (c.sessionId) await api.deleteSession(c.sessionId, c.agentId).catch(() => {});
      await api.historyRemove(c.id).catch(() => {});
    }
    store.clearAllConversations();
    newConversationForCurrent({ silent: true });
    renderConvList();
    toast('已清空');
  });

  window.addEventListener('beforeunload', () => {
    if (state.conv) {
      store.saveConversation(state.conv);
      if (state.settings.serverHistory) {
        // 用 sendBeacon 提升关闭页面时的保存成功率
        try {
          navigator.sendBeacon('/api/history', new Blob([JSON.stringify(state.conv)], { type: 'application/json' }));
        } catch {
          /* ignore */
        }
      }
    }
  });
}

function download(filename, content, type) {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ==========================================================================
   启动
   ========================================================================== */
async function boot() {
  // 1. 处理链接参数
  const link = parseLinkParams();
  const patch = {};
  if (Object.keys(link.params).length) patch.params = link.params;
  if (link.reserved.bg) {
    const bg = getBackground(link.reserved.bg);
    if (bg) patch.bgId = bg.id;
    else if (/^(https?:|data:image)/.test(link.reserved.bg)) patch.bgCustom = link.reserved.bg;
  }
  if (store.THEMES.includes(link.reserved.theme)) {
    patch.theme = link.reserved.theme;
    patch.themeExplicit = true;
  }
  if (link.reserved.veil) patch.veil = Math.max(0, Math.min(95, Number(link.reserved.veil)));
  if (link.reserved.blur) patch.blur = Math.max(0, Math.min(24, Number(link.reserved.blur)));
  if (Object.keys(patch).length) state.settings = store.saveSettings(patch);

  renderBgGrid();
  applyVisual();

  // 2. 拉配置
  try {
    const cfg = await api.getConfig();
    state.config = cfg;
    state.agents = cfg.agents || [];
    state.models = cfg.models || [];
    el.brandSub.textContent = cfg.mock ? 'MOCK 模式（本地模拟）' : '已连接网关';
    el.setMode.textContent = cfg.mock ? 'MOCK 模拟' : '真实网关';
    el.setBase.textContent = cfg.gatewayBaseUrl || '未配置';
    el.setKey.textContent = cfg.gatewayConfigured ? '已配置（服务端）' : '未配置';
    el.callbackUrl.textContent = `${location.origin}/api/tool/taskFinishNotice`;
    el.tokenHint.textContent = state.models.length
      ? `${state.agents.length} 个智能体 · ${state.models.length} 个大模型`
      : `${state.agents.length} 个智能体 · sessionId 由网关维护`;
    el.optStream.checked = state.settings.stream;
    el.optDelta.checked = state.settings.delta;
    el.optTrace.checked = state.settings.trace;
    el.optServerHistory.checked = state.settings.serverHistory;
  } catch (err) {
    toast(`无法获取服务端配置：${err.message}`, true);
    el.brandSub.textContent = '服务端未就绪';
    setConn('离线', 'error');
    return;
  }

  if (!state.agents.length && !state.models.length) {
    toast('config/agents.json 与 config/models.json 都没有可用对象', true);
    return;
  }

  // 3. 选定归属对象（智能体 or 大模型）—— 两者互斥，同一时刻只选中一个
  //    优先级：链接参数 > 上次选择 > 服务端 default > 列表第一个。
  //    注意每一步都要校验 id 真实存在：defaultAgent / settings 里都可能是失效 id
  //    （用户把 default 指向的对象删了、或把条目删光），直接采信就等于把失效 id 存进设置。
  const wantedModel = link.reserved.model || link.reserved.modelid || link.reserved.modelname;
  const wantedAgent = link.reserved.agent || link.reserved.agentid || link.reserved.code || link.reserved.agentcode;
  let kind = '';
  let ownerId = '';
  if (wantedModel) {
    const hit =
      state.models.find((m) => m.id === wantedModel) ||
      state.models.find((m) => m.model === wantedModel) ||
      state.models.find((m) => m.name === wantedModel);
    if (hit) {
      kind = 'model';
      ownerId = hit.id;
    } else toast(`链接中的大模型「${wantedModel}」不存在，已回退默认`, true);
  }
  if (!ownerId && wantedAgent) {
    const hit =
      state.agents.find((a) => a.id === wantedAgent) ||
      state.agents.find((a) => a.agentCode === wantedAgent) ||
      state.agents.find((a) => a.name === wantedAgent);
    if (hit) {
      kind = 'agent';
      ownerId = hit.id;
    } else toast(`链接中的智能体「${wantedAgent}」不存在，已回退默认`, true);
  }
  if (!kind) {
    // 链接没点名：沿用上次选的类型；那一类已经被删空（比如 models.json 改成空数组）就换另一类
    kind = state.settings.targetKind === 'model' && state.models.length ? 'model' : 'agent';
    if (kind === 'agent' && !state.agents.length) kind = 'model';
    else if (kind === 'model' && !state.models.length) kind = 'agent';
  }
  if (!ownerId) {
    if (kind === 'model') {
      const cur = state.settings.modelId;
      const def = state.config.defaultModel;
      ownerId =
        (cur && state.models.some((m) => m.id === cur) ? cur : '') ||
        (def && state.models.some((m) => m.id === def) ? def : '') ||
        (state.models[0] && state.models[0].id) ||
        '';
    } else {
      const cur = state.settings.agentId;
      const def = state.config.defaultAgent;
      ownerId =
        (cur && state.agents.some((a) => a.id === cur) ? cur : '') ||
        (def && state.agents.some((a) => a.id === def) ? def : '') ||
        (state.agents[0] && state.agents[0].id) ||
        '';
    }
  }
  if (!ownerId) {
    toast('没有可用的智能体或大模型', true);
    return;
  }
  state.settings = store.saveSettings(
    kind === 'model' ? { targetKind: 'model', modelId: ownerId } : { targetKind: 'agent', agentId: ownerId }
  );

  // 显隐必须在渲染之前决定：隐藏的分组没必要渲染，而且 applyRegions 依赖 state.models/agents 已就位
  applyRegions(link);
  renderTargets();
  applyVisual();

  // 4. 恢复/创建会话（title 只在新建时生效，避免刷新链接时把历史会话改名）
  //    匹配会话时必须**同时**比对 kind 与归属 id：智能体与大模型可能取到同一个 id 字符串，
  //    只比对 agentId 会把大模型的会话当成智能体的打开。
  const forceNew = link.reserved.new === '1' || link.reserved.new === 'true';
  const activeId = store.getActiveId();
  const active = !forceNew && activeId ? store.getConversation(activeId) : null;
  if (active && active.agentId === ownerId && convKind(active) === kind) {
    state.conv = active;
  } else {
    const mine = store.listConversations().filter((c) => convKind(c) === kind && c.agentId === ownerId);
    if (!forceNew && mine.length) {
      state.conv = mine[0];
    } else {
      state.conv = store.createConversation(ownerId, { title: link.reserved.title || '新对话', kind });
    }
    store.setActiveId(state.conv.id);
  }

  renderConvList();
  renderBadge();
  renderMessages();
  renderAttachBar();
  renderParamsBar();
  refreshParamsUI();
  bindEvents();
  autoGrow();

  applyEmbedMode(link);
  // 与嵌入模式无关，任何宽度都要绑：窄屏下侧栏浮层会盖住 ☰，只能靠点主区 / Esc 收起
  bindOverlaySidebarDismiss();
  // 必须在「自动提问」之前握手，否则宿主会先收到 delta 再收到 ready
  initBridge();

  // 5. 自动发送
  const q =
    link.reserved.q || link.reserved.prompt || link.reserved.query ||
    link.reserved.message || link.reserved.text || link.reserved.question;
  const autoSend = link.reserved.autosend !== '0' && link.reserved.send !== '0';
  state.linkQuery = {
    raw: location.href,
    q: q || '',
    sys: link.reserved.sys || '',
    suffix: link.reserved.suffix || '',
    autosend: autoSend,
  };

  if (q && autoSend) {
    const prefix = link.reserved.sys ? `${link.reserved.sys}\n\n` : '';
    const suffix = link.reserved.suffix ? `\n\n${link.reserved.suffix}` : '';
    state.autoSendText = `${prefix}${q}${suffix}`;

    // 自动提问类参数从地址栏摘掉，避免用户刷新页面时重复提问、污染历史。
    // 原始链接已保存在 state.linkQuery.raw，"复制链接"仍能完整还原。
    try {
      const clean = new URL(location.href);
      ['q', 'prompt', 'query', 'message', 'text', 'question', 'autosend', 'send', 'sys', 'suffix', 'new'].forEach(
        (k) => clean.searchParams.delete(k)
      );
      history.replaceState(null, '', clean.toString());
    } catch {
      /* ignore */
    }

    setConn('链接自动提问…', 'running');
    setTimeout(() => sendMessage(state.autoSendText), 320);
  } else if (!EMBED.mode) {
    el.input.focus();
  }
}

boot();

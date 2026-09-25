/**
 * 与本地 Node 服务端通信。
 * 服务端负责：代理网关、隐藏 APP_KEY、把流式响应归一化成 SSE。
 */
async function jsonFetch(url, options = {}) {
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`服务端返回非 JSON（HTTP ${resp.status}）：${text.slice(0, 200)}`);
  }
  if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

export const getConfig = () => jsonFetch('/api/config');

/**
 * 发起一次流式请求，把服务端归一化后的 SSE 事件逐条回调出去。
 *
 * 智能体（/api/session/run）与大模型（/api/model/chat）**共用这一份解析**：
 * 服务端已经把两种来源的响应都归一化成同样的事件名（meta / delta / thought / end / error），
 * 所以前端不必知道背后是网关还是 OpenAI 兼容接口。
 *
 * @param {string} url
 * @param {object} body
 * @param {(event:string, data:object)=>void} onEvent
 * @param {AbortSignal} signal
 */
async function streamSse(url, body, onEvent, signal) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    let msg = `HTTP ${resp.status}`;
    try {
      msg = JSON.parse(text).error || msg;
    } catch {
      if (text) msg = text.slice(0, 300);
    }
    throw new Error(msg);
  }
  if (!resp.body) throw new Error('当前环境不支持流式读取');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  const handleFrame = (frame) => {
    let event = 'message';
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let payload;
    try {
      payload = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    onEvent(event, payload);
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      handleFrame(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) handleFrame(buf);
}

/**
 * 发起智能体调用。
 * @param {object} body { agentId, sessionId, stream, delta, trace, message:{text,metadata,attachments} }
 */
export const streamRun = (body, onEvent, signal) => streamSse('/api/session/run', body, onEvent, signal);

/**
 * 发起大模型调用（服务端代理到 OpenAI 兼容的 /chat/completions）。
 *
 * 与智能体的关键区别：这是**无状态**接口，没有 sessionId，
 * 每一轮都要把完整历史带上（body.messages 是 OpenAI 的 [{role, content}] 格式）。
 * @param {object} body { modelId, messages, stream }
 */
export const streamModelChat = (body, onEvent, signal) => streamSse('/api/model/chat', body, onEvent, signal);

export const createSession = (agentId) =>
  jsonFetch('/api/session/create', { method: 'POST', body: JSON.stringify({ agentId }) });

// 会话类接口都带上 agentId：每个智能体可能用**自己的 APP_KEY / 网关地址**，
// 服务端必须知道这个 sessionId 属于谁，才能选对凭证（否则网关会报「会话不存在」）。
export const clearSession = (sessionId, agentId) =>
  jsonFetch('/api/session/clear', { method: 'POST', body: JSON.stringify({ sessionId, agentId }) });

export const deleteSession = (sessionId, agentId) =>
  jsonFetch('/api/session/delete', { method: 'POST', body: JSON.stringify({ sessionId, agentId }) });

export const sendFeedback = (payload) =>
  jsonFetch('/api/feedback', { method: 'POST', body: JSON.stringify(payload) });

export const historyList = () => jsonFetch('/api/history');
export const historySave = (conv) =>
  jsonFetch('/api/history', { method: 'POST', body: JSON.stringify(conv) }).catch(() => ({ ok: false }));
export const historyRemove = (id) =>
  jsonFetch(`/api/history?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => ({ ok: false }));

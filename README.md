# 阿里百炼（数字重庆智能体开发.2.0版）智能体对话UI

一个可直接部署的 AI 大模型和智能体对话界面。侧栏为大模型 / 智能体 / 历史对话三栏，智能体走阿里百炼网关（支持多智能体切换与独立密钥），大模型走独立的 OpenAI 兼容直连，两栏可配置开关，也能用链接点名强制显示。支持多轮对话、服务端历史落盘、10 套背景、链接带参调用及 iframe 嵌入宿主系统。后端零依赖 Node，仅做静态托管与接口代理，APP_KEY 全留服务端；前端原生 ESM，无需构建。

零依赖（仅需 Node.js ≥ 20），无需构建步骤。

<img width="2252" height="1397" alt="image" src="https://github.com/user-attachments/assets/09fc5bfd-31f5-4bbe-87fa-84312d01e2ac" />

---

## 一、快速开始

```bash
cd BaiLianAgent_Chat
node server.mjs
```

打开 <http://127.0.0.1:5178/>

默认是 **Mock 模式**：不需要内网、不需要 APP_KEY，界面、多轮对话、历史保存、背景切换、链接传参全部可用，方便先验收交互。

侧栏自上而下三栏 —— **大模型 / 智能体 / 历史对话**，高度按 **1.5 : 3.5 : 5** 分配。
大模型直连 OpenAI 兼容接口（配 `config/models.json`），智能体走网关（配 `config/agents.json`），
两栏都能在 `config/settings.json` 里关掉。

其他入口：

- 链接带参调用（选智能体）：<http://127.0.0.1:5178/?agent=service&q=我的业务办到哪一步了&user=张三>
- 用链接直接选大模型：<http://127.0.0.1:5178/?model=general&q=你好>
- 嵌入模式：<http://127.0.0.1:5178/?embed=1&agent=service>
- **iframe 宿主示例**：<http://127.0.0.1:5178/embed-demo.html>（见第九章）

---

## 二、接入真实网关

编辑 `config/settings.json`：

```json
{
  "mock": false,
  "gateway": {
    "baseUrl": "http://23.210.227.120/xlm-gateway-ftlzsf/sfm-api-gateway/gateway/agent/api",
    "apiKey": "你的 APP_KEY",
    "timeoutMs": 120000
  }
}
```

也可以不写进文件，用环境变量启动（推荐，避免密钥进版本库）：

```bash
AGENT_MOCK=0 \
AGENT_BASE_URL=http://23.210.227.120/xlm-gateway-ftlzsf/sfm-api-gateway/gateway/agent/api \
AGENT_APP_KEY=你的APP_KEY \
AGENT_HOST=0.0.0.0 \
PORT=5178 \
node server.mjs
```

> **生产部署注意**：默认监听 `127.0.0.1`，只能本机访问；外网/内网其他机器访问必须改成 `0.0.0.0`。  
> 推荐用环境变量 `AGENT_HOST=0.0.0.0`（或 `HOST=0.0.0.0`）覆盖，不要改 `config/settings.json` 里的默认值，  
> 以免开发环境也暴露到局域网。

> **为什么必须走后端代理**：APP_KEY 若放在浏览器会直接暴露；网关在政务外网，浏览器直连必然跨域。因此所有网关调用都由 `server.mjs` 转发，浏览器只与本机服务通信。

**APP_KEY 支持按智能体分别配置。** 上面这把是「所有智能体共用的全局 key」；  
如果几个智能体分属不同应用、各有独立密钥，拿全局那把去调别人的接口，网关会直接拒绝。  
这时把 key 写到**智能体自己身上**即可，见 [五、多智能体配置 → 每个智能体用自己的 APP\_KEY](#每个智能体用自己的-app_key)。

启动后终端会打印当前模式与**每个智能体实际使用的凭证来源**（脱敏，只显示前 3 后 4），界面右下角「设置 → 服务端」也能看到网关配置状态。

**大模型走另一套完全独立的凭证。** 上面这把 APP_KEY 只管智能体。大模型的 key / 地址配在 `config/models.json`，
或用环境变量 `AGENT_MODEL_APP_KEY` / `AGENT_MODEL_BASE_URL` 覆盖，两套互不干扰 ——
可以只把大模型指到本地假服务、智能体照旧打真实网关。详见 [六、大模型配置](#六大模型配置openai-兼容)。

---

## 三、目录结构

```
agent-chat/
├─ server.mjs               # 零依赖服务端：静态托管 + 6 网关接口代理 + 大模型 OpenAI 代理 + 流式归一化 + 历史落盘
├─ package.json
├─ config/
│  ├─ settings.json         # 端口 / Mock 开关 / 全局网关地址 / 全局 APP_KEY / 超时
│  ├─ agents.json           # 多智能体配置（agentCode、名称、图标 icon、品牌色 accent、欢迎语、参数模板；
│  │                        #   可选：每个智能体自己的 apiKey / baseUrl）
│  └─ models.json           # 大模型配置（OpenAI 兼容：baseUrl / model / apiKey / system / temperature；
│                           #   **没有** agentCode、agentVersion —— 大模型不需要走网关建会话）
├─ public/
│  ├─ index.html
│  ├─ cockpit-host-demo.html # 驾驶舱大屏宿主页示例（把对话框嵌进窄面板）
│  ├─ embed-demo.html       # iframe 嵌入的宿主页示例（可直接打开看效果）
│  ├─ embed-sandbox-demo.html # 加了 sandbox 属性的最小接法
│  ├─ css/style.css
│  └─ js/
│     ├─ app.js             # 主流程：会话、智能体、大模型、链接传参、流式渲染
│     ├─ api.js             # 与服务端通信（SSE 解析两条链路共用同一套）
│     ├─ embed.js           # iframe 嵌入：环境识别 + postMessage 双向通信桥
│     ├─ ui.js              # 确认框 / 表单弹层（替代 window.confirm / prompt）
│     ├─ store.js           # localStorage 会话与设置持久化（不可用时降级内存）
│     ├─ agent-icons.js     # 内联 SVG 图标（6 个智能体 + 大模型 chip + 用户头像，设计稿就在这个文件里）
│     ├─ markdown.js        # 极简 Markdown 渲染（先转义后解析，防 XSS）
│     └─ backgrounds.js     # 10 套内置背景预设
├─ scripts/
│  └─ clean-history.mjs     # 运维脚本：清理 data/history/ 里的孤儿 / 空壳 / 调试残留会话
└─ data/history/            # 服务端会话存档（自动创建）
```
---

## 四、接口对照（文档 → 实现）

| 文档接口        | 网关路径                     | 本服务路由                             | 说明                                                                     |
| ----------- | ------------------------ | --------------------------------- | ---------------------------------------------------------------------- |
| 创建 session  | `POST /createSession`    | `POST /api/session/create`        | 入参 `agentCode`(+可选 `agentVersion`)，取回 `data.uniqueCode` 作为 `sessionId` |
| 发起 agent 调用 | `POST /run`              | `POST /api/session/run`           | 归一化为标准 SSE 事件后推给浏览器                                                    |
| 终止 session  | `POST /clearSession`     | `POST /api/session/clear`         | 「停止生成」按钮调用                                                             |
| 删除 session  | `POST /deleteSession`    | `POST /api/session/delete`        | 删除对话时调用                                                                |
| 调用结果反馈      | `POST /feedback`         | `POST /api/feedback`              | 消息上的 👍 / 👎 调用                                                        |
| 工具异步回调      | `POST /taskFinishNotice` | `POST /api/tool/taskFinishNotice` | 供外部工具体系回调                                                              |

> 另有一个**不对应任何网关接口**的本地路由：`POST /api/model/chat`。
> 它把浏览器发来的对话历史转成 OpenAI 兼容的 `POST {baseUrl}/chat/completions`，
> 再把厂商响应**归一化成与上面完全相同的一套 SSE 事件** —— 所以前端渲染管线两条链路完全复用。
> 详见 [六、大模型配置](#六大模型配置openai-兼容)。

鉴权统一由服务端加 `Authorization: Bearer <本次调用用的 APP_KEY>`。  
该 key 由 `gatewayFor()` 现算：**环境变量 > 智能体自己的 `apiKey` > 全局 `gateway.apiKey`**（见第五节）。

### 发往网关的完整请求头

抓包实测（用探针脚本起一个假网关 + 独立实例，把两跳的 method / URL / header / body 原文打印出来；  
探针已归档，见第十节）。**`createSession` 与 `run` 两个请求的请求头完全一致**：

代码里写死的只有 3 个（`server.mjs` 的 `gatewayFetch()`）：

```http
Authorization: Bearer <gateway.apiKey>
Content-Type: application/json
Accept: text/event-stream, application/json
```

其余由 Node 的 `fetch`（undici）自动补：`host`、`connection: keep-alive`、`accept-language: *`、  
`sec-fetch-mode: cors`、`user-agent: node`、`accept-encoding: gzip, deflate`、`content-length`。

服务端之间的调用**没有** `Origin` / `Referer` / `Cookie`。

> **业务参数不进请求头。** 链接参数（如 `?eventNum=SJ123`）只会出现在请求体里：  
> ① 拼进 `message.text`（末尾追加「【链接传入参数】」清单）；② 写进 `message.metadata`。  
> 同理 `agentVersion`、`stream` / `delta` / `trace` 也都是 **body 字段，不是 header**。
>
> 所以在 Apifox 里复现这个调用，只需要上面那 3 个头。

### 请求体示例（`POST /run`）

```json
{
  "sessionId": "<createSession 返回的 uniqueCode>",
  "stream": true,
  "delta": true,
  "trace": true,
  "message": {
    "text": "你好\n\n【链接传入参数】\n- eventNum: SJ12343542352",
    "metadata": {
      "eventNum": "SJ12343542352",
      "_source": "http://127.0.0.1:5178",
      "_url": "http://127.0.0.1:5178/?agent=service&eventNum=SJ12343542352",
      "_agent": "service",
      "_ts": "2026-09-23T02:53:58.031Z"
    },
    "attachments": []
  }
}
```

### 流式响应归一化

网关原始帧格式较杂（`message.delta` 的正文可能在 `content[0].text.value`、也可能在根级 `content` 字符串或 `data` 字段），服务端统一归一化为 5 种事件：

| 事件        | 载荷                                          | 前端行为               |
| --------- | ------------------------------------------- | ------------------ |
| `meta`    | `{sessionId, requestId, taskId, messageId}` | 更新会话 ID、记录反馈所需的 ID |
| `delta`   | `{text}`                                    | 追加到回答气泡（打字机效果）     |
| `thought` | `{text}`                                    | 追加到「思考过程」折叠区（纯文字标题，不带图标）    |
| `image`   | `{images:[{url,name}]}`                     | 渲染图片               |
| `error`   | `{message}`                                 | 红色错误气泡 + 提示        |
| `end`     | `{message, thought, ...}`                   | 收尾（`end:true` 帧触发） |

非流式响应（`stream:false`）也走同一套事件，`/run` 会根据 `Content-Type` 自动分支。

---

## 五、大模型配置（OpenAI 兼容）

除网关智能体之外，侧栏最上方还有一栏**大模型**：直连任意 OpenAI 兼容的 `/chat/completions`，
配置文件里**没有** `agentCode` / `agentVersion` —— 它不建网关会话，自然也不需要这两个东西。

> **与智能体的根本差别**：智能体走网关 `createSession` + `sessionId`，**上下文由网关侧维护**；
> OpenAI 兼容接口是**无状态**的，每一轮都要把**完整历史**发过去。
> 这层差异在服务端与前端各收敛一处，界面上两条链路共用同一套 SSE 事件和同一个渲染管线。

### 5.1 配置文件 `config/models.json`

```json
{
  "default": "general",
  "models": [
    {
      "id": "general",
      "name": "通用大模型",
      "model": "qwen-plus",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "apiKey": "sk-xxxxxx",
      "icon": "chip",
      "accent": "#4f8cff",
      "description": "OpenAI 兼容接口 · 通用问答",
      "system": "你是一个专业、严谨的助手，回答尽量简洁准确。",
      "temperature": 0.7,
      "maxTokens": 2048
    }
  ]
}
```

改完保存**刷新页面即生效**（与 `agents.json` 同一套 mtime 热重载，不用重启）。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 唯一标识。链接参数 `?model=` 优先按它匹配，也接受 `model` 名 / 显示名 / 大小写不敏感的 id |
| `name` | ✅ | 侧栏条目与顶栏徽章上显示的名字 |
| `baseUrl` | ✅ | OpenAI 兼容地址。填到 `/v1` 即可，服务端会自动补 `/chat/completions`；直接写到 `/chat/completions` 也认 |
| `model` | | 真正发给厂商的模型名（如 `qwen-plus` / `deepseek-chat`）；留空则退回用 `id` |
| `apiKey` | | 厂商密钥，**不会下发到浏览器**（见 6.3） |
| `icon` | | `agent-icons.js` 里的键，大模型默认用 `chip`（芯片） |
| `accent` | | 品牌色，图标描边与底光跟着换 |
| `description` | | 侧栏副标题，单行省略号（可用宽度同智能体，见第五章末尾） |
| `system` | | 系统提示词，每一轮自动注入到 `messages[0]` |
| `temperature` / `maxTokens` | | 采样温度 / 最大输出。请求体里带同名参数时**以请求体为准**，否则用这里的值 |

`default` 指向默认选中的大模型；指向不存在的 id 时自动回落到数组第一个（与智能体同一套校验）。

#### 配多个模型

`models` 是数组，**直接往后加即可**，条数没有上限 —— 侧栏按数组顺序自上而下列出，
每个模型有自己独立的 `apiKey` / `baseUrl` / `system` / `temperature`，互不影响。例如两家并存：

```json
{
  "default": "deepseek",
  "models": [
    {
      "id": "deepseek", "name": "DeepSeek", "model": "deepseek-v4-pro",
      "baseUrl": "https://api.deepseek.com/v1", "apiKey": "sk-deepseek-…",
      "icon": "chip", "accent": "#4f8cff", "description": "厂商 A · 通用问答",
      "system": "你是一个专业、严谨的助手。", "temperature": 0.7, "maxTokens": 2048
    },
    {
      "id": "qwen", "name": "通义千问", "model": "qwen-plus",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1", "apiKey": "sk-qwen-…",
      "icon": "sparkle", "accent": "#e0533f", "description": "厂商 B · 长文档"
    }
  ]
}
```

- **每家用自己的 key**：请求打到哪个地址、带哪把 `Authorization`，由该条自己的字段决定（已实测核对）。
- **`icon` 只能取 `agent-icons.js` 里已有的键**：目前是 `chip` / `sparkle` / `water` / `waterReport` /
  `flood` / `floodReport` / `trace` / `user`。填了不认识的键会落到一个通用兜底图标，**不会报错**。
  （`avatar` 字段目前**不生效** —— 条目渲染只用 `icon` + `accent`。）
- **`accent` 用不同颜色**更容易在侧栏一眼区分；它同时决定条目头像与顶栏强调色。
- **别用环境变量配多模型**：`AGENT_MODEL_APP_KEY` / `AGENT_MODEL_BASE_URL` 是**全局覆盖**，
  一旦设置就会把**所有**模型都指到同一把 key + 同一个地址（见 6.2）。
- 链接点名写 `?model=<id>`，如 `?model=qwen`；也接受服务商模型名（`qwen-plus`）或显示名。

### 5.2 环境变量（排障用，优先级最高）

| 变量 | 作用 |
| --- | --- |
| `AGENT_MODEL_APP_KEY` | 覆盖**所有**大模型的 `apiKey` |
| `AGENT_MODEL_BASE_URL` | 覆盖**所有**大模型的 `baseUrl` |

与智能体那套（`AGENT_APP_KEY` / `AGENT_BASE_URL`）**完全独立、互不干扰**，
所以可以只把大模型指到本地假服务、智能体照旧打真实网关：

```bash
AGENT_MODEL_BASE_URL=http://127.0.0.1:5199/v1 AGENT_MODEL_APP_KEY=test PORT=5190 node server.mjs
```

### 5.3 密钥不下发浏览器

`/api/config` 里的模型条目只有 `hasOwnKey` / `hasOwnBaseUrl` 两个布尔位；
`apiKey` / `baseUrl` / `system` 由 `readModelsConfig()` 单独放进服务端内部的 `secrets`，
**与公开字段物理分开** —— 浏览器那侧拿不到，连拼错的余地都没有。

启动日志逐个交代凭证来源（脱敏，只留前 3 后 4），与智能体那段分开打印：

```text
各大模型凭证：
  · 通用大模型：独立 key sk-****cdef ／ https://dashscope.aliyuncs.com/compatible-mode/v1 ／ 已配 system
```

### 5.4 协议适配范围

服务端把厂商响应**归一化**成本项目统一的 SSE 事件（`meta` / `thought` / `delta` / `end` / `error`），
前端渲染管线两条链路完全复用。目前覆盖：

| 上游返回 | 处理 |
| --- | --- |
| 流式（`stream: true`） | 逐帧解析 `data:` 行，遇 `[DONE]` 收尾；`choices[0].delta.content` → `delta` |
| 非流式（`stream: false`） | 整包 JSON，取 `choices[0].message.content` 一次性推出去（走同一套事件） |
| 思维链 | `delta.reasoning_content`（DeepSeek / Qwen 等）→ `thought`，在气泡上方折叠区展示 |
| 缺 key | 明确报错并**点名**是哪个大模型缺，不静默发一个空凭证出去 |
| 未知模型 id / `messages` 为空 | 直接 400，不往上游发请求 |

### 5.5 baseUrl 别填成「Anthropic 兼容」入口

**这是最容易踩的一个坑。** 不少厂商同时提供两套兼容接口，**路径不同、协议也不同**
（Anthropic 用 `POST /v1/messages` + `x-api-key` 头，不是 `POST /chat/completions` + `Bearer`）。
DeepSeek 就是典型：

| 厂商 | OpenAI 兼容（**本项目用这个**） | Anthropic 兼容（**不能用**） |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` 或 `https://api.deepseek.com/v1` | `https://api.deepseek.com/anthropic` |

填成 Anthropic 入口时，本服务会拼出 `.../anthropic/chat/completions`，上游返回
**404 且响应体为空** —— 很容易被误判成「网络不通」或「没有权限」，然后在错误的方向上排查半天。
所以报错会把三样一起摊开（状态码 / **实际请求的 URL** / 上游原文，空也要说明是空的）：

```text
大模型接口返回 HTTP 404（上游响应体为空，没给原因）
请求地址：https://api.deepseek.com/anthropic/chat/completions
⚠️ baseUrl 指向的是 Anthropic 兼容入口，本服务只支持 OpenAI 兼容接口（{baseUrl}/chat/completions）。
把结尾的 /anthropic 去掉即可，例如 https://api.deepseek.com
```

启动日志也会**提前预警**，不用等第一条消息失败才发现：

```text
    · Deepseek V4 Pro（deepseek-v4-pro）：key sk-****caf4 ／ https://api.deepseek.com/anthropic／带 system 提示词
    ⚠️ Deepseek V4 Pro：baseUrl 是 Anthropic 兼容入口（https://api.deepseek.com/anthropic），
    本服务只支持 OpenAI 兼容接口，请去掉结尾的 /anthropic（如 https://api.deepseek.com）
```

**模型名要写厂商的 API id，不是界面上看到的显示名。** DeepSeek 的实际 id 是
`deepseek-flash` / `deepseek-v4-pro`（`deepseek-chat`、`deepseek-v4-flash` 仍被接受，实际由新模型服务）。
写成 `deepseek-v4-pro[1m]` 这种带后缀的写法会直接 400，且上游会把可用名字列给你：

```text
The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4-pro[1m].
```

拿不准就列一下（`GET {baseUrl}/models`，**不消耗 token**，也不会因为模型名写错而失败）：

```bash
curl https://api.deepseek.com/models -H "Authorization: Bearer $DEEPSEEK_API_KEY"
```

> **顺带记住 DeepSeek V4 默认开思考模式**：`reasoning_content` 会先占用输出预算。
> 若 `maxTokens` 给得很小（例如 16），可能出现「思考区有内容、正文是空的」——
> 这不是链路故障，把 `maxTokens` 调大即可（模板默认 2048）。思考内容会走 `thought` 事件展示在气泡上方。

### 5.6 会话与历史

- 大模型会话与智能体会话**共用「历史对话」一栏**，条目副标题标明来源，见第八章。
- **会话归属由 `kind` + `agentId` 两个字段共同决定**（模型会话的 `agentId` 里存的是 `models.json` 的 `id`）。
  新建会话时两者必须**同源**，否则会造出「`kind:'model'` 却把智能体 id 写进 `agentId`」的坏会话：
  历史里显示成「未知大模型」，点进去发消息还会被判为孤儿、**一条都发不出去**
  （提示让用户去点「＋ 新建」，点了还是坏的 —— 死循环）。这不是假设，是真实踩过的坑，
  所以三个新建入口（「＋ 新建」按钮 / 删掉最后一个会话 / 清空全部对话）统一走
  `newConversationForCurrent()`，而 `startNewConversation()` 在 `ownerId` 缺省时按**侧栏当前选中的对象**兜底，
  **绝不写死 `state.settings.agentId`**。
- 大模型会话**不显示 👍 / 👎**（网关 `/feedback` 专属能力），复制与重答照常可用。
- 切换大模型时自动切到该模型的最近一次会话，没有则新建 —— 与切换智能体行为一致。
- **打开页面时默认选中谁**：先看上次用过的类型，没记录时**优先智能体**，只有智能体一个都没配才落到大模型。
  所以「智能体 + 大模型」并存的部署里，刷新后停在智能体上，要跟大模型说话需点一下大模型栏
  （或用 `?model=` 点名）。这是有意的：老用户的默认场景仍是智能体。
- **「停止生成」只中断本地连接**：模型链路没有 session，不需要（也没有）`clearSession` 可调。

---

## 六、多智能体配置

编辑 `config/agents.json`：

```json
{
  "default": "service",
  "agents": [
    {
      "id": "service",
      "name": "防汛事件处置建议",
      "agentCode": "e36a0ab1-b673-49d0-9a2c-000000000002",
      "agentVersion": "",
      "avatar": "🌊",
      "icon": "flood",
      "accent": "#22c55e",
      "description": "生成对应事件的处置建议方案",
      "welcome": "您好，这里是防汛事件处置建议，请描述需要处置的事件情况。",
      "suggestions": ["我要查询办理进度"],
      "urlTemplate": "【用户信息】姓名：{user}｜手机号：{phone}\n【问题】{question}",
      "defaultParams": { "biz": "综合咨询" },
      "background": "aurora"
    }
  ]
}
```

改完保存，刷新页面即生效（配置带 mtime 缓存，无需重启）。

- `agentCode` 必填，就是创建 session 用的智能体编码；`agentVersion` 留空则走默认版本。
- **`icon` 决定界面上画哪张图**，取值是 `public/js/agent-icons.js` 里 `AGENT_ICON_PATHS` 的键。  
  界面上所有图形化的头像（侧栏条目 / 顶栏徽章 / 消息头像 / 欢迎页大图标）都渲染这个内联 SVG，  
  描边色跟随同一条目里的 `accent`；`avatar` 那个 emoji 现在只作为纯文本场景与老配置的兜底。  
  图标 id 写错会退回一个默认图标，不会白屏。
- `status`（可选）会在侧栏名称旁渲染一枚小标签，如 `"status": "建设中"`。  
  ⚠️ **`server.mjs` 的 `getAgents()` 是显式字段白名单**：往 `agents.json` 加任何新字段，都必须同时加进那里，  
  否则会出现「配置文件明明改了、前端却拿不到」（加 `status` 与 `icon` 都各踩过一次，  
  `/api/config` 里直接没有这个键）。唯一的例外是**敏感字段** —— `apiKey` / `baseUrl`  
  既不该也不可能下发到浏览器，它们走另一条只在服务端内部使用的通道（见下文）。
- 每个智能体独立的背景（`background`）与默认参数（`defaultParams`）。
- 切换智能体会自动切到该智能体的最近一次会话，没有则新建。
- **`name` / `description` / `welcome` / `suggestions` 都是纯业务文案，随便改**：代码与测试只依赖 `id`。
- **状态别拼进 `name`**。名称那一行是单行省略号，把「（建设中）」写进名字会直接吃掉可用宽度：  
  实测 `水污染事件辅助溯源（建设中）` 需 182px，而嵌入态侧栏只有 173px，尾巴必被截掉；  
  拆成 `status` 标签后名字只占 117px（余量 56px），标签本身也不会被省略。
- **名称与描述都是单行省略号，各自可用宽度 = 侧栏宽 − 80px**（独立页 268px → 188px，嵌入 252px → 172px）。  
  按名字 13px / 描述 11px 算，中文分别别超 14 字和 15 字。超了要么缩短文案，要么同步调  
  `html[data-embed]` 的 `--sidebar-w`。侧栏文案探针（已归档，见第十节）会直接报出  
  「需 xx px / 可用 xx px」的差额，不用靠肉眼判断。

### 每个智能体用自己的 APP_KEY

不同智能体可能属于不同的应用，各自有独立的密钥。给某个智能体加一个 `apiKey`，它就会用自己的那把：

```json
{
  "id": "service",
  "name": "防汛事件处置建议",
  "agentCode": "5180b4b5-ebac-48f2-a213-dc03b338075b",
  "apiKey": "这个智能体专属的 APP_KEY",
  "baseUrl": "http://23.210.227.120/xlm-gateway-ftlzsf/sfm-api-gateway/gateway/agent/api"
}
```

取值优先级（`server.mjs` 的 `gatewayFor()`）：

| 来源                                      | 优先级      | 什么时候用                                |
| --------------------------------------- | -------- | ------------------------------------ |
| 环境变量 `AGENT_APP_KEY` / `AGENT_BASE_URL` | **最高**   | 临时排障、跑探针。必须能盖住一切，否则探针会误打真实网关、白烧额度    |
| 智能体自己的 `apiKey` / `baseUrl`             | 中        | 这个智能体有自己的密钥，或者挂在另一个网关入口（不同厂商 / 不同区域） |
| `settings.json` 的 `gateway.*`           | 最低（全局兜底） | 没有单独配置的智能体都走它                        |

要点：

- **两个字段都是可选的**，不配就沿用全局。所以可以只给个别智能体配，其余完全不动。
- **密钥不会下发到浏览器。** `/api/config` 返回的智能体条目里只有 `hasOwnKey` / `hasOwnBaseUrl` 这类布尔标记，密钥本身留在服务端（`readAgentsConfig()` 把它单独放进 `secrets`，与公开字段物理分开）。回归测试会整包扫描 `/api/config` 的响应文本，**出现任何一个 key 明文即失败**。
- **启动日志逐个交代凭证来源**（脱敏，只留前 3 后 4）：
  ```text
    各智能体凭证：
      · 防汛事件处置建议：独立 key 518****075b ／ 全局地址
      · 防汛事件评价复盘：沿用全局 key d2T****hkv0 ／ 全局地址
  ```
- **缺 key 时不会静默发一个空凭证**，而是明确报错并点名是谁缺：
  ```text
  智能体「丁智能体」没有可用的 APP_KEY —— 请在 config/agents.json 给它加 "apiKey"，
  或在 config/settings.json 配全局 gateway.apiKey / 用环境变量 AGENT_APP_KEY 启动
  ```
- **6 个接口全都按「会话所属智能体」选 key**。`clearSession` / `deleteSession` / `feedback` 只有 `sessionId`，浏览器会额外带上 `agentId`；服务端另有一份 `sessionId → agentId` 的内存记忆做兜底（老版本前端 / 第三方调用）。这些都推不出来时退回全局配置 —— **不会随便挑一个智能体**，那会把别人的专属 key 用到错误的会话上。
- **`apiKey` / `baseUrl` 是故意不进 `getAgents()` 白名单的**（见上文「字段白名单」）。它们是敏感字段，走另一条只在服务端内部使用的通道；往 `agents.json` 加**别的**业务字段仍需同步白名单。
- ⚠️ `apiKey` 是**明文**存在 `config/agents.json` 里的。若要把项目纳入版本管理，先确保忽略 `config/`；管理上不允许落盘时改用环境变量（代价是它是全局的，一把 key 盖住所有智能体）。
- 自查：凭证回归 30 项（**脚本已归档**）—— 自带副本与两个假网关，直接抓假网关实际收到的  
  `Authorization` 头，覆盖「各用各的 key / 会话类接口选对 key / 密钥零泄露 / env 优先级」，不碰真实网关。

### 增删智能体

**只改 `config/agents.json` 就行，不用重启**（配置按 mtime 热重载），刷新页面即可。


**加一个**：往 `agents` 数组追加一条，保证 `id` 唯一。若新加的是自定义字段，  
记得同步加进 `server.mjs` 的 `getAgents()` 白名单（见上）。

**删一个**：从数组里删掉那条即可。相关行为已有回归锁（19 项，**脚本已归档**）：

| 情况                            | 行为                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| 该智能体已有的旧会话                    | 变成「孤儿」：**侧栏里仍看得到**（副标题显示「未知智能体」，不会凭空消失），但点进去后**发消息会被拦住**并弹明确提示 —— 不会静默把消息发给别的智能体        |
| 删掉的正好是 `default` 指向的          | 服务端自动回落到数组第一个（`getAgents()` 会校验 `default` 是否真实存在）；**仍建议顺手把 `default` 改成真实存在的 id**，语义更清楚 |
| `icon` / `background` 指向不存在的值 | 退回默认图标 / 默认背景，不会白屏                                                                      |
| 该智能体的 `data/history/*.json`   | 不会自动清理（服务端历史只是 localStorage 的备份，不参与侧栏渲染）。要清可手动删 `data/history/` 里 `agentId` 匹配的那些文件     |

> 想按 id 定位侧栏条目（自己写脚本时）：智能体条目 `.pick-item[data-agent]`、大模型条目 `.pick-item[data-model]`、
> 会话条目 `.conv-item[data-agent]`（会话还带 `data-kind` 区分来源是智能体还是大模型）。  
> **别用 `:nth-child(N)`** —— 增删一个智能体就整体错位。

---

## 七、链接带参调用（核心能力）

打开形如下面的链接，参数会自动拼进提问内容并随 `metadata` 一起交给智能体：

```
http://127.0.0.1:5178/?agent=service&q=我的业务办到哪一步了&user=张三&phone=13800001111&biz=社保转移&bg=aurora
```

### 保留参数

| 参数（别名）                                                     | 作用                                           |
| ---------------------------------------------------------- | -------------------------------------------- |
| `model` / `modelId`                                        | 选择大模型，支持 **id、模型名、显示名** 三种写法                  |
| `agent` / `agentId` / `code` / `agentCode`                 | 选择智能体，支持 **id、agentCode、名称** 三种写法            |
| `q` / `prompt` / `query` / `message` / `text` / `question` | 自动提问的内容                                      |
| `bg` / `background`                                        | 背景：预设 id（`midnight`/`aurora`/`grid`…）或图片 URL |
| `theme`                                                    | `dark` / `light`                             |
| `veil` / `blur`                                            | 遮罩不透明度 0–95 / 背景模糊 0–24                      |
| `title`                                                    | 会话标题（仅在新建会话时生效）                              |
| `sys` / `suffix`                                           | 在提问前后追加的固定文本                                 |
| `autosend=0`                                               | 只带入参数、不自动提问                                  |
| `new=1`                                                    | 强制新建会话                                       |

**其余任意参数**（如 `user`、`phone`、`biz`、`dept`…）都会被收集为业务参数。

> **`?model=` 与 `?agent=` 同时出现时以大模型优先。** 完整优先级：
> `?model=` > `?agent=` > 上次用过的种类 > 服务端默认 > 列表第一个。

> **链接里点名的栏位，即使配置关掉了也强制显示。**
> `config/settings.json` 把 `ui.showModels` / `ui.showAgents` 设成 `false` 时，对应那一栏默认收起；
> 但只要链接里显式带了 `?model=xxx` / `?agent=xxx`，**该栏就会展开、并选中被点名的那个对象** ——
> 链接是外部系统拼的，不能因为本地关了一栏就把人家指名的目标藏起来。
> 反向不成立：链接没点名的那一栏，仍按配置隐藏。
> （前提是这个对象真实存在；`models.json` 里一个模型都没配时，光带参数不会凭空造出一栏。）

### 参数如何传给智能体

1. **拼进 prompt**：智能体配了 `urlTemplate` 就按模板渲染，否则追加到提问末尾：
   ```
   我的业务办到哪一步了

   【链接传入参数】
   - user: 张三
   - phone: 13800001111
   - biz: 社保转移
   ```
2. **同时写入 `message.metadata`**：结构为 `{...defaultParams, ...链接参数, _source, _url, _agent, _ts}`，智能体侧可直接读取。

> **链接业务参数只对智能体生效。** 大模型链路没有 `metadata` 这个概念（OpenAI 接口只认 `messages`），
> 所以 `?model=general&q=你好` 能选中模型并自动提问，但 `user` / `eventNum` 这类参数**不会**随请求发出去。
> 界面上的「链接参数」抽屉对大模型会话会直接写明「输入框内容原样发送」，不做无声的假承诺。

界面上「链接参数」抽屉页里能看到本次带入的参数、拼装后的 prompt 预览，以及**可复制分享的链接**。
分享链接会按**当前会话的归属**还原参数 —— 智能体会话出 `?agent=`，大模型会话出 `?model=`。


> **抽屉的入口只有一个**：侧栏品牌区右侧的 `⚙`（打开后默认落在「设置」页）。背景、链接参数、设置三块内容由抽屉顶部的三个切页切换 —— 侧栏底部原来那排「🎨 背景 / 🔗 链接参数 / ⚙️ 设置」按钮与之完全重复，已删除。

### 抽屉里两道「内容撑破容器」的坎（都踩过，改动前先读）

抽屉内容区宽 = `--drawer-w − 32px`（独立打开 380→348px；嵌入模式 340→308px；860px 以下 `--drawer-w: 100vw`）。
凡是往抽屉里塞**横向不可缩**的东西，都会把内容顶出边界 —— 而且 `drawer-body` 只写了 `overflow-y: auto`，
按规范 `overflow-x` 会**计算成 `auto`**，于是底部多出一条横向滚动条，同时右侧内容被裁掉。

1. **`<input>` 在 grid / flex 里必须先解除固有宽度**（「手动补充参数」那一行踩过）。
   `<input>` 带默认 `size=20`，固有宽度约 **174px**；而 grid 子项的 `min-width: auto` 正是取这个固有宽度当最小尺寸，
   所以哪怕写成 `1fr` 也缩不下去（`1fr` = `minmax(auto, 1fr)`）。
   两个输入锁死 348px，加按钮与间距约 **420px**，比抽屉可用宽度还大 → 「添加」被挤出可视区，
   且 `auto` 轨道被压到极窄后按钮文字会**断成上下两行**。
   修法：`input[type='text'] { min-width: 0 }`（全局兜底）+ `grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto`
   + 按钮 `white-space: nowrap`。实测修复前 → 修复后：嵌入 340 抽屉按钮溢出 **89px → 0**，手机 390 溢出 **39px → 0**。
2. **参数行的「参数名」也要能被压扁**（`?` 带一个长参数名就踩到）。
   `code` 里没有可断行的位置（`_` 不是断行点），`min-width: auto` 同样把它顶住 → 实测 44 字符的参数名让整行溢出
   **257px（390 视口）/ 307px（嵌入 340）**。修法：`code` 与 `span` 都加 `min-width: 0` + 省略号，
   并给 `code` 加 `max-width: 50%`（参数值通常比参数名长，剩下的一半留给它）。

> 顺带一个**不是** bug 的现象：`input[type='range']`（遮罩 / 模糊滑条）带 Chrome UA 的 `margin: 2px`，
> 会伸进 16px 内边距里 2px。不裁切、不产生滚动条，写探测器时拿「内边距盒」当判据即可，别拿「内容盒」误报。

> 自动提问类参数（`q`/`agent` 之外的一次性参数）在发送后会从地址栏摘除，**刷新页面不会重复提问**；原始链接保存在内存中，「复制链接」仍能完整还原。

---



## 八、其他功能

**历史对话**：双份保存 —— 浏览器 `localStorage`（主） + 服务端 `data/history/*.json`（备份）。刷新、关页面、换设备都能找回；支持新建、回切、删除（同时删除服务端 session）、导入/导出 JSON、导出 Markdown。

大模型的会话与智能体会话**共用这一栏**，条目副标题标明来源（`大模型 · 通用大模型` / `智能体 · 防汛事件处置建议`）。
会话记录里用 `kind` 字段区分来源，老数据没有这个字段时一律按 `agent` 处理。

删除行为：删掉**当前**会话时会自动切到最近更新的那条，不会生成一个同名的空白「新对话」；侧栏始终保留至少一条，删到只剩一条时再删会自动补一个空白会话。删除确认用内部弹层，不依赖 `window.confirm`（原因见 9.4）。

**背景**：10 套内置预设 + 自定义图片（本地读取，≤4MB）+ 遮罩/模糊滑条。**直接把图片拖到聊天区**即可设为背景。

**多轮对话**：智能体链路只在首轮创建 session，后续复用同一个 `sessionId`，上下文由网关侧维护；
大模型链路**没有 session**（OpenAI 接口是无状态的），每一轮由前端把**完整历史**整段回传。
前端把这两套差异收敛在同一处，上层用起来没有区别。

**主题与默认配色**：三套内置主题 —— `cockpit`（驾驶舱 / 政务大屏）、`dark`（深色）、`light`（浅色）。切换入口在设置抽屉的「外观 → 主题」。

- **驾驶舱主题**从一张真实的水利大屏参考图取色（用 Pillow 做像素级量化取色，不是肉眼估色），色板收在 `style.css` 的 `[data-theme='cockpit']` 变量块里。核心特征有两点：一是标题条**不是单向渐变，而是两侧深蓝、中间青绿高光的对称发光条**（扫描参考图得到 `#0a344c → #0168a7 → #04a988 ← #007bb0 ← #14304a`）；二是标题条两端各一枚指向外侧的青色箭头（`--chevron` 内联 SVG，右端用 `scaleX(-1)` 镜像），窄于 860px 时自动收起以免挤掉标题。
- 亮青底（`--accent: #22c2e8`）上的文字必须用深色（`#032230`），白字对比度只有 1.9:1，不可读。这条已固定在 CSS 里，改主题时别把 `color` 改回白。
- 侧栏品牌区（`.brand`）与主区顶栏（`.topbar`）是**并排的两条「标题条」**，高度由 `--bar-h` 统一钉死（独立打开 58px、嵌入模式 50px）。两者内容高度本来就不同（品牌区 34px 的 logo vs 顶栏 32px 的徽章文字），所以**不要用各自的上下 padding 去凑高度** —— 调竖向间距请只改 `--bar-h`，改横向间距才动 padding。这两条一旦差几 px，并排看就是明显错位（历史版本差了 8px）。
- 品牌区右侧**只有一枚图标**：`⚙`（`.brand-settings`，id `btnOpenSettings`，打开抽屉）。它必须**常显**，不许套「只在 `html[data-embed]` / `max-width:860px` 才 `display:grid`」那类规则 —— 侧栏底部那排按钮删掉之后，它是进设置 / 背景 / 链接参数的**唯一**入口，一隐藏就再也进不去。
  ⚠️ 品牌区**不要再放第二枚图标**：曾经在这里加过一枚 `⇤`（收起侧栏），与 `⚙` 并排两个图标挤在一起，视觉上就是重复的，用户直接要求撤掉了。**侧栏的收起 / 展开统一由主区顶栏的 `☰` 负责**，一个开关管一个动作的两个方向。
- ⚠️ **踩过的坑：顶栏 `☰` 曾带 `only-mobile`，而 `only-mobile` 的规则是「宽屏 `display:none`，≤860px 或嵌入模式才显示」—— 于是宽屏下侧栏既收不起来、也展不开。** 当时删掉品牌区那枚「收起侧栏」，理由写的是「与顶栏 `☰` 功能重复」，可这个前提在宽屏压根不成立（`☰` 是隐藏的），两个入口就这么一起没了。现在 `☰` **常显**（`index.html` 上不再有 `only-mobile`），`.only-mobile` 这个类已无使用者，**别再往任何按钮上加**。
  改这块时记住这条约束：**任何状态下都要有办法收起 / 展开侧栏，而且不要为了它再摆一枚同功能的图标**。宽屏（侧栏正常占位）由常显的 `☰` 双向负责；窄屏 / 嵌入容器的浮层形态下侧栏会盖住 `☰`，那时靠**点主区一下或按 Esc** 收起（`app.js` 的 `bindOverlaySidebarDismiss()`）——它判的是实测 `position: fixed`，所以嵌入容器够宽、侧栏变回正常占位时自动不生效，点消息不会莫名跳版。
  **浮层场景下没有可见按钮，这是刻意取舍**：要摆按钮只能放品牌区，而那里并排两枚图标看着就是重复（用户否掉过一次）。真要补可见入口，请补在顶栏（像 ☰ 那样），别再放回品牌区。
  三个改动侧栏状态的入口 —— `☰`、宿主 postMessage `set-sidebar`、链接 `?sidebar=0` —— 统一走 `setSidebarCollapsed()`（`app.js`），它顺手同步 `aria-expanded`；**不要再各处直接 `classList.add('collapsed')`**，那样读屏用户听到的状态会停在旧值。
- 品牌区标题（`.brand-text strong`，`#brandTitle`）是**自适应**的，由 `updateBrandTitle()` 写：只有大模型 → 「大模型对话」；只有智能体 → 「智能体对话」；**两者都有 / 都没有 → 「AI对话」**。判据取**分区此刻是否真的显示**（读 `applyRegions()` 刚挂上的 `data-hide-*`），不是「配置文件里各配了几条」—— 所以把 `ui.showAgents` 关掉后，哪怕 `agents.json` 里还躺着 5 个智能体，标题也会如实变成「大模型对话」；反过来链接用 `?model=` 点名强制显示大模型时，标题同样跟着变成「两者都有」。这样判定只存在一处（`applyRegions`），不会出现「标题说有、侧栏却没有」的两套口径。`index.html` 里的静态首屏文字写**中性默认值**「AI对话」，免得在只有大模型的部署里先闪一下「智能体对话」。
- 侧栏三栏 **大模型 : 智能体 : 历史对话 = 1.5 : 3.5 : 5**（品牌区以下的可用高度按这个比例分；`flex-grow` 允许小数，不必为了取整把数字放大成 3:7:10 之类）。这块由四条约束共同保证，**动其中任何一条都会立刻偏**：
  1. **比例必须加在「外层壳」上，不能加在列表本身。** 现在的结构是两层：
     `.list-wrap`（`flex: 1.5|3.5|5 0`、**padding 为 0**）套着 `.model-list` / `.agent-list` / `.conv-list`（`flex: 1 1 auto`、自带 padding 与滚动）。
     原因：`flex-basis: 0` 时**内边距不参与 flex 分配**。一层写法里每个块自己的竖向 padding（`4px` + `12px` = 16px）会被排除在基准之外，
     于是可分配空间先缩水 3×16 = 48px、再按比例分、最后各自把 16px 加回去 ——
     1280×820 视口（可用高度 644px）下实测 **105.4 / 224.6 / 314.0**，比例已经跑偏。
     拆成两层后是 **96.6 / 225.4 / 322.0**，与 1.5:3.5:5 的理论值逐项吻合；
     换 1440×900 视口复测同样吻合（实测 **108.6 / 253.4 / 362.0**，误差 0.0）。
     一层的偏差恒为 **−8.8 / +0.8 / +8.0 px**（= 各自 share × 48 − 16，与容器高度无关），
     所以容器越高越看不出来、窄屏反倒最明显 —— 这也是当初只在窄视口才暴露出问题的原因。
  2. 三条小标题 `.section-title` 高度由 `--sec-h` 钉死（独立 38px / 嵌入 32px），**竖向 padding 必须为 0**。第三行比前两行多一个「＋ 新建」按钮，靠内容撑高会硬生生多 6px。
  3. 三个列表都写 `flex: 1 1 auto; min-height: 0`。**`min-height: 0` 不能省** —— 少了它，内容一多就把整块往下撑，比例立刻失效；有了它才是各自在框内滚动。
  4. 三个列表的 **padding 必须完全一样**（现在都是 `4px 8px 12px`）。差 8px 最终高度就差 8px（旧版实测过：385 vs 393）。
  改完别盯截图猜，直接量三个 `.list-wrap` 的高度比 —— 侧栏结构探针会打印实测值（**脚本已归档**，方法见第十章）。

**默认配色怎么改**（改的是「没带任何参数、用户也没手动选过」时的表现）：

| 想改什么              | 改哪里                                                                 |
| ----------------- | ------------------------------------------------------------------- |
| 服务端下发的默认          | `config/settings.json` → `ui.defaultTheme` / `ui.defaultBackground` |
| 首屏 HTML 兜底（防闪旧配色） | `public/index.html` 的 `<html data-theme="…">`                       |
| 前端最终兜底            | `public/js/app.js` 的 `FALLBACK_THEME` / `FALLBACK_BG`               |
| 单个宿主指定            | 链接参数 `?theme=cockpit&bg=cockpit`，或 postMessage 下发 `set-visual`      |

生效优先级是 **链接参数 > 用户显式选择 > 服务端默认 > 前端兜底**。

> **一个容易踩的坑**：本地 `localStorage` 里存着的旧主题会永久盖住服务端新默认值，改了 `settings.json` 却不生效。所以 `DEFAULT_SETTINGS` 里 `theme` / `bgId` 默认是**空串**，含义是「跟随服务端」；只有用户真的点过主题按钮，才会写 `themeExplicit: true` 把它钉住。清掉这个标记（或清 localStorage）即可让它重新跟随服务端。

**智能体 / 大模型图标**（`public/js/agent-icons.js`）：所有图标都是**内联 SVG**，不是 emoji —— emoji 由系统字体渲染，Windows / macOS / Android 三套字形不同、尺寸与基线不受控（历史上 💧 这种 ZWJ 组合 emoji 还渲染成过两个图标），而且没法跟随 `accent` 与主题换色。四处头像（侧栏条目 / 顶栏徽章 / 消息 / 欢迎页大图标）共用同一套：**品牌色柔光底 + 同色描边 + 同色线性图标**，描边走 `currentColor`，容器上的 `--a` 由 `app.js` 按 `accent` 写入，所以改配置里的 `accent` 就能整块换色，三套主题零成本跟随。用户自己的头像是**同一套线性 SVG 里的中性人形**（圆头 + 半圆肩），刻意不跟品牌色抢注意力 —— 它和其余图标（含大模型那枚 `chip`）唯一的差别就是配色。

- **设计语言：「外轮廓 = 动作，内部符号 = 领域」** —— 星芒（通用咨询）/ 盾牌（处置 ×2）/ 文档（评价复盘 ×2）/ 放大镜（溯源）。防汛处置是「盾 + 波浪」、水污染处置是「盾 + 水滴」、防汛复盘是「文档 + 折线」、水污染复盘是「文档 + 水滴」；于是「防汛」的图标里都有波浪或折线，「水污染」的图标里都有水滴 —— 侧栏里一眼能看出哪几个是同一领域的，动作则靠外轮廓分辨。改图标时**请保住这个结构**，别让两个图标的外轮廓与内部符号同时雷同。
- **大模型用的 `chip`（芯片）**：圆角方框 + 四周 8 根引脚 + 中心圆点。同样不用具象的「大脑」，理由和下面星芒那条一模一样；
  而芯片的**外轮廓（方 + 引脚）**在侧栏里与智能体那批（圆、盾、文档、放大镜）一眼可分，不会撞形。
- **「长寿机关大脑」用的是星芒而不是具象大脑**，这是试出来的结论：在 26–34px 的实际渲染尺寸下试过十余版脑形（双圆相交 / 单圆加中缝 / 双半圆拼合 / 带沟回的椭圆…），一律读成「两个环」「地球仪」「洋葱」，还频繁撞形 —— 灯泡缩到 26px 像水滴（撞水污染）、左右双瓣像盾牌（撞防汛）。这个尺寸容不下具象器官，于是回到 AI 产品通用的星芒。**要换回具象脑，只改 `AGENT_ICON_PATHS.sparkle` 那一行路径即可。**
- 每个图标：24×24 网格、图形收在 16×16 安全区内、1.7px 描边、圆头圆角、只描边不填充。想加新图标就往 `AGENT_ICON_PATHS` 里加一个键，再在 `agents.json` 里把 `icon` 指过去（**别忘同步主题回归第 9 节的 `SHAPE_COUNT` 段数表**）。
- 图标尺寸统一是**容器内容盒的 64%**（`--a` 那一段的 `.agent-icon`），三处容器分别是 30 / 34 / 26(rsp.32) px；实测 30px 容器里画 17.9px。尺寸写死在 CSS、不写在 SVG 的 width/height 上，便于换尺寸。
- **用户头像**（`AGENT_ICON_PATHS.user`）不是智能体图标，但共用同一套设计语言，放在同一张表里是为了让调用方统一走 `agentIconSvg()`。人形试过平肩带竖线 / 收窄肩 / 两侧留缺口肩几种，26px 下都退化成不好分辨的小疙瘩，最后用**圆头 + 半圆肩**（肩是 A 弧，弦长 12.8 正好等于直径，两端切线竖直，缩到 16px 也不会塌成一条线）；它与 AI 头像的容器尺寸、占比完全相同，只有配色不同（主题回归第 9 节有断言）。
- ⚠️ **浅色主题必须把 accent 压深一档**（`color-mix(in srgb, var(--a) 58%, #0f172a)`）：这批 accent 是给深色底挑的，橙色 `#f59e0b` 直接放白底上对比度只有 2.1:1、绿色 2.2:1，描边会糊掉。混 42% 深藏青后最差也有 4.26:1（非文本元素阈值 3:1）。**别再往上调**：实测混 36% 时最差的绿色只有 3.23:1，贴着阈值边。
- ⚠️ **头像底色是「面板色混品牌色」，绝不能是「品牌色混 transparent」**：后者会**透出下层**。侧栏有 `.sidebar` 的 `--panel` 兜着，所以这个问题一直没暴露；但**消息区背景是透明的** —— 浅色主题遇上深色背景板时底色被透成暗青绿，深绿描边糊在上面实测只剩 **1.21:1**。现在统一写成 `color-mix(in srgb, var(--a) 14%, var(--panel-2))`，与下层解耦。驾驶舱还额外锚了一次固定深蓝（那里的 `--panel-2` 只有 0.52 不透明度，混出来的底偏亮，这批 accent 里最暗的紫色压上去只剩 2.70:1）；注意那条的选择器必须写 `.msg.assistant .ava`，写成 `.msg .ava` 会把用户头像的中性底一起覆盖。  
  守这条的是主题回归第 9 节两组断言：**AI 头像底色 alpha ≥ 0.7**（根因）+ **消息区两个头像的真实采样对比度 ≥ 3:1**（结果，三主题各测一遍）。

**驾驶舱宿主示例页**：`public/cockpit-host-demo.html` 是一张完整的驾驶舱大屏宿主页（顶部发光标题条、两端青色箭头、青边面板、KPI 卡、待办列表），右列用一个窄 iframe 把对话框嵌进去，可直接对照改到自己的大屏项目里：`http://127.0.0.1:5178/cockpit-host-demo.html`。

**输入区**：只有输入框和发送按钮。输入框**最多长到两行**（`--ta-max-h = calc(2 * 1.6em + 7px)`，两行 22.4px×2 + textarea 上下 padding 3px×2，再多 1px 取整余量），第 3 行起不再长高、改为框内滚动，右侧才出现一条 **6px 细滚动条** —— 一行 / 两行时内容正好装得下，`overflow-y:auto` 天然不渲染滚动条，所以不会出现「只有一行也有一条竖线」。  
📎 附件按钮**常隐**（`#btnAttach { display: none }`），输入框左侧不留任何空位、也不会随焦点淡入；节点本身和「点击后打开附件弹层」的逻辑都保留着（程序化 `.click()` 仍可打开），要恢复入口删掉那一行 CSS 即可。

**消息气泡的高度只由行数决定**：`气泡高 = 行数 × 行高(23.52px) + 上下 padding + 上下 border`，两处细节决定了它成不成立：

- **首尾块级元素的外边距必须折为 0**（`.bubble > :first-child { margin-top: 0 }` / `> :last-child, > p:last-of-type { margin-bottom: 0 }`）。markdown 渲染出来的是 `<p>`，默认带 `margin: 7px 0`，而它的外侧紧贴气泡的 padding —— 这 14px 是纯多余的高度。一行「测试」会因此从 41.5px 涨到 61.5px，宽 58px 时看上去就是个**近正方形的方块**（这正是用户报的「背景太高」）。注意 `:last-child` 之外还要写 `p:last-of-type`：流式输出时气泡末尾会追加 `.cursor`，那时 `:last-child` 是那个 span，末段 `<p>` 的 margin-bottom 会漏折。
- **用户气泡的竖向 padding 比 AI 气泡更紧**（`--bubble-py-user: 8px` vs `--bubble-py: 11px`）。用户消息多半是一两句短话，照 AI 那种富文本的量给竖向留白，短句立刻显胖。两个值都是 token，改一处即可统一调。

实测：单行 58×41.52、2 行 100×65.03、3 行 100×88.55 —— 每多一行正好 +23.52px（= 一个行高），三套主题尺寸完全一致（主题只换颜色，不动 padding）。

3 条容易踩的坑：

- **textarea 的竖向 padding 也在滚动窗口里**：滚动时能露出的行数 = `2 + padding / 22.4`。padding 给 7px 时窗口是 2.6 行，第 3 行能露出大半个字、看着像「装了三行」。所以竖向 padding 只给 3px，呼吸感交给 `.composer` 自己的 8px padding。
- **`autoGrow()` 里的 `+1px` 不能省**：`scrollHeight` 返回整数，一行文字真实高 36.4px（旧 padding 下）却报 36，照 36 设高就等于自己压矮 0.4px，浏览器立刻判定溢出、平白冒出一条滚动条。上限从 CSS 的 `max-height` 现读，别在 JS 里写死数字（历史上 JS 写 180、嵌入 CSS 写 118，互相打架）。
- **检测滚动条不能用 `offsetWidth - clientWidth`**：headless Chromium 用覆盖式滚动条，这个差恒为 0（连消息区也是）。测试里用「内容是否溢出框」等价判断；要看真那条 6px 条，得用探针的**有头模式**（`PROBE_HEADED=1`，脚本已归档）。

**反馈与终止**：每条回答可点赞/点踩（走 `/feedback`，`subject:REQUEST`，`provider.source:USER`），生成中可点「■ 停止」中断（本地中断 + 调 `/clearSession`）。

**工具异步回调**：把下面的地址配置到百炼的异步工具里，工具执行完成后回传结果：

```
POST http://<你的服务地址>/api/tool/taskFinishNotice
{
  "taskId": "<工具被调用时 header key=idx-agent-task-id 的值>",
  "success": true,
  "data": "{\"result\":\"业务数据\"}"
}
```

`data` 必须是 JSON 字符串（服务端会校验）。可在 `settings.json` 的 `tool.callbackToken` 设置校验 token，回调时带 `X-Callback-Token` 头或 `?token=`。

---

## 九、嵌入到 iframe（宿主系统集成）

**可以。** 服务端默认不限制嵌入来源，直接 `<iframe src="…">` 就能用。

### 9.1 两种嵌入模式

| 模式          | 用法             | 布局表现                                                                          | 适用           |
| ----------- | -------------- | ----------------------------------------------------------------------------- | ------------ |
| **compact** | `?embed=1`（默认） | 填满容器；侧栏**默认展开**，容器 ≥620px 时正常占位挤压消息区，窄于 620px 才退化为浮层（此时靠顶栏 ☰ 之外的点主区 / Esc 收起） | 宽高固定的面板 / 抽屉 |
| **auto**    | `?embed=auto`  | 高度跟随内容；隐藏侧栏与抽屉，退化为纯聊天组件                                                       | 嵌在页面正文里的小组件  |

> **为什么侧栏要按容器宽度分两种形态？** 侧栏默认展开，而嵌入容器宽度不受本服务控制。若一律用浮层，窄面板里它会直接**压在消息区上面**，把左半截对话内容盖掉；若一律占位，则窄到 400px 时消息区会被挤得没法看。所以按 620px 分界：够宽就占位（不遮内容），窄了就浮层（不挤内容）。  
> 「点主区 / Esc 收起侧栏」这个抽屉交互只在浮层形态下启用，否则宽容器里点一下对话就会莫名跳版。

被 iframe 引用时会**自动识别**（`window.self !== window.top`），无需手动传参；也可显式传 `?embed=0` 强制关闭。

**侧栏显隐**：默认展开，与直接打开时一致。宿主想要更干净的界面时——

- 静态：`?sidebar=0`（打开即收起）
- 运行时：下发 `set-sidebar` 命令，或宿主 SDK 直接 `chat.setSidebar(true)`

### 9.2 最简接法

```html
<iframe
  src="http://your-host:5178/?embed=1&agent=service&q=我的业务办到哪一步了&user=张三&biz=社保转移"
  allow="clipboard-write"
  style="width:100%;height:640px;border:0"></iframe>
```

`q=` 会自动提问，其余自定义参数照常透传进 `metadata` 和 prompt（**仅智能体链路**，见第七章）。  
换成 `?model=general` 就是嵌一个直连大模型的对话框，此时业务参数不参与拼装（大模型接口没有 `metadata`）。  
注意 `embed` / `parent` / `sidebar` 是结构性保留参数，**不会**被当成业务参数传给智能体。

> **`allow="clipboard-write"` 建议一并写上。** 消息下方的「复制」按钮优先走标准 Clipboard API，  
> 而 `clipboard-write` 的默认授权范围只有 `self`。宿主页与对话框**不同源**时（绝大多数集成都是这样），  
> 少了这个属性，子页的标准复制通道就会被 Permissions-Policy 拒掉。  
> 子页已内置 `execCommand` 兜底，缺了它按钮通常仍然可用；但写上才是零风险接法。详见 9.7。

### 9.3 postMessage 双向通信

信封格式（两边一致）：

- 子页 → 宿主：`{ source: 'agent-chat', type, payload, ts }`
- 宿主 → 子页：`{ source: 'agent-chat-host', type, payload, id }`

**宿主下发命令**

| 命令                             | payload                                         | 说明                                |
| ------------------------------ | ----------------------------------------------- | --------------------------------- |
| `ask`                          | `{ text, params?, agentId?, newConversation? }` | 发起提问。**立即回执**，答案通过 `reply` 事件异步返回 |
| `set-params`                   | `{ params }`                                    | 合并业务参数                            |
| `set-agent`                    | `{ agentId }`                                   | 切换智能体（生成中会拒绝，需先 `stop`）           |
| `set-visual`                   | `{ bg?, bgUrl?, theme?, veil?, blur? }`         | 换背景 / 主题 / 遮罩                     |
| `set-sidebar`                  | `{ collapsed }`                                 | 收起 / 展开左侧栏                        |
| `stop`                         | —                                               | 终止当前生成                            |
| `clear`                        | `{ agentId? }`                                  | 新建会话                              |
| `focus` / `get-state` / `ping` | —                                               | 聚焦输入框 / 查询状态（会重发一次 `ready`）       |

**子页上报事件**

`ready`（智能体列表、会话 id、模式、存储状态）、`user-message`、`delta`（流式增量，已节流 120ms）、`thought`、`reply`（完整回答 + sessionId/requestId/taskId）、`error`、`state`（生成中/busy）、`command-done`（命令回执）、`height`（auto 模式内容高度）。

宿主侧一行接入：

```html
<script type="module">
import { mountAgentChat } from 'http://your-host:5178/js/embed.js';

const chat = mountAgentChat(document.getElementById('box'), {
  base: 'http://your-host:5178/',
  embed: '1',
  agent: 'service',
  q: '我的业务办到哪一步了',
  params: { user: '张三', biz: '社保转移' },
});

chat.ready.then((s) => console.log('智能体列表', s.agents));
chat.on('reply', (p) => { /* p.text 就是回答，可直接写进你的业务界面 */ });
document.querySelector('#btn').onclick = () => chat.ask('再帮我查一下');
</script>
```

完整可运行示例：

- **`http://127.0.0.1:5178/embed-demo.html`** —— 左侧是被嵌的对话框，右侧是通信日志，可点按钮试各种命令
- **`http://127.0.0.1:5178/embed-sandbox-demo.html`** —— 加了 `sandbox` 属性的最小接法

### 9.4 安全：上线前必须配的两件事

**① 宿主来源白名单** —— 否则任何网站都能往嵌在它页面里的对话框投送命令。  
子页默认用 `document.referrer` 推断宿主来源；若宿主页面设了 `Referrer-Policy: no-referrer` 会推不出来，这时必须显式传：

```
?embed=1&parent=https://portal.gov.cn
```

非白名单来源发来的 postMessage 会被忽略并在控制台告警。

**② 限制谁能嵌你** —— `config/settings.json`

```json
"embed": {
  "enabled": true,
  "allowOrigins": ["https://portal.gov.cn"],
  "allowAllOrigins": false
}
```

| 配置                      | 下发的响应头                                                   | 效果             |
| ----------------------- | -------------------------------------------------------- | -------------- |
| `enabled: false`        | `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN` | 谁都嵌不了          |
| `allowOrigins` 非空       | `frame-ancestors 'self' <白名单>`                           | 只有白名单站点能嵌      |
| `allowAllOrigins: true` | `frame-ancestors *`                                      | 不限来源           |
| 默认（空 + false）           | `frame-ancestors *`                                      | 不限来源，仅建议内网/开发用 |

启动日志会打印当前生效的嵌入策略，可据此确认。

**③ 宿主的 `sandbox` 属性**（如果用的话）

```html
<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" …></iframe>
```

- `allow-scripts` **必须给**，否则子页脚本完全不执行
- `allow-same-origin` **必须给**，否则子页是 opaque origin，`localStorage` 直接抛异常（历史会丢）
- `allow-modals` **可以不给**：删除确认、附件输入都走内部自研弹层（`public/js/ui.js`），不依赖浏览器原生 `confirm()` / `prompt()`，所以即使被浏览器拦截也不影响功能
- `allow-downloads` 不给则「导出 Markdown」按钮无效

> 为什么不用原生 `confirm()`：在 `sandbox` 缺 `allow-modals`、或用户开着「阻止此页面创建更多对话框」时，浏览器会**静默忽略**这个调用并返回 `false`，表现就是「点删除没反应」。这类静默失败排查成本极高，所以破坏性操作的确认一律用内部弹层。

### 9.5 浏览器禁用第三方存储时的行为

跨站 iframe 中 Safari / Chrome 可能禁用 `localStorage`。子页会自动**降级为内存存储**（不会崩，也不会报错刷屏），但**历史对话不再持久化**。

判断方法：`ready` 事件的 `storage` 字段 —— `"localStorage"` 为正常，`"memory"` 为降级。

降级时建议由宿主接管历史：监听 `reply` 事件自行入库，再用 `ask` 配合自己的历史列表回放。

### 9.6 跨域调用本服务 API

iframe 场景本身不需要 CORS（子页直接访问本服务，同源）。只有你想在**自己的页面 JS 里直连**本服务 API 时才需要配 `cors.allowOrigins`：

```json
"cors": { "allowOrigins": ["https://portal.gov.cn"] }
```

> 出于安全考虑，本服务**不再回显任意 Origin**。否则任何第三方网页都能跨域调用 `/api/session/run`，白烧你的 APP_KEY 调用额度。

### 9.7 剪贴板：为什么「复制」按钮有时会失败

消息下方的「复制」按钮（以及「请求ID」、sessionId、分享链接）都走同一个 `copyText()`，  
它按 **标准 API → `execCommand` → 手动复制弹层** 三级降级。三道门槛任一不满足都会触发降级：

| 门槛        | 触发条件                                                      | 典型报错                                                  |
| --------- | --------------------------------------------------------- | ----------------------------------------------------- |
| **安全上下文** | 用 `http://192.168.x.x:5178` 这类非 localhost 地址访问            | `navigator.clipboard` 是 `undefined` → TypeError       |
| **文档聚焦**  | 对话框所在文档失去焦点（切窗口、自动化、点在宿主页上）                               | `NotAllowedError: Document is not focused`            |
| **权限策略**  | 被**跨域** iframe 嵌入，且宿主 iframe 没写 `allow="clipboard-write"` | `NotAllowedError: ... disabled by permissions policy` |

> 只有 `https://` 与 `http://localhost` / `http://127.0.0.1` 属于安全上下文。  
> 本服务默认只监听 `127.0.0.1`，本机直开不会命中第一条；一旦改成监听 `0.0.0.0` 给同事用局域网 IP 访问，就会撞上。

**排查顺序**：F12 控制台搜 `clipboard` → 看 `navigator.clipboard` 是否存在（不存在=非安全上下文）→  
看是否是跨域 iframe 且缺 `allow` 属性 → 都不成立则看具体错误名。  
第三级兜底成功后，界面不会报错，而是弹出一个已全选内容的弹层，按 Ctrl+C 即可。

**最坏情况已实测**（跨域探针，**脚本已归档**）：跨域 iframe + 非安全上下文下，  
子页 `isSecureContext=false`、`navigator.clipboard` 为 `undefined`、权限 `denied` ——  
标准通道彻底不可用；但 `document.execCommand('copy')` 在真实点击手势下**返回 `true`**，  
即第二级兜底仍然救得回来。所以「复制」按钮在任何嵌入方式下都不会静默失效。

---

## 十、已知限制

1. **非流式模式下无法点赞/点踩**：文档中 `/feedback` 必填 `requestId` 与 `taskId`，而非流式 `/run` 的返回结构里没有这两个字段。若要使用反馈功能，请保持「流式输出」开启（默认开启）。
2. 服务端会话存档是**单机文件存储**，无鉴权、未做多租户隔离，适合内网单点部署；如需多人共用需自行加登录与数据隔离。
3. 自定义背景图片存在浏览器本地，换浏览器不同步。
4. 网关若返回非文档格式的帧，服务端会静默忽略该帧（不会中断整体流），排障时可看服务端日志。
5. **嵌入模式下侧栏历史是「共享」的**：同一浏览器同一 origin 下所有嵌了你对话框的页面共用一份 localStorage 历史。若不同宿主页面需要互不干扰，请用 `?new=1` 强制开新会话，或给每个宿主分配不同路径/子域。
6. **嵌入模式下侧栏的行为随容器宽度分叉**：容器 ≥620px 时侧栏正常占位（把消息区往右挤 252px），<620px 时退化为浮层（盖住聊天区左侧，顶栏的 ☰ 也被盖住，此时靠**点主区 / Esc** 收起，侧栏头部那个与 ☰ 重复的 `‹` 已删除）。窄面板里如果不想让侧栏占地方，用 `?sidebar=0` 让侧栏初始收起。
7. **大模型会话没有点赞 / 点踩**：那对按钮是网关 `/feedback` 的能力，必须带 `requestId` 与 `taskId`，而 OpenAI 兼容响应里没有这两个字段。所以模型会话只保留「复制 / 重答」，👍👎 不渲染（而不是渲染出来一点就报错）。
8. **大模型是直连厂商，不经过网关**：也就是说网关侧的鉴权、限流、审计、重试都不覆盖它。厂商地址不通时表现为 `fetch failed`，排障思路与网关那套一致（先看 TCP 能不能通）。

---

## 十一、常见问题

**Q：提示「智能体「XX」没有可用的 APP_KEY」**  
A：这个智能体既没有自己的 `apiKey`，全局 `settings.json` 的 `gateway.apiKey` 又是空的，也没有 `AGENT_APP_KEY` 环境变量。报错信息会**点名是哪个智能体**：给它补一个 `apiKey`，或者补一把全局 key 即可。

**Q：提示「网关连接失败：fetch failed」**  
A：网络层不通（TCP 都建不起来），通常是这台机器没接政务外网 / VPN。

**Q：服务已启动，但别的机器 / 外网访问不了 `http://127.0.0.1:5178`**  
A：`127.0.0.1` 是本地回环地址，**只在本机有效**。`netstat` 显示 `127.0.0.1:5178` 就说明它根本没监听外网。  
解决：用环境变量 `AGENT_HOST=0.0.0.0`（或 `HOST=0.0.0.0`）启动，让它监听所有网卡：

```bash
AGENT_HOST=0.0.0.0 PORT=5178 node server.mjs
```

然后访问服务器的真实 IP（如 `http://10.x.x.x:5178`）。若前面还有 nginx/防火墙，需要再开放 `5178` 端口并做反向代理。

**Q：提示「网关返回非 JSON（HTTP 404）：…nginx…」**  
A：**网络是通的，请求被前置的 nginx 挡下了，压根没到网关应用** —— 问题在 `baseUrl` 的地址或路径前缀，不是代码。  
逐层定位的正确思路是**按「TCP → 路径注册 → 鉴权 → 业务」四层依次验证**（当时有专门的探针脚本做这件事，
**脚本已归档**，见第十节）：

**Q：大模型报「接口返回 HTTP 404」**  
A：**先看报错里的「请求地址」那一行** —— 现在报错会把它打出来，多数问题看一眼就知道。
最常见的是 `baseUrl` 填成了厂商的 **Anthropic 兼容入口**（如 `https://api.deepseek.com/anthropic`），
本服务只支持 OpenAI 兼容接口，拼出来的 `/anthropic/chat/completions` 会返回 404 且响应体为空。
去掉结尾的 `/anthropic` 即可。详见 **6.5**。

它按「TCP → 路径注册 → 鉴权 → 业务」四层依次给结论。若六个业务路径**连同根路径 `/` 全部 404**，基本可判定该入口没有部署目标网关，请回智能体平台逐字符核对 `baseUrl`（端口、路径前缀、是否要用域名而非 IP）。

**Q：填了 agentCode 为什么还是走 Mock？**  
A：`mock` 是全局总闸，在 `settings.json` 里，**与 `agents.json` 无关**。优先级：`AGENT_MOCK` 环境变量 > `settings.json` 的 `mock` > 默认 false。

**Q：切到真实网关后第一条消息就报错**  
A：Mock 时期建的会话其 `sessionId` 形如 `mock-xxx`，会被 `ensureSession()` 永久复用并原样发给网关。**需删掉旧对话重建**（Mock 与真实模式的会话不能混用）。

**Q：链接里的业务参数（如 `eventNum`）是放在请求头里传的吗？**  
A：**不是**。发往网关只有 3 个自定义请求头（`Authorization` / `Content-Type` / `Accept`），业务参数一律走请求体的 `message.text` 与 `message.metadata`。详见**第四节「发往网关的完整请求头」**。想自己抓包核对，用探针脚本（**已归档**，见第十节）—— 它会起一个假网关 + 独立实例，把两跳的 method / URL / header / body 原文打印出来，**不碰真实网关、不影响正在跑的服务**。

**Q：`gateway.apiKey` 要不要带 `Bearer` 前缀？**  
A：**不要**。`server.mjs` 会自己拼成 `Authorization: Bearer <apiKey>`，带上前缀会发成 `Bearer Bearer xxx`。智能体自己的 `apiKey` 同理。

**Q：几个智能体各有各的 APP_KEY，怎么配？**  
A：在 `config/agents.json` 里给对应的智能体加 `"apiKey": "…"`（可选再加 `"baseUrl"`），没配的自动沿用 `settings.json` 的全局 key。  
改完**刷新页面即生效**（配置热重载，不用重启）。启动日志会逐个打印每个智能体实际用的是哪把 key（脱敏）。详见**第五节「每个智能体用自己的 APP_KEY」**。

**Q：我配了智能体自己的 `apiKey`，怎么还是用全局那把？**  
A：按顺序查三件事：① 是不是有 `AGENT_APP_KEY` 环境变量在跑（**它的优先级最高，会压过所有智能体配置**，启动日志里会带「来自环境变量」字样）；② `apiKey` 是不是配到了别的 `id` 上，或者 JSON 多了个逗号导致整份配置解析失败（服务端会打 `[config] 解析失败` 警告）；③ `clearSession` / `deleteSession` / `feedback` 这类只带 `sessionId` 的调用是不是没带 `agentId`。启动日志里那行「各智能体凭证」能直接回答第一个问题。

**Q：密钥会不会被下发到浏览器？**  
A：不会。`/api/config` 里的智能体条目只有 `hasOwnKey: true/false` 这种布尔标记，密钥在服务端就与公开字段分开放（`readAgentsConfig()` 的 `secrets`）。凭证回归（30 项，**脚本已归档**）会整包扫描该响应，**出现任何 key 明文即判失败**。

**Q：改了 agents.json 没生效**  
A：保存后刷新浏览器即可；配置读取带 mtime 缓存，不需要重启服务。

**Q：侧栏那个「大模型」栏怎么关掉？**  
A：在 `config/settings.json` 里改两个开关（都在 `ui` 段下，默认都是 `true`）：
```json
{ "ui": { "showModels": false, "showAgents": false } }
```
保存刷新即生效。注意这是**栏位显隐**，不是停用 —— 模型 / 智能体本身还配在各自的 json 里；
而且**链接显式带了 `?model=` / `?agent=` 时，被点名的那一栏会强制显示出来**（见第七章）。

**Q：为什么配了 `showModels: false`，大模型栏还在？**  
A：三种可能：① 链接里带了 `?model=`（这是设计行为，见上一条）；② 改的是 `config/settings.json` 却没刷新页面；
③ 你改的其实不是服务端读的那份配置（比如改了项目里另一个副本）。排查顺序照这个来即可。

**Q：大模型和智能体到底差在哪？**  
A：智能体走网关 `createSession` + `sessionId`，**上下文由网关侧维护**，还能用 `/feedback` 点赞、
配 `urlTemplate` 拼业务参数；大模型是直连厂商的 OpenAI 兼容接口，**无状态**，每轮由前端整段回传历史。
界面上两者共用同一套事件与渲染管线，用起来没区别 —— 差别在凭证来源和那几个网关专属能力上。

**Q：加了模型但是发消息报「没有可用的 APP_KEY」**  
A：这条报错是**智能体**链路的文案。大模型缺 key 时报的是「大模型「xx」没有可用的 apiKey」，并会点名是哪一个。
两者的配置来源完全独立：智能体看 `agents.json` 的 `apiKey` / `settings.json` 的 `gateway.apiKey` / `AGENT_APP_KEY`；
大模型看 `models.json` 的 `apiKey` / `AGENT_MODEL_APP_KEY`。启动日志里「各智能体凭证」与「各大模型凭证」是分开打印的两段。

**Q：想嵌到已有系统里**  
A：服务端已开放 CORS，可直接 `<iframe src="http://host:5178/?agent=service&user=xxx">` 嵌入。

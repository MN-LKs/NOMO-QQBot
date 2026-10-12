# NPAPI

一个跑在 **Cloudflare Workers** 上的 QQ 官方机器人:能聊天、能联网搜索、能查 AI 中转站额度,
**还能让 AI 现场写代码并部署成真实可访问的网页**(`https://ai.example.com/<8个字符>`)。

零 npm 运行依赖,零服务器,免费套餐就能跑。

> 🔐 仓库里**不留任何凭据**。所有密钥、域名、AppID 一律留空,填在 Cloudflare 后台。
> 提交前会强制跑 `node tools/scan-secrets.js`,发现敏感信息直接拒绝提交。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| 💬 群聊 AI | `@机器人 /AI 你的问题`,接入 `deepseek-v4.1-flash`,开启 **max 档深度思考** |
| 🧠 隐式思考 | 思考过程**不会**发到群里,只写进 Cloudflare 日志(`[思考]` / `[思考·摘录]`) |
| 🛠 工具调用 | 联网搜索、抓网页、查中转站额度、精确计算、查时间 |
| 🚀 一键部署 | 让 AI 写网页/小游戏,直接部署到公网并回你一个链接,立刻能玩 |
| ✏️ 在线改代码 | 部署完还能继续让 AI 改,链接不变,倒计时重置 |
| 🗄 内置后端 | 部署的页面可以用 `./__data/<键>` 读写服务端数据(排行榜、存档) |
| 🗜 上下文管理 | `/压缩` 把聊天记录压成摘要,`/delete` 清空记忆 |
| 📋 指令面板 | 被 @ 但没说事的时候自动回指令帮助 |

---

## 三分钟部署

### 1. 把仓库连到 Cloudflare

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **创建**
2. 选 **连接到 Git**,授权后选这个仓库
3. 构建命令填 `npm install`,部署命令填 `npx wrangler deploy`
4. 点保存并部署

以后 **只要往这个仓库 push,Cloudflare 就会自动重新部署**。

> 也可以在本地 `npm install && npx wrangler deploy`,效果一样。

### 2. 填变量(必做)

仓库里 `wrangler.toml` 的 `[vars]` **全部留空**,真实值填在 Cloudflare 后台:

**Workers & Pages → 你的 Worker → Settings → Variables and Secrets → 添加**

| 变量 | 类型 | 说明 |
|---|---|---|
| `QQ_APP_ID` | 文本 | 机器人 AppID |
| `QQ_APP_SECRET` | **Secret** | 机器人 AppSecret |
| `WEBHOOK_SECRET` | **Secret** | 自己随便生成一串,会拼进回调地址当暗号 |
| `LLM_BASE_URL` | 文本 | 上游网关,例如 `https://api.example.com/v1` |
| `LLM_API_KEY` | **Secret** | 上游 API Key |
| `PUBLIC_BASE_URL` | 文本 | 部署链接用的域名,例如 `https://ai.example.com` |
| `DASHBOARD_URL` | 文本 | 用量查询接口(可不填,不填则 `query_dashboard` 工具不可用) |
| `ADMIN_TOKEN` | **Secret** | 管理接口口令(可不填,不填则关闭管理接口) |

> `LLM_MAX_TOKENS` 默认**留空 = 不限制输出长度**(请求里根本不带 `max_tokens` 字段),
> 这样长回答不会被硬截断。想限制再填数字。

填完打开 `https://<你的地址>/check`,**缺哪一项它会直接列出来**。

### 3. 把回调地址填到 QQ 开放平台

部署成功后会得到一个地址,例如 `https://qqbot-nb-api.<你的子域>.workers.dev`。
到 [QQ 机器人管理端](https://q.qq.com/qqbot) → 开发设置 → 回调配置,填:

```
https://qqbot-nb-api.<你的子域>.workers.dev/qq/webhook/<WEBHOOK_SECRET>
```

`<WEBHOOK_SECRET>` 就是你在上一步填的那个值(也可以直接打开 `https://<你的域名>/check`,页面上会给出**完整可复制的回调地址**)。
它相当于给回调地址加了一道暗号,不匹配的请求一律 404。

点「保存」时腾讯会发一个 `op=13` 的验证请求,项目会自动用 Ed25519 签名回应。
如果提示校验失败,打开 `https://<你的域名>/check` 看自检结果。

> ⚠️ 如果域名上开着 Cloudflare 的托管质询(响应头出现 `cf-mitigated: challenge`),
> 腾讯的服务器过不了质询,机器人会完全收不到消息 —— 详见 [`docs/DEPLOY.md`](docs/DEPLOY.md) 的「四点五」。

### 4. (可选但推荐)绑定自己的域名

想让部署出来的链接长这样 → `https://ai.example.com/ab3k9m2p`,就需要绑定自定义域名:

1. 确认你的域名已经托管在**同一个** Cloudflare 账号下
2. 在 Worker 的 Settings → **Domains & Routes** 里加一个 Custom Domain(推荐,不用改代码)
   —— 或者打开 `wrangler.toml`,把末尾 `[[routes]]` 那三行的注释去掉并改成你的域名
3. 重新部署

**这两种方式二选一,别同时用**,同一主机名重复声明会让部署报冲突。

不绑定也能用,只是链接会变成 `https://xxx.workers.dev/ab3k9m2p` 这种。

---

## 怎么用

在群里 **@机器人** 然后说话就行。详细指令见 [`docs/COMMANDS.md`](docs/COMMANDS.md)。

```
@机器人 /AI 帮我写一个 2048 小游戏
@机器人 现在几点了
@机器人 帮我搜一下今天的新闻
@机器人 还剩多少额度
@机器人 /压缩          把聊天记录压成摘要,省 token 但不忘事
@机器人 /delete        清空这个会话的记忆
```

AI 要写网页时会自动调用 `deploy_site` 工具,把代码部署出去,然后把链接回给你:

```
🤖 搞定啦!👉 https://ai.example.com/ab3k9m2p
   直接点开就能玩,方向键控制。
```

---

## 部署项目的规则(写死在提示词里,AI 会照做)

- 同时最多 **6 个**在线部署
- 满了以后自动淘汰「**最久没有被修改**」的那一个(刚建的那个永远不淘汰),并告诉用户
- 每个部署活 **10 分钟**,到期自动销毁
- 期间任何修改都会**重新计时 10 分钟**
- 部署完 AI 必须把链接原样发给用户

这些值都能在 `wrangler.toml` 里改:`DEPLOY_MAX_SITES` / `DEPLOY_TTL_SECONDS`。

---

## 为什么用 Durable Object(以及为什么它不烧额度)

Cloudflare Workers 免费套餐有两个坑:

1. **CPU 只有 10 ms / 请求**(等网络的时间不算,但解析大 JSON 算)
2. **`ctx.waitUntil` 只给 30 秒**——而 max 档思考的一次问答轻松跑到 60~120 秒

所以架构是:

```
QQ 服务器 ──POST──> Worker(只做:验签 → 丢进 DO → 立刻回 200,耗时 < 100ms)
                        │
                        └──> Durable Object 的闹钟(单次可跑 15 分钟)
                                ├─ 调大模型(流式)
                                ├─ 执行工具(部署网页 / 搜索 / …)
                                ├─ 把回复发给 QQ
                                └─ 更新上下文 / 清理过期部署
```

Durable Object 在免费套餐里**可以用**(SQLite 后端,5 GB),而且:
**没人访问的时候它完全休眠,不消耗 CPU、不消耗请求数。** 只有真的有消息进来才会醒。

---

## 免费额度对照

| 资源 | 免费额度 | 这个项目怎么用 |
|---|---|---|
| Workers 请求 | 100,000 / 天 | 每条 QQ 消息 1 次 + 每次访问部署页 1 次 |
| Workers CPU | 10 ms / 请求 | Worker 只做验签和转发,实测 < 3 ms |
| Durable Object | 100,000 请求 / 天 | 每条消息 1~2 次 |
| DO 存储 | 5 GB | 上下文 + 代码,几 KB 级别 |
| 子请求 | 50 / 请求 | 一轮对话最多 6 次模型调用 + 若干工具调用 |

**结论**:几百人的群日常聊天完全跑不满。真正的瓶颈是上游大模型网关的额度,不是 Cloudflare。

详细分析见 [`docs/LIMITS.md`](docs/LIMITS.md)。

---

## 项目结构

```
src/
├── index.js            Worker 入口:路由 + 自检页 + 管理接口
├── config.js           配置读取(全部来自 wrangler.toml 的 [vars])
├── serve.js            托管 AI 部署出来的网页 + 内置后端 ./__data
├── qq/
│   ├── sign.js         Ed25519 签名/验签(官方测试向量已验证)
│   ├── api.js          取 access_token、发消息、错误码翻译、URL 被拦时降级
│   ├── webhook.js      回调入口:验签 → 事件归一化 → 入队
│   └── gateway.js      WebSocket 网关客户端(备用通道,默认不启用)
├── core/
│   ├── do.js           Durable Object:任务队列、闹钟、站点、上下文
│   └── schema.js       SQLite 表结构
├── agent/
│   ├── loop.js         Agent 主循环(模型 ↔ 工具)
│   ├── llm.js          流式客户端 + 省 CPU 的 SSE 解析 + 三级降级
│   ├── tools.js        工具定义(给模型看的 JSON Schema)
│   ├── exec.js         工具实现
│   └── prompt.js       系统提示词 / 压缩提示词 / 帮助文本
└── util/               文本、字节、ID、HTML、计算器

tools/
└── scan-secrets.js     提交前扫描敏感信息(不通过就拒绝提交)

test/
├── run.js              68 项单测(纯逻辑,不需要网络)
├── integration.js      33 项集成测试(真跑 Worker + DO + 假上游)
├── live.js             6 项活体测试(打真实网关,会花额度,需自己给 LLM_API_KEY)
├── harness.js          在 Node 里模拟 Cloudflare 运行时
└── mock-upstream.js    假大模型网关 + 假 QQ 开放平台
```

---

## 本地开发

```bash
npm install
npx wrangler dev          # 本地起一个完整的运行时

node tools/scan-secrets.js  # 提交前必跑:扫敏感信息
node test/run.js            # 单测
node test/integration.js    # 集成测试(不需要联网)
LLM_API_KEY=sk-xxx node test/live.js   # 活体测试(会消耗真实额度)
```

排查线上问题:

```
https://<你的域名>/check                 自检(会告诉你哪一项没配好)
https://<你的域名>/check?live=1          额外做一次联网测试
https://<你的域名>/admin/sites?token=…   看当前所有部署和剩余存活时间
```

看日志:`npx wrangler tail --format pretty`,或者在 Cloudflare 后台的 Workers Logs 里看。
**AI 的思考过程就在日志里**(`[思考]` 和 `[思考·摘录]`),不会发到群里。

---

## ⚠️ 安全:仓库里不留凭据(必读)

这个仓库是**公开**的,所以:

- `wrangler.toml` 的 `[vars]` 里**所有值一律留空**,真实值只存在 Cloudflare 后台;
- 本地调试把真实值写进 `.dev.vars`(已在 `.gitignore` 里);
- 测试代码里只允许用 `test-app-secret-not-real` 这种**明显是假的**字符串;
- 每次提交前跑 `node tools/scan-secrets.js`(CI 里也会跑),它会拦下
  OpenAI/GitHub/AWS/Slack 各类 key、私钥、JWT,以及 `wrangler.toml` 里被填了值的敏感项。
  **扫描不通过就拒绝提交。**

一旦不小心把真密钥推上去了,记住:**光删文件没用,Git 历史里还在**。
正确做法是立刻去对应平台**轮换密钥**(QQ 开放平台重新生成 AppSecret、上游重置 API Key、
GitHub 吊销 token),然后再清理仓库。

更多细节见 [`docs/SECURITY.md`](docs/SECURITY.md)。

---

## 许可

[AGPL-3.0](LICENSE)

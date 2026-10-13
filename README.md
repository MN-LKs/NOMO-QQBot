# NPAPI

一个跑在 **Cloudflare Workers** 上的 QQ 官方机器人:能聊天、能联网搜索、能读网页,
**还能让 AI 现场写代码并部署成真实可访问的网页**,直接把链接发回群里。

零服务器、零 npm 运行依赖,Cloudflare 免费套餐就能跑。

> 📖 **想彻底搞懂它怎么工作的?看 [项目说明与扩展指南](docs/ARCHITECTURE.md)**
> —— 数据流、每个文件的职责、变量怎么配、后期从哪里扩展,都在那一份里。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| 💬 群聊 AI | 在群里 @ 机器人直接说话,或 `@机器人 /AI 你的问题` |
| 🧠 思考不外露 | 模型的思考过程只写进日志,群里只看得到最终答案 |
| 🛠 工具调用 | 联网搜索、抓网页、查中转站额度、精确计算、查时间 |
| 🧠 群记忆 | 说「记住 xxx」就长期记下来,以后每次对话自动带上 |
| 🎲 顺手小工具 | 掷骰子、抽签、Base64 / URL / JSON 处理 |
| 🚀 一键部署 | 让 AI 写网页 / 小游戏,直接部署到公网并回一个链接,点开就能玩 |
| ✏️ 在线改代码 | 部署完还能继续让 AI 改,链接不变 |
| 🗄 页面带后端 | 部署的页面可以用 `./__data/<键>` 读写服务端数据(排行榜、存档) |
| 🗜 上下文管理 | `/压缩` 把聊天记录压成摘要,`/delete` 清空记忆 |

---

## 三分钟部署

### 1. 把仓库连到 Cloudflare

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **创建**
2. 选 **连接到 Git**,授权后选中这个仓库
3. 构建命令填 `npm install`,部署命令填 `npx wrangler deploy`
4. 保存并部署

以后每次 push,Cloudflare 都会自动重新部署。也可以在本地 `npm install && npx wrangler deploy`。

### 2. 填变量

仓库里的变量**全部留空**(这是公开仓库,凭据写进去就等于泄露)。
真实值填在:**Workers & Pages → 你的 Worker → Settings → Variables and Secrets**。

| 变量 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `QQ_APP_ID` | 文本 | ✅ | 机器人 AppID |
| `QQ_APP_SECRET` | Secret | ✅ | 机器人 AppSecret |
| `LLM_BASE_URL` | 文本 | ✅ | 大模型网关,例如 `https://api.example.com/v1` |
| `LLM_API_KEY` | Secret | ✅ | 大模型网关密钥 |
| `SEARCH_API_URL` | 文本 | — | 联网搜索接口,不填则搜索不可用 |
| `SEARCH_API_KEY` | Secret | — | 联网搜索密钥 |
| `PUBLIC_BASE_URL` | 文本 | — | 部署链接的域名,例如 `https://ai.example.com` |

就这 7 个。模型名、思考档位、部署名额、存活时长这些固定参数写在 `src/config.js` 里,不用配。

填完打开 `https://<你的地址>/check`,缺哪一项它会直接列出来。

### 3. 配置 QQ 回调

到 [QQ 机器人管理端](https://q.qq.com/qqbot) → 开发设置 → 回调配置,填:

```
https://<你的地址>/qq/webhook
```

监听事件至少勾上群 @ 消息(`GROUP_AT_MESSAGE_CREATE`)和单聊消息(`C2C_MESSAGE_CREATE`)。
点保存时腾讯会发一个 `op=13` 的验证请求,项目会自动签名回应。

> ⚠️ 如果域名上开着 Cloudflare 的托管质询,腾讯的服务器过不了质询,机器人会完全收不到消息。
> 排查方法见 [部署手册](docs/DEPLOY.md) 的「四点五」。

### 4.(可选)绑定自己的域名

想让部署链接长这样 → `https://ai.example.com/ab3k9m2p`,就在 Worker 的
Settings → **Domains & Routes** 里加一个 Custom Domain。
不绑定也能用,只是链接会变成 `https://xxx.workers.dev/ab3k9m2p`。

---

## 怎么用

在群里 @ 机器人然后说话就行。详细指令见 [指令说明](docs/COMMANDS.md)。

```
@机器人 /AI 帮我写一个 2048 小游戏
@机器人 现在几点了
@机器人 帮我搜一下今天的新闻
@机器人 /压缩          把聊天记录压成摘要
@机器人 /delete        清空这个会话的记忆
```

收到消息会先回一句「🤖 Agent 正在运行,请稍等…」,模型跑完再用主动消息把结果发出来。
两种方式互为兜底,消息不会丢。

AI 要写网页时会自动部署,然后把链接回给你:

```
🤖 搞定啦!👉 https://ai.example.com/ab3k9m2p
   直接点开就能玩,方向键控制。
```

---

## 部署网页的规则

- 同时最多 **6 个**在线部署
- 满了以后自动淘汰「**最久没有被修改**」的那一个,并告诉用户
- 每个部署活 **10 分钟**,到期自动销毁;期间任何修改都重新计时
- 单个页面所有文件加起来不超过 200 KB

这些数字都在 `src/config.js` 里,想改直接改。

---

## 为什么免费额度跑得动

Cloudflare Workers 免费套餐有两个限制:每个请求只有 **10 毫秒 CPU**,
`ctx.waitUntil` 只给 **30 秒**。而一次带思考的模型调用动辄几十秒。

所以架构是:Worker 只做「验签 + 入队 + 返回」(实测 3 毫秒以内),
真正干活的是 Durable Object 的闹钟(单次可运行 15 分钟)。
Durable Object 在免费套餐里用 SQLite 后端就能跑,而且**没人访问时完全休眠**,
不占 CPU、不占请求数。

真正会被用满的通常不是 Cloudflare,而是上游大模型的额度。
详细对照见 [额度说明](docs/LIMITS.md)。

---

## 项目结构

```
src/            Worker 入口、配置、回调、Agent、工具、部署托管
docs/           架构说明、部署手册、指令、额度、安全
tools/          提交前的敏感信息扫描
test/           单测 + 集成测试 + 活体测试
```

每个文件的职责、数据流、扩展点都在 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**。

---

## 本地开发

```bash
npm install
npx wrangler dev                    # 本地起一个完整运行时

node tools/scan-secrets.js          # 提交前必跑:扫敏感信息
node test/run.js                    # 单测
node test/integration.js            # 集成测试(不联网)
LLM_BASE_URL=... LLM_API_KEY=... node test/live.js   # 活体测试(花额度)
```

排查线上问题:

```
https://<你的域名>/check                自检(缺哪项会直接告诉你)
https://<你的域名>/check?live=1         额外做一次网关连通测试
npx wrangler tail --format pretty      实时日志,模型的思考过程在这里
```

---

## 安全

- 仓库里**不留任何凭据**,变量一律留空,真实值只存在 Cloudflare 后台
- 每次提交前跑 `node tools/scan-secrets.js`(CI 里也会跑),命中密钥直接拒绝提交
- 回调的每次推送都做 Ed25519 验签,伪造请求一律 401
- 同一条事件按 ID 去重,防止重复执行

细节见 [安全须知](docs/SECURITY.md)。

---

## 许可

[AGPL-3.0](LICENSE)

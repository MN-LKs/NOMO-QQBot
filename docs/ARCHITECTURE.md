# 项目说明与扩展指南

这份文档面向所有想读懂、部署或改造这个项目的人。它讲清楚三件事:

1. 这个机器人是怎么跑起来的(数据流)
2. 每个文件负责什么(代码地图)
3. 想改点什么,应该动哪里(扩展点)

---

## 一、这个项目是什么

一个跑在 **Cloudflare Workers** 上的 QQ 官方机器人。用户在任何 QQ 群里 @ 它,它就能:

- 正常聊天、答疑、翻译、算数
- 联网搜索(接你自己配置的搜索服务)
- 读网页正文
- **现场写前端代码,并部署成一个真实可访问的网页**,把链接发回群里

它不依赖任何服务器:整套东西都在 Cloudflare 的免费额度里跑,没有常驻进程,没人的时候完全不消耗资源。

---

## 二、一条消息的完整旅程

```
用户在群里 @ 机器人
        │
        ▼
QQ 开放平台  ──HTTPS POST──▶  Cloudflare Worker(边缘节点)
                                    │
                                    ├─ 1. 验签(Ed25519):确认真的是腾讯发来的
                                    ├─ 2. 把事件转成一条任务,丢进 Durable Object
                                    └─ 3. 立刻返回 200(必须在 5 秒内,否则腾讯会重推)
                                                │
                                                ▼
                                    Durable Object 的闹钟醒来
                                                │
                                    ┌───────────┴───────────┐
                                    ▼                       ▼
                          组装上下文 + 系统提示词      执行工具
                                    │                       │
                                    ▼                       │
                          调用大模型(非流式)  ◀────────────┘
                                    │
                                    ├─ 思考过程 → 只写进日志,绝不发到群里
                                    ├─ 工具调用 → 本地执行,结果回喂给模型
                                    └─ 最终正文 → 切分成多条 → 发回 QQ 群
```

收到消息时会**先回一句回执**(「🤖 Agent 正在运行,请稍等…」,走被动回复),
等模型跑完再用**主动消息**把正文发出去。两种方式互为兜底:主动发不出去就退回被动,
被动超时或超次数就改用主动,消息不会丢。单聊固定用被动回复(单聊主动消息限制更严)。

几个关键取舍:

**为什么必须用 Durable Object**
QQ 要求回调在 5 秒内返回,而一次带思考的模型调用动辄几十秒。Worker 请求本身撑不住这么长,
所以 Worker 只做「验签 + 入队 + 返回」,真正干活的是 Durable Object 的闹钟(单次可运行 15 分钟)。
免费套餐里 Durable Object 用 SQLite 后端是可用的(5 GB),而且**没人访问时它完全休眠**,
不占 CPU、不占请求数,所以它反而是最省额度的方案。

**为什么用非流式请求**
QQ 消息本身不支持流式输出,流式拿到的分片最终也只能攒成一段文本再发出去。
所以这里统一用非流式请求:一次拿到完整结果,思考过程留在日志里,正文再发给用户。
好处是链路简单、CPU 占用低(免费套餐每个请求只有 10 毫秒 CPU)。

**为什么思考过程不进群**
大模型的思考内容对群友来说是噪音,而且容易泄漏提示词。项目只把思考的前 1500 字写进日志,
方便你自己排查「它为什么这么答」,群里只会看到最终答案。

**为什么要做降级重试**
深度思考档位在遇到难题时,可能把输出预算全花在思考上,结果正文一个字都没有。
所以每次调用都带一条降级阶梯(高 → 低 → 最低),一旦出现「正文为空」或「上游超时」,
就自动换更快的档位重试一次,保证用户一定能收到东西。

---

## 三、代码地图

```
src/
├── index.js          Worker 入口:路由(/health、/check、/qq/webhook、/<部署ID>)
├── config.js         配置读取:7 个变量 + 所有固定参数
├── serve.js          托管 AI 部署出来的网页,以及页面用的简易后端
│
├── qq/
│   ├── sign.js       Ed25519 签名与验签(官方测试向量已验证)
│   ├── api.js        取 access_token、发消息、错误码翻译、被风控时自动降级
│   └── webhook.js    回调入口:验签 → 事件归一化 → 入队
│
├── core/
│   ├── do.js         Durable Object:任务队列、闹钟、站点、上下文、统计
│   └── schema.js     SQLite 表结构
│
├── agent/
│   ├── loop.js       Agent 主循环:模型 → 工具 → 模型 …… 直到拿到最终回复
│   ├── llm.js        大模型客户端:非流式请求、响应解析、降级重试
│   ├── tools.js      工具定义(给模型看的 JSON Schema)
│   ├── exec.js       工具实现
│   ├── search.js     联网搜索适配层(多家服务商)
│   └── prompt.js     系统提示词、压缩提示词、帮助文本
│
└── util/             文本、字节、ID、HTML、计算器等纯函数工具

tools/
└── scan-secrets.js   提交前的敏感信息扫描闸门

test/
├── run.js            纯逻辑单测(不需要网络)
├── integration.js    端到端测试(真跑 Worker + DO + 假上游)
├── live.js           活体测试(打真实上游,需要自己给密钥)
├── harness.js        在 Node 里模拟 Cloudflare 运行时
└── mock-upstream.js  假的大模型网关、QQ 开放平台、搜索服务
```

### 每个文件具体在做什么

**src/index.js** — Worker 的唯一入口。只做四件事:健康检查、自检页 `/check`、
把 `/qq/webhook` 交给回调处理器、把其他路径当作「AI 部署的网页」去查。
自检页会逐项检查变量是否填全,缺哪一项直接列出来。

**src/config.js** — 所有配置的唯一出口。上半部分是**固定参数**(模型名、思考档位、超时、
部署名额、存活时长、ID 位数……),这些写在代码里,不需要配;
下半部分只读 7 个环境变量。

**src/qq/sign.js** — 腾讯官方的 Ed25519 算法实现。回调地址验证(op=13)用它签名,
普通事件推送用它验签。算法是:BotSecret 反复翻倍到 32 字节作为种子,生成密钥对;
签名对象是「时间戳 + 原始请求体」。

**src/qq/webhook.js** — 把腾讯的事件翻译成内部任务。支持群 @ 消息、群普通消息、单聊消息、
机器人被拉进群、被加好友;机器人被移出群之类的通知会记一行日志。

QQ 后台可以选「**全部接收**」模式,那样所有事件(包括以后新增的类型)都会推过来。
这套代码对未知类型是安全的:直接返回 200 让腾讯别再重推,**不会唤醒 Durable Object**,
所以既不会出错也不浪费额度。想知道收到了哪些没处理的类型,看日志里的 `[事件] 未处理的类型: xxx`。

**src/core/do.js** — 整个机器人的大脑。它维护一条任务队列,闹钟醒来就依次处理;
还负责会话上下文(最近若干条消息 + 摘要)、部署站点的增删改查、过期清理、运行统计。

**src/agent/loop.js** — Agent 循环。把「系统提示词 + 历史 + 长期记忆 + 本次问题」发给模型;
如果模型要求调用工具,就执行工具、把结果回喂,再问一次;直到模型给出纯文本回复。
每一轮都打日志,包含思考摘要、工具调用、耗时。

**src/agent/llm.js** — 大模型客户端。负责拼请求、解析响应、把思考内容和正文分开、
把工具调用规范化,以及上面说的降级重试。

**src/agent/search.js** — 联网搜索适配层。根据你配置的网址自动识别服务商,
拼出对应的请求,再从各种返回结构里统一抽出「标题 / 网址 / 摘要」。

**src/core/schema.js** — 数据表:`kv`(事件去重、token 缓存)、`sites`(部署)、
`conv` + `msg`(会话与消息)、`jobs`(任务队列)、`sdata`(部署页面的数据)、
`mem`(长期记忆)、`stats`(统计)。

**src/serve.js** — 把部署出去的网页真正服务出来,并给页面提供一个极简后端:
前端用 `fetch('./__data/键')` 读、用 POST 写,数据存在服务端的 SQLite 里,
适合做排行榜、存档这类需求。

---

## 四、需要配置的变量(只有 7 个)

仓库里的 `wrangler.toml` 把变量全部留空了 —— 这是公开仓库,凭据写进去就等于泄露。
真实值填在:**Cloudflare Dashboard → Workers & Pages → 你的 Worker → Settings → Variables and Secrets**。

| 变量 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `QQ_APP_ID` | 文本 | ✅ | QQ 机器人 AppID |
| `QQ_APP_SECRET` | Secret | ✅ | QQ 机器人 AppSecret |
| `LLM_BASE_URL` | 文本 | ✅ | 大模型网关地址,例如 `https://api.example.com/v1` |
| `LLM_API_KEY` | Secret | ✅ | 大模型网关的密钥 |
| `SEARCH_API_URL` | 文本 | — | 联网搜索接口地址,不填则联网搜索不可用 |
| `SEARCH_API_KEY` | Secret | — | 联网搜索的密钥 |
| `PUBLIC_BASE_URL` | 文本 | — | 部署链接用的域名,例如 `https://ai.example.com`,不填则只返回相对路径 |

填完打开 `https://<你的地址>/check`,缺哪一项它会直接告诉你。

### 想调参数怎么办

模型名、思考档位、超时、部署名额、存活时长、ID 位数、投递方式这些**不是变量**,它们写在
`src/config.js` 顶部的 `FIXED` 里。想改就直接改代码,改完提交即可,不需要动 Cloudflare 后台。

常改的几个:

| 字段 | 默认 | 作用 |
|---|---|---|
| `llmModel` | `deepseek-v4.1-flash` | 换模型 |
| `reasoningEffort` | `max` | 思考档位,`low` 会明显更快 |
| `answerDelivery` | `active` | 群聊结果用主动消息还是被动回复 |
| `maxSites` / `siteTtlSeconds` | 6 / 600 | 部署名额与存活时长 |
| `dashboardUrl` | 中转站查询地址 | `query_dashboard` 工具查的就是它 |

---

## 五、联网搜索:支持哪些服务商

`SEARCH_API_URL` 填哪个服务商的接口地址,就自动按哪家的协议发请求。
目前内置了这些(不区分大小写,看域名识别):

| 服务商 | 典型地址 | 说明 |
|---|---|---|
| 秘塔 | `https://metaso.cn/api/v1/search` | 国内可用,响应快 |
| Exa | `https://api.exa.ai/search` | 语义搜索见长 |
| Tavily | `https://api.tavily.com/search` | 为 AI 场景设计 |
| Serper | `https://google.serper.dev/search` | Google 结果 |
| Brave | `https://api.search.brave.com/res/v1/web/search` | 有免费额度 |
| Bing | `https://api.bing.microsoft.com/v7.0/search` | Azure 订阅 |
| Google CSE | `https://www.googleapis.com/customsearch/v1` | 需要把 `cx` 参数一起写在地址里 |
| SerpAPI | `https://serpapi.com/search.json` | 聚合多家引擎 |

**不在列表里的服务商也能用。** 识别不出来时会走通用模式:POST 一个包含
`query / q / count / num / max_results` 的 JSON,带上 `Authorization: Bearer` 和 `X-API-KEY`,
然后从返回的 JSON 里自动找出「长得像搜索结果」的数组。
POST 不行会自动改用 GET 再试一次。

**想加一家新服务商**:在 `src/agent/search.js` 里加三处 —— `detectProvider` 加域名判断、
`buildRequest` 加请求形状、`extractResults` 加结果字段映射。

---

## 五点五、模型能用的工具

| 工具 | 干什么 |
|---|---|
| `deploy_site` / `update_site` / `list_sites` / `read_site` / `delete_site` | 部署网页的增删改查 |
| `web_search` | 联网搜索(走 `SEARCH_API_URL`) |
| `fetch_url` | 抓网页正文 |
| `query_dashboard` | 查 AI 中转站用量(地址写死在 `src/config.js` 的 `dashboardUrl`) |
| `remember` / `recall` / `forget` | 群长期记忆,存在 Durable Object 的 `mem` 表里 |
| `random` | 掷骰子、抽签、随机数 |
| `encode` | Base64 / URL / 十六进制互转,JSON 美化或压缩 |
| `calc` / `now` | 精确计算、当前时间 |

加工具就三步:在 `src/agent/tools.js` 写定义(给模型看的描述)、在 `src/agent/exec.js` 写实现、
在 `test/run.js` 的工具清单里补个名字。

---

## 六、后期可以在哪里扩展

**加一个新工具**
1. 在 `src/agent/tools.js` 的数组里加一项,写清楚 `name`、`description`、`parameters`。
   描述写得越具体,模型越不会用错。
2. 在 `src/agent/exec.js` 的 `switch` 里加一个 `case`,返回一段中文文本给模型看。
3. 在 `test/run.js` 的「工具定义」用例里补上新工具名。

**让机器人响应更多 QQ 事件**
在 `src/qq/webhook.js` 的 `normaliseEvent` 里加一个 `case`,把事件转成内部任务格式即可。
内部任务只要有 `scene`(group / c2c)、`targetId`、`text` 就能走完整条链路。

**改部署规则**
名额、存活时长、单站点体积上限、ID 位数都在 `src/config.js` 的 `FIXED` 里。
「淘汰最久没改动的那个」的逻辑在 `src/core/do.js` 的 `enforceLimit`。

**加一个 QQ 事件类型**
在 `src/qq/webhook.js` 的 `normaliseEvent` 里加一个 `case`。要回复的事件返回
`kind: 'message'` 并带上 `scene` / `targetId` / `text`;只想记个日志的返回 `kind: 'note'`;
不想管的返回 `kind: 'ignore'`(默认)。

**改机器人的说话风格**
`src/agent/prompt.js` 的 `buildSystemPrompt` 是唯一的地方。想换人设、换语气、
限制字数、增加禁止事项,都在这里改。群聊里看到的所有"性格"都来自这一段。

**换模型**
改 `src/config.js` 里的 `llmModel`。任何 OpenAI 兼容的 `/chat/completions` 接口都能直接用。

**加数据表**
在 `src/core/schema.js` 的数组里追加 `CREATE TABLE IF NOT EXISTS ...` 就行,
每次启动都会执行,重复执行是安全的。

---

## 七、排错顺序

1. **打开 `/check`** —— 90% 的问题在这里就能看出来(变量没填、DO 不通)。
2. **`/check?live=1`** —— 额外做一次真实的网关连通测试。
3. **`npx wrangler tail --format pretty`** —— 看实时日志。模型的思考过程、
   每次工具调用、每轮耗时都在这里。群里 @ 了没反应,先看这里有没有日志:
   - **一条日志都没有** → 请求根本没到 Worker,多半是域名上开着 Cloudflare 质询,
     或者 QQ 后台的回调地址 / 事件订阅没配好。
   - **有 `[收到]` 但没有 `[完成]`** → 模型或工具那一步出了问题,往下翻错误堆栈。
4. **回复里出现「处理这条消息时出错了」** → 看日志里的具体错误,
   常见的是上游网关超时或额度用完。

---

## 八、安全上的几条硬规矩

- 仓库里**不留任何凭据**。变量全部留空,真实值只存在 Cloudflare 后台。
- 每次提交前跑 `node tools/scan-secrets.js`(CI 里也会跑),命中密钥就拒绝提交。
  它会检查三类东西:
  1. **凭据特征** —— OpenAI / 中转站的 `sk-…`、Anthropic `sk-ant-…`、
     GitHub 的 `ghp_` / `github_pat_` / `ghu_` / `ghs_`、AWS `AKIA…`、
     Slack `xox…`、Google `AIza…`、JWT、`-----BEGIN … PRIVATE KEY-----`
  2. **`wrangler.toml` 里该留空的 7 个变量**,任何一个被填了值都报错
  3. **疑似真实账号标识**(形如真实 QQ AppID 的 10 位数字,只在「给 appId 赋值」的语境里拦)

  文档里用反引号包起来的示例、以及以 `-` `*` `#` `>` `|` 开头的说明行会被自动放行,
  所以写文档时不用绕开这些字样。确实需要放行的其它字符串,加进 `ALLOWLIST` 数组。
- 回调的每一次推送都做 Ed25519 验签,伪造的请求一律 401。
- 同一条事件按 ID 去重,防止腾讯重推导致重复执行。
- 部署出去的页面只托管静态文件,不能执行任意服务端代码;
  路径做了穿越校验,单站点体积和存活时间都有上限。
- AI 生成的网页带 `X-Robots-Tag: noindex` 和 CSP 头,不会被搜索引擎收录。

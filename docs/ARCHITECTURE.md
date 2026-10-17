# 代码结构与数据流

给接手改代码的人看。读完这篇应该能知道「一个功能该改哪个文件」。

---

## 一、整体形状

```
        QQ 群 / 单聊
             │
   ┌─────────┴──────────┐
   │ WebHook(默认)       │ WebSocket(可选)
   │ 腾讯 POST 回调       │ 机器人主动连网关
   └─────────┬──────────┘
             ▼
     Durable Object「BotCore」   ← 队列、会话上下文、沙盒、WebSocket 宿主
             │
             ▼
        AI Agent(模型 + 工具)
             │
   ┌─────────┼──────────┬────────────┐
   ▼         ▼          ▼            ▼
 部署项目   沙盒文件   MCP 工具    联网搜索

   浏览器 ──► Worker ──► /administrator 面板(直连 D1 / KV)
   访客   ──► Worker ──► /<8位ID> 部署出来的网页(直连 KV)
```

三条链路互不阻塞:**消息**走 DO,**面板**和**部署页面**走 Worker 直连数据库。

---

## 二、一次对话发生了什么

1. **入口**
   - WebSocket:`src/qq/gateway.js` 收到 `op=0` 事件 → `normaliseEvent()` 归一化 → `core.enqueue()`
   - WebHook:`src/qq/webhook.js` 验签(op=13 走签名回应,op=0 验 Ed25519,失败一律 401)→ 同样入队
2. **排队**:任务写进 DO 的 `jobs` 表,并给自己定一个 300ms 后的闹钟
3. **处理**:`alarm()` → `tick()` → `claimNextJob()` → `handleMessage()`
   - 群消息先写进 `gmsg` 缓存(群聊记忆工具用),全量接收模式下没 @ 机器人的也存
   - 再做群白名单检查(不在名单里直接忽略,并记日志)
   - 再匹配斜杠命令(`/帮助` `/查信息` `/压缩` `/记忆` `/状态` `/清空`)
   - 其余交给 `runAgent()`
4. **回复**:被动优先、主动兜底 —— 回执只在被动窗口内发(省主动额度),
   结果默认走被动回复,超窗或发不出去时自动改主动消息重试一次
5. **收尾**:把这一轮写进会话历史,超长自动压缩

> 为什么非要 Durable Object?QQ 要求 5 秒内 ACK,而一次带思考的模型调用要几十秒。
> Worker 的请求活不了那么久(`waitUntil` 只给 30 秒),所以重活必须在 DO 里干。
> 免费版 DO 用 SQLite 存储,没人访问时会休眠,不占资源。

---

## 三、数据存在哪

### D1(`env.DB`)—— 结构化数据

| 表 | 存什么 |
| --- | --- |
| `settings` | 面板里配置的一切(AI、搜索、QQ、人设、群聊、管理员、部署参数、日志参数) |
| `logs` | 运行日志,按时间清理 |
| `stats` / `daily` | 累计计数器与按天统计 |
| `groups` | 用过机器人的群聊(openID、消息数、最近活跃) |
| `projects` | 项目清单(ID、名称、到期时间、占用、访问次数) |
| `files` | 每个项目里每个文件的元信息(大小、压缩后大小、MIME、是否 gzip) |
| `sdata` | 部署页面通过 `/__data/` 存的小数据 |
| `skills` | 技能文档(按触发词注入系统提示词) |
| `exts` | 扩展开关与外部扩展配置 |
| `modules` | 预制后端 JS 模块(代码、参数、调用点) |
| `stusage` | 各存储的用量统计 |
| `admins` / `mcp` / `logins` / `usage` | 管理员、MCP 服务器、登录限流、写入计数 |

### KV / R2 / S3 —— 部署出来的文件本体

- 统一存储层(`src/store/storage.js`):写入时按优先级挑第一个「启用 + 可用 + 有余量」的存储
  - `r2`:绑了 `env.R2` 就自动出现,优先级 100(主存储)
  - `s3`:面板里手动添加的 S3 兼容存储,默认优先级 50
  - `kv`:绑了 `env.STORE` 就自动出现,优先级 10;主存储不是 KV 时顺带写一份当缓存
- 键:`f/<8位ID>/<文件路径>`;文本类超过 96 字节就 gzip,图片视频原样存
- 删除项目时按前缀 `f/<id>/` 全部清掉

### DO 内部 SQLite —— 只放跟会话有关的

`conv` / `msg`(会话与历史)、`mem`(长期记忆)、`jobs`(队列)、`fs`(AI 沙盒)、`gmsg`(群消息缓存)、`kv`(临时键值,比如 token 缓存)

---

## 四、空间是怎么分的

KV 免费额度约 1 GB,分三层(实现在 `src/store/projects.js` 的 `quotaOf()`):

```
总容量 1 GB
├── 固定保留        默认  64 MB   —— 给缓存、杂项留的,项目动不了
├── 每项目保底      默认  64 MB × 同时项目数
└── 动态池          剩下的全部
```

- 改「同时项目数」不会动每项目的保底;但**保底 × 数量**不能超过总容量,
  超了保存时会自动降到能支持的最大数量,并在面板上提示
- 动态池按优先级分:访问量高、刚建不久的权重更高
- 单个项目实际可用 = 保底 + 它当前分到的动态份额

页面访问计数不会每次都写库:先在内存里攒,够 10 次或过了 30 秒才批量写一次。

---

## 五、面板

- 路由都挂在 `/administrator` 下,接口在 `/administrator/api/*`
- 登录:`POST /api/login` 比对环境变量里的用户名密码(定长比较,防时序侧信道),
  失败按 IP 计数,5 次锁 15 分钟;成功下发一个 HMAC 签名的 Cookie
- 所有写操作要求 `SameSite=Strict` + 同源校验
- 前端是一个文件(`src/panel/ui.js`),原生 JS、零依赖、零构建,深色侧栏 + 浅色内容区
- 九个页面:首页、MCP 设置、技能、扩展、模块、部署项目、存储、设置、日志
- 密钥类字段回读时自动打码(`sk-a****1234`),把打码值提交回来时后端会保留原值

---

## 六、安全上的几个刻意选择

- **没有 `/health` `/check`**:早期版本用它们自检,但任何人都能看,等于免费送情报,已删除
- **WebHook 验签失败一律 401**(fail-closed),不会「验证不了就放行」
- **面板需要登录**才能看到任何数据;未登录时只有登录页
- **部署项目不执行服务端代码**:只吐静态文件,杜绝拿你的域名跑任意逻辑
- **路径守卫**:文件路径里的 `..`、绝对路径、非法字符都会被拒
- **密钥不落库到代码**:仓库里 `wrangler.toml` 的两个变量都是空的,密钥只存在 Cloudflare 与 D1 里

---

## 七、文件地图

```
src/
  index.js            Worker 入口与路由
  config.js           环境变量、常量、默认设置、扁平化(把设置摊平成 cfg)
  serve.js            部署页面的服务逻辑(含 /__data/ 接口)
  store/
    db.js             D1 表结构 + 查询小工具
    settings.js       设置读写(带 5 秒缓存)+ 打码
    logs.js           日志写入/查询/清理
    stats.js          计数器与概览
    projects.js       项目 CRUD、配额计算、文件写入
    kvfile.js         站点文件读写(路径规范、gzip、MIME)
    storage.js        统一存储层(KV / R2 / S3:自动选路、镜像缓存、用量)
    s3.js             S3 兼容存储的 SigV4 客户端
    modules.js        预制后端 JS 模块的读写
  panel/
    auth.js           登录、会话 Cookie、限流
    api.js            面板所有接口(含存储 / 模块 / 技能 / 扩展)
    ui.js             面板前端(单文件)
  qq/
    gateway.js        WebSocket 网关:握手、心跳、重连、事件分发
    webhook.js        回调模式:验签、归一化、入队
    sign.js           Ed25519 验签与 op=13 签名
    api.js            取 token、发群消息/单聊消息
  core/
    do.js             BotCore:队列、命令、上下文、站点工具、沙盒、群消息缓存、WebSocket 宿主
    schema.js         DO 内部表
    jsmini.js         JavaScript 迷你解释器(Workers 禁 eval,沙盒靠它)
    jsmini-run.js     解释器的运行时(把代码跑起来、限步数、超时)
    backend.js        后端沙盒执行器(预制模块从这里跑;含安全 fetch)
  agent/
    loop.js           Agent 主循环(多轮工具调用)
    llm.js            模型调用与降级阶梯
    tools.js          工具定义
    exec.js           工具执行
    exts.js           扩展系统(内置工具组开关 + 外部 HTTP 扩展)
    skills.js         技能注入(按触发词挑选)
    mcp.js            MCP 客户端(Streamable HTTP / SSE)
    search.js         搜索与网页读取适配(单地址 → /search + /reader)
    prompt.js         系统提示词与人设
  util/               文本、计算、编码、字节等小工具
```

---

## 八、想加东西时改哪

| 想做什么 | 改哪 |
| --- | --- |
| 给 AI 加一个新工具 | `agent/tools.js` 加定义 + `agent/exec.js` 加分支 |
| 面板加一个页面 | `panel/ui.js` 加渲染函数与导航项 + `panel/api.js` 加接口 |
| 加一种搜索服务商 | `agent/search.js` 的 `detectProvider` 与 `buildRequest` |
| 加一个 D1 表 | `store/db.js` 的 `DDL` 数组,并把 `SCHEMA_VERSION` 加一 |
| 改默认部署时长/空间 | 面板「设置 → 部署参数」,或 `config.js` 的 `DEFAULT_SETTINGS` |
| 改机器人说话风格 | 面板「设置 → 人设提示词」,或 `agent/prompt.js` |

---

## 九、测试

```
npm test                 单元测试  144 项(纯逻辑:配额、鉴权、压缩、网关帧处理、技能挑选、存储选路……)
npm run test:jsmini      沙盒解释器 59 项(语法、运算、作用域、超时、防死循环)
npm run test:integration 集成测试  68 项(假上游 + 真 Worker 代码)
npm run test:all         敏感扫描 + 上面全部
```

集成测试会现场起三个假服务器:

1. **假 QQ 开放平台**:发 token、收消息
2. **假大模型接口**:返回固定回复,顺带支持 `/models`
3. **假 MCP 服务器**:实现 `initialize` / `tools/list` / `tools/call`

然后用 `node:sqlite` 顶掉 D1 与 DO 的 SQLite(`test/harness.js`),
把「登录 → 配置 → 部署 → 访问页面 → 收群消息 → 回复 → MCP 调用 → 看日志」整条链路真跑一遍。

> 之所以要自己写 harness:本项目的开发环境是手机上的 proot,
> workerd 起不来(tcmalloc 要求 48 位地址空间),只能这样在 Node 里跑真实代码。

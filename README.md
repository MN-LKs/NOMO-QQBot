# NOMO-QQBot

QQ 官方机器人 + AI Agent + 在线部署,跑在 Cloudflare Workers 上。

自带一个网页管理面板:AI 接口、联网搜索、APPID/AppSecret、连接方式、群聊权限、部署的项目、日志,
全部在面板里点几下就能改,不用再碰环境变量。

> 面向大众的部署教程见 [docs/QUICKSTART.md](docs/QUICKSTART.md)(15 分钟,带检查清单) ·
> 常见问题见 [docs/FAQ.md](docs/FAQ.md) ·
> 全部功能清单见 [docs/FEATURES.md](docs/FEATURES.md) ·
> 代码结构与数据流见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## 它有什么

**两种连接方式,面板里随时切**

- **WebHook(默认)**:腾讯把消息推到你的 Worker。没人说话时 Durable Object 完全休眠,
  不占 Cloudflare 额度;需要在 QQ 开放平台填一个回调地址(面板会把地址算好给你复制)。
- **WebSocket(可选)**:机器人主动连腾讯的网关,不需要开放平台配置、公网不暴露入口;
  代价是常驻连接会持续消耗 Durable Object 时长(免费额度 24 小时约吃掉八成)。

**管理面板**(`/administrator`)

| 页面 | 能干什么 |
| --- | --- |
| 首页 | 累计/今日访问量、消息数、部署数,近 14 天柱状图,用过机器人的群聊列表 |
| MCP 设置 | 接入 MCP 服务器(Streamable HTTP / SSE),连接后能看到它有哪些工具,逐个开关 |
| 技能 | 写给机器人的专项知识,按触发词注入系统提示词;支持粘贴 SKILL.md 自动解析成表单 |
| 扩展 | 内置工具组开关 + 外部 HTTP 扩展(填一份工具定义,模型就能调用它) |
| 模块 | 预制后端 JS 模块:写代码、定义参数、勾选调用点(Agent 工具 / 站点后端),可在线测试 |
| 部署项目 | 项目列表、详情、占用比例、文件预览、续期、删除;也能直接在面板里粘贴 HTML 部署 |
| 存储 | KV / R2 / S3 兼容存储:绑定状态、优先级、容量与用量,在线测试与扫描 |
| 设置 | AI 接口(含一键测试、单次请求限时开关)、联网搜索、人设、QQ 凭据、连接方式与结果投递策略、群聊权限、管理员、站点域名、部署参数与部署架构、日志参数 |
| 日志 | 全部运行日志,按级别筛选、下载、复制、清空,调试模式开关 |

**AI Agent 能力**

- 聊天、答疑、翻译、写文案、算数(算术走工具,不心算)
- 联网搜索 + 读网页正文:一个「到 /v1 为止」的接口地址,搜索自动走 `/search`、读取自动走 `/reader`;
  支持秘塔、Exa、Tavily、Serper、Brave、Bing、Google 等,按域名自动识别,其余走通用模式
- 写代码并**直接部署成公网网页**,给用户一个能打开的链接
- 部署的网页可以调后端:管理员备好的**预制模块**,或页面自带的 `_backend.js`(沙盒执行、禁内网、每站独立数据存储、有频率限制;默认关闭,在设置里开启)
- 沙盒草稿区:先写文件、再改、最后一次性部署
- 群聊记忆:能查群消息缓存、按关键词找群(配合 QQ 后台的「机器人可查询群内所有消息」食用更佳)
- 中转站用量查询(面板里填中转站的面板地址)
- 记住群里的约定(说「记住 xxx」),上下文自动压缩
- MCP 工具、掷骰子抽签、编解码、JSON 格式化
- 非流式长任务:单次请求默认**不设时间上限**,多轮工具调用、多次非流式慢慢跑完;
  想限时的话,设置里有开关和最大秒数。多条消息并行处理,互不堵塞

**部署项目**

- 纯静态 HTML / CSS / JS,不跑服务端代码
- 文件优先存 R2(绑了的话),否则 KV;文本自动 gzip 压缩,页面直读不查库,加载更快
- 空间按「固定保留 + 每项目保底 + 动态池」分配,动态池按访问量优先给忙的项目
- 到期自动销毁,删除时连同存储与 D1 里的数据一起清干净
- 页面还能用 `/__data/<键>` 存一点小数据(默认每个项目 256 KB)
- 自动补齐 SEO / 质量分标签(charset、description、canonical、Open Graph、Twitter Card、JSON-LD、favicon 等),
  AI 漏写的用默认值,已经写好的不覆盖;裸片段会自动包成完整 HTML
- 面板里填好**站点域名**后,机器人给你的部署链接就是完整可点的网址

---

## 快速开始

1. **Fork / 导入这个仓库**,在 Cloudflare 后台创建 Worker 并连上仓库
2. 创建 **D1 数据库**(比如 `nomo-qqbot`)和 **KV 命名空间**(比如 `nomo-qqbot-store`);
   可选再建一个 **R2 存储桶**(绑上之后部署文件优先存 R2,免费额度 10 GB)
3. 在 Worker 的 **Settings → Bindings** 里绑定:
   - D1 database → 变量名 **`DB`**
   - KV namespace → 变量名 **`STORE`**
   - R2 bucket → 变量名 **`R2`**(可选)
4. 在 **Settings → Variables and Secrets** 里加两个 **Secret**:
   - `ADMIN_USER` 面板用户名
   - `ADMIN_PASS` 面板密码(请用长一点的)
   仓库已开启 `keep_vars = true`;如果 `[vars]` 里有迁移用空值,填完值后要删掉
5. 部署完成后打开 `https://<你的域名>/administrator`,用上面那对账号登录
6. 在面板的**设置**里填:AI 接口(地址 + Key + 模型)、QQ 的 APPID 与 AppSecret
7. 连接方式保持 **WebHook**(默认),把面板算好的回调地址填到 QQ 开放平台;
   或者切成 **WebSocket**,不用填任何回调地址
8. 点保存并应用,回首页看系统信息

详细步骤(含每一步的说明和排错)看 [docs/DEPLOY.md](docs/DEPLOY.md)。

---

## 更新到最新版(OTA)

| 你的部署方式 | 怎么更新 |
| --- | --- |
| 连了 GitHub 仓库(推荐) | 往仓库推一次提交,Cloudflare Workers Builds 自动重新构建并部署 |
| 本地克隆 | `git pull` 后 `npm run deploy` |

- 更新不会动 D1 / KV / R2 里的数据(配置、项目、日志都还在)
- 构建记录在 CF 后台 → **Deployments**,失败可以回滚到上一个版本
- 仓库里的 `tools/strip-docs.js` 会在 Cloudflare 构建时清理 README、docs 等
  描述文件;只在构建环境生效,本地 `wrangler dev/deploy` 不会动你的文件


---

## 在群里怎么用

```
@机器人 /帮助         看使用说明
@机器人 /AI 你的问题   和 AI 对话(直接说话也行)
直接发 /AI 你的问题     群里不 @ 也能用(需 QQ 后台开启全量接收;此时其余聊天不会触发 AI)
@机器人 /查信息        看自己的 openID 和群聊 openID,拿去面板里授权
@机器人 /压缩          把聊天记录压成摘要
@机器人 /记忆          看记住了什么
@机器人 /状态          看运行状态
@机器人 /清空          清掉这个会话的上下文
```

更多命令见 [docs/COMMANDS.md](docs/COMMANDS.md)。

---

## 开发与测试

```bash
npm install
npm run audit              # 静态自检(语法 / import / 脚本 / 文档链接)
npm test                   # 单元测试(纯逻辑,200 项)
npm run test:jsmini        # 沙盒 JS 解释器测试(59 项)
npm run test:integration   # 集成测试(假上游 + 真 Worker 代码,84 项)
npm run test:all           # 静态自检 + 敏感信息扫描 + 上面全部(合计 343 项)
```

集成测试会自己起假服务器(QQ 开放平台、大模型接口、MCP 服务器),
然后用 `node:sqlite` 顶掉 D1 与 Durable Object 的 SQLite,
所以不需要任何线上资源就能把整条链路跑一遍。

---

## 目录结构

```
src/
  index.js         Worker 入口:面板、回调、部署页面的路由
  config.js        环境变量 + 常量 + 默认设置(面板里能改的一切)
  serve.js         部署页面的服务逻辑(含 /__data/ 接口)
  store/           D1 与存储的数据层(设置、日志、统计、项目、文件、存储桶、模块)
  panel/           管理面板:鉴权、接口、前端页面
  qq/              腾讯开放平台:网关、回调验签、发消息
  core/            Durable Object:队列、会话上下文、沙盒、群消息缓存;jsmini 沙盒解释器
  agent/           AI Agent:模型调用、工具、扩展、技能、MCP、搜索、提示词
  util/            文本、计算、编码等小工具
test/              单元测试 + 沙盒测试 + 集成测试
tools/             静态自检、敏感信息扫描、部署前描述文件清理
```

## 许可

AGPL-3.0

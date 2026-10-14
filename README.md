# NPAPI

QQ 官方机器人 + AI Agent + 在线部署,跑在 Cloudflare Workers 上。

自带一个网页管理面板:AI 接口、联网搜索、APPID/AppSecret、连接方式、群聊权限、部署的项目、日志,
全部在面板里点几下就能改,不用再碰环境变量。

> 面向大众的部署教程见 [docs/DEPLOY.md](docs/DEPLOY.md) ·
> 代码结构与数据流见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## 它有什么

**两种连接方式,面板里随时切**

- **WebSocket(默认,推荐)**:机器人主动连腾讯的网关。不需要去开放平台填回调地址,
  也就不会把任何一个公网地址暴露出去,别人找不到、打不着。断线自动重连,每 2 分钟兜底检查一次。
- **WebHook(可选)**:传统回调模式。需要去开放平台填地址,面板会把回调地址算好给你复制。
  如果域名前面挂着 Cloudflare 的质询,记得按 [docs/DEPLOY.md](docs/DEPLOY.md) 里的说明放行。

**管理面板**(`/administrator`)

| 页面 | 能干什么 |
| --- | --- |
| 首页 | 累计/今日访问量、消息数、部署数,近 14 天柱状图,用过机器人的群聊列表 |
| MCP 设置 | 接入 MCP 服务器(Streamable HTTP / SSE),连接后能看到它有哪些工具,逐个开关 |
| 部署项目 | 项目列表、详情、占用比例、文件预览、续期、删除;也能直接在面板里粘贴 HTML 部署 |
| 设置 | AI 接口(含一键测试)、联网搜索、人设、QQ 凭据、连接方式、群聊权限、管理员、部署参数、日志参数 |
| 日志 | 全部运行日志,按级别筛选、下载、复制、清空,调试模式开关 |

**AI Agent 能力**

- 聊天、答疑、翻译、写文案、算数(算术走工具,不心算)
- 联网搜索 + 读网页正文
- 写代码并**直接部署成公网网页**,给用户一个能打开的链接
- 沙盒草稿区:先写文件、再改、最后一次性部署
- 记住群里的约定(说「记住 xxx」),上下文自动压缩
- MCP 工具、掷骰子抽签、编解码、JSON 格式化

**部署项目**

- 纯静态 HTML / CSS / JS,不跑服务端代码
- 数据存在 KV,内容 gzip 压缩,比原始体积小一半以上
- 空间按「固定保留 + 每项目保底 + 动态池」分配,动态池按访问量优先给忙的项目
- 到期自动销毁,删除时连同 KV 与 D1 里的数据一起清干净
- 页面还能用 `/__data/<键>` 存一点小数据(默认每个项目 256 KB)

---

## 快速开始

1. **Fork / 导入这个仓库**,在 Cloudflare 后台创建 Worker 并连上仓库
2. 创建 **D1 数据库**(名字随意,比如 `npapi`)和 **KV 命名空间**(比如 `npapi-store`)
3. 在 Worker 的 **Settings → Bindings** 里绑定:
   - D1 database → 变量名 **`DB`**
   - KV namespace → 变量名 **`STORE`**
4. 在 **Settings → Variables** 里加两个变量:
   - `ADMIN_USER` 面板用户名
   - `ADMIN_PASS` 面板密码(请用长一点的)
5. 部署完成后打开 `https://<你的域名>/administrator`,用上面那对账号登录
6. 在面板的**设置**里填:AI 接口(地址 + Key + 模型)、QQ 的 APPID 与 AppSecret
7. 连接方式保持 **WebSocket**,保存。回首页看系统信息里是否已连上

详细步骤(含每一步的截图级说明和排错)看 [docs/DEPLOY.md](docs/DEPLOY.md)。

---

## 在群里怎么用

```
@机器人 /帮助         看使用说明
@机器人 /AI 你的问题   和 AI 对话(直接说话也行)
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
npm test              # 单元测试(纯逻辑,69 项)
npm run test:integration   # 集成测试(假上游 + 真 Worker 代码,47 项)
npm run test:all      # 敏感信息扫描 + 上面两套
```

集成测试会自己起三个假服务器(QQ 开放平台、大模型接口、MCP 服务器),
然后用 `node:sqlite` 顶掉 D1 与 Durable Object 的 SQLite,
所以不需要任何线上资源就能把整条链路跑一遍。

---

## 目录结构

```
src/
  index.js         Worker 入口:面板、回调、部署页面的路由
  config.js        两个环境变量 + 常量 + 默认设置
  store/           D1 与 KV 的数据层(设置、日志、统计、项目、文件)
  panel/           管理面板:鉴权、接口、前端页面
  qq/              腾讯开放平台:网关、回调验签、发消息
  core/            Durable Object:队列、会话上下文、沙盒、WebSocket 宿主
  agent/           AI Agent:模型调用、工具、MCP、搜索、提示词
  util/            文本、计算、编码等小工具
test/              单元测试 + 集成测试
tools/             敏感信息扫描
```

## 许可

AGPL-3.0

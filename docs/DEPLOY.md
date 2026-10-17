# 部署教程

从零到机器人能在群里说话,大概 10 分钟。全程只需要一个 Cloudflare 账号(免费版够用)。

---

## 一、创建 Worker 并连上仓库

1. 把本仓库 Fork 到自己的 GitHub(或直接导入)。
2. Cloudflare 后台 → **Workers & Pages** → **Create** → **Workers** → **Import a repository**。
3. 选中你的仓库,构建命令留空(默认会跑 `npx wrangler deploy`),部署。

> Worker 名字取自 `wrangler.toml` 里的 `name`(默认 `nomo-qqbot`)。
> 部署完它的地址形如 `https://nomo-qqbot.<你的账号子域>.workers.dev`。

---

## 二、创建并绑定 D1 与 KV

这两个是必须的:**D1** 存配置、日志、统计、项目清单;**KV** 存部署出来的网页文件。
可选再绑一个 **R2 存储桶**:绑上之后部署文件会优先存 R2(免费额度 10 GB),KV 退居缓存。

### 1. 创建

- Cloudflare 后台 → **Storage & Databases** → **D1** → **Create database**,名字填 `nomo-qqbot`
- 同一页 → **KV** → **Create namespace**,名字填 `nomo-qqbot-store`
- (可选)同一页 → **R2** → **Create bucket**,名字填 `nomo-qqbot`

### 2. 绑定

进你的 Worker → **Settings** → **Bindings** → **Add binding**:

| 类型 | 变量名(Variable name) | 选什么 |
| --- | --- | --- |
| D1 database | **`DB`** | 刚建的 `nomo-qqbot` |
| KV namespace | **`STORE`** | 刚建的 `nomo-qqbot-store` |
| R2 bucket(可选) | **`R2`** | 刚建的 `nomo-qqbot` |

> 变量名必须是 `DB` 和 `STORE`,大小写都不能改。
> 如果你更习惯用 `wrangler.toml` 管理,把 `wrangler.toml` 里那两段注释打开、填上 ID 也行。

### 3. 重新部署一次

绑定加好后,去 **Deployments** 点一次 **Retry deployment**(或随便提交一次代码),让新绑定生效。

---

## 三、设置两个环境变量

Worker → **Settings** → **Variables and Secrets**,加两条(建议都用 **Secret** 类型):

| 变量名 | 说明 |
| --- | --- |
| `ADMIN_USER` | 面板登录用户名 |
| `ADMIN_PASS` | 面板登录密码,建议 16 位以上随机串 |

就这两个。其它配置都在面板里填,存进 D1,不会再出现在环境变量里。

> 没配这两个变量时,访问任何地址都会提示你去配,不会白屏。

---

## 四、第一次登录面板

打开 `https://<你的地址>/administrator`:

- 连续输错 5 次密码,该 IP 会被锁定 15 分钟。
- 登录状态保存在一个签名 Cookie 里,7 天有效,改密码会让旧登录立刻失效。

登录后会看到五个页面:**首页 / MCP 设置 / 部署项目 / 设置 / 日志**。

---

## 五、在面板里配置 AI

进 **设置 → AI 接口**:

1. **接口地址**:填到 `/v1` 那一层,例如 `https://api.example.com/v1`
2. **API Key**:填你的密钥
3. 点 **获取模型列表** → 从下拉里点一个模型,自动填进「模型 ID」
4. 点 **测试模型**,会弹窗跑两项检查:
   - **基础对话**:发一句 `Hello, Introduce yourself briefly.`,看有没有正常回复
   - **工具调用**:给模型一个没有参数的 `get_current_time` 工具,看它会不会正确调用
   - 失败会把完整报错打在弹窗里,右上角有「复制结果」
5. 推理等级按需选(默认 `max`),深度思考默认开启
6. **保存**

### 顺带把联网搜索也配上(可选)

同一页往下是**联网搜索**卡片:

1. **接口地址 Base URL**:填到 `/v1` 那一层,例如 `https://api.example.com/v1`;
   关键词搜索会自动走 `/search`,网页读取会自动走 `/reader`(路径不合适可以改)
2. **API Key**:填密钥
3. 点 **测试搜索与读取**:弹窗里会同时跑一遍关键词搜索和网页读取,带原始返回片段,方便排查
4. 支持秘塔、Exa、Tavily、Serper、Brave、Bing、Google 等,按域名自动识别;
   识别不出的服务商走通用模式,返回结构和读取字段也能在「返回结构映射」里手动指定

不配也能用,机器人只是不能联网。

## 六、在面板里配置 QQ 机器人

还在 **设置** 页面往下:

1. 填 **APPID** 和 **App Secret**(在 QQ 机器人管理端 → 开发设置 → 机器人资料里找)
2. **运行环境**:机器人已经上线选「正式环境」;还在开发调试选「沙箱环境」
   (沙箱只会收到开放平台里配置过的沙箱账号的事件,且沙箱暂不支持群聊)
3. **连接方式** 保持 **WebHook**(默认)。面板会把回调地址算好,复制到
   QQ 机器人管理端 → **开发设置 → 回调配置**(详细步骤见第七节);
   不想配回调的话就切成 **WebSocket**
4. 点 **保存并应用**

> 接口域名已经按官方文档写死:取 token 走 `bots.qq.com`,
> 正式环境走 `api.sgroup.qq.com`,沙箱走 `sandbox.api.sgroup.qq.com`,不需要你填。

---

## 七、连接方式怎么选

### WebHook(默认)

- 腾讯把消息推到你的 Worker;没人说话时 Durable Object 完全休眠,不占 Cloudflare 额度
- 需要去开放平台填回调地址:面板会自动把地址算好(「设置 → QQ 机器人 → 回调地址」),
  复制到 [QQ 机器人管理端](https://q.qq.com/qqbot) → **开发设置 → 回调配置**,监听事件至少勾上:
  - `GROUP_AT_MESSAGE_CREATE`(群里 @ 机器人)
  - `C2C_MESSAGE_CREATE`(单聊)
  - `GROUP_ADD_ROBOT`(被拉进群)

保存时腾讯会发一个 `op=13` 的验证请求,本项目会用 AppSecret 自动签名回应,正常会直接通过。

> **如果提示「校验失败」或者群里 @ 没反应**
> 先确认回调地址能通:
>
> ```bash
> curl -i -X POST https://<你的地址>/qq/webhook -H 'User-Agent: QQBot-Callback' -d '{}'
> ```
>
> 响应头里出现 `cf-mitigated: challenge` 就是被 Cloudflare 的托管质询拦了 ——
> 腾讯的服务器不执行 JavaScript,过不去。三种解法:
>
> 1. 关掉整个域名的托管质询
> 2. 加一条 WAF 规则跳过:`(http.host eq "你的域名" and starts_with(http.request.uri.path, "/qq/webhook"))`
> 3. 换个干净的域名专门跑回调
>
> 不想折腾这些,直接切到 **WebSocket** 模式就好,压根不需要回调地址。

### WebSocket(可选)

- 机器人主动连腾讯的网关,**不需要**在开放平台填任何回调地址
- 公网不暴露入口,别人扫不到你的机器人后台,也没法拿你的地址刷请求
- 断线自动重连,另外每 2 分钟有一次兜底检查
- 注意:这种方式下 Worker 会长期保持一个连接,会消耗 Cloudflare 免费额度里的
  Durable Object 时长(24 小时大约占掉八成),日常够用,但别再多开常驻 DO

---

## 八、让群能用机器人

默认情况下,**只有被授权的群才能用**。

1. 把机器人拉进群,在群里 @它 发 `/查信息`
2. 它会回你的 openID 和群聊 openID
3. 把群聊 openID 复制到 **设置 → 群聊权限** 里添加

或者直接把 **允许所有群聊** 打开:任何拉过机器人的群都能用,并会自动收录进列表。
群里的管理员想直接用管理功能,可以在 **设置 → 管理员** 里加他的 openID,
或者打开 **群管理员即机器人管理员**。

---

## 九、排错表

| 现象 | 多半是什么 |
| --- | --- |
| 打开面板提示没配管理员账号 | `ADMIN_USER` / `ADMIN_PASS` 没加,或没重新部署 |
| 面板能开,但保存设置报错 | `DB` 绑定缺失或名字不对 |
| 部署项目报「KV 容量」相关错误 | `STORE` 绑定缺失 |
| 机器人不回复 | WebHook 模式:回调没配上或校验失败(见第七节);WebSocket 模式:看首页是否已连接、APPID/AppSecret 是否填错 |
| 测试模型「基础对话」失败 | 接口地址没填到 `/v1`,或 Key 不对 |
| 测试模型「工具调用」失败 | 该模型不支持 function calling,换一个 |
| 群里 @ 没反应,日志里有「不在白名单」 | 群没授权,去「设置 → 群聊权限」加它,或打开允许所有群聊 |
| WebHook 模式一直校验失败 | 见上面第七节,大概率是 Cloudflare 质询 |
| 部署的网页 404 | 项目过期了(默认 10 分钟),或没放 `index.html` |

日志页会记录上面这些环节的每一步,排错先看 **日志** 页面。

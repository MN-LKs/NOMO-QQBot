# 部署手册

## 一、准备工作

需要:

- 一个 Cloudflare 账号(免费版即可)
- 这个仓库的访问权
- QQ 开放平台的机器人(已经有 APPID / AppSecret)

## 二、部署到 Cloudflare Workers

### 方式 A:GitHub 联动(推荐)

1. Cloudflare Dashboard → **Workers & Pages** → **创建应用程序** → **Workers** → **连接到 Git**
2. 授权 GitHub,选择 `MN-LKs/NPAPI`
3. 构建设置:
   - **构建命令**:`npm install`
   - **部署命令**:`npx wrangler deploy`
   - 根目录保持默认 `/`
4. 保存并部署

之后每次 push 到默认分支都会自动重新部署,这就是「更新仓库即更新 Bot 服务」。

### 方式 B:本地 wrangler

```bash
git clone https://github.com/MN-LKs/NPAPI.git
cd NPAPI
npm install
npx wrangler login      # 浏览器授权一次
npx wrangler deploy
```

## 二点五、填变量(必做,不填机器人不工作)

仓库里的 `wrangler.toml` 把 `[vars]` **全部留空了** —— 因为这个仓库是公开的,凭据写进去就等于泄露。

到 **Workers & Pages → 你的 Worker → Settings → Variables and Secrets** 逐个添加:

| 变量 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `QQ_APP_ID` | 文本 | ✅ | 机器人 AppID |
| `QQ_APP_SECRET` | **Secret** | ✅ | 机器人 AppSecret |
| `LLM_BASE_URL` | 文本 | ✅ | 上游网关,例如 `https://api.example.com/v1` |
| `LLM_API_KEY` | **Secret** | ✅ | 上游 API Key |
| `SEARCH_API_URL` | 文本 | — | 联网搜索接口,不填则搜索不可用 |
| `SEARCH_API_KEY` | **Secret** | — | 联网搜索密钥 |
| `PUBLIC_BASE_URL` | 文本 | — | 部署链接的域名,例如 `https://ai.example.com` |

**就这 7 个。** 模型名、思考档位、部署名额、存活时长这些固定参数写在 `src/config.js` 里,不用配。

> 用 GitHub 联动部署时,这些变量**不会**从仓库带过去,必须在 Cloudflare 后台配一次,之后一直有效。
> 命令行也行:`npx wrangler secret put QQ_APP_SECRET` 等等。

填完打开 `https://<你的地址>/check`,**缺哪一项它会直接列出来**。

> 提交任何改动前,先跑一次 `node tools/scan-secrets.js`(或 `npm run check:secrets`),
> 它会拦下密钥、私钥、被填了值的 `wrangler.toml` 变量。CI 里也会跑同一份检查。

## 三、配置 QQ 回调地址

1. 部署完在 Workers 列表里能看到地址:`https://npapi.<子域>.workers.dev`
2. 打开 `https://<这个地址>/check`,先确认自检全绿
3. 到 [QQ 机器人管理端](https://q.qq.com/qqbot) → 开发设置 → **回调配置**
4. 填入:

   ```
   https://npapi.<子域>.workers.dev/qq/webhook
   ```

5. 监听事件至少勾上:
   - `GROUP_AT_MESSAGE_CREATE`(群里 @ 机器人)
   - `C2C_MESSAGE_CREATE`(单聊)
   - `GROUP_ADD_ROBOT`(被拉进群)
6. 点保存。腾讯会立刻发一个 `op=13` 的验证请求,本项目会自动签名回应。

> **验证一直失败怎么办?**
> 1. 打开 `/check`,看 `回调地址` 那一行给出的完整地址,直接复制它
> 3. 确认 Workers 已经部署成功(访问 `/health` 应该返回 `{"ok":true}`)
> 4. 用 `npx wrangler tail` 看有没有收到请求

## 三点五、配置 QQ 自带的「指令面板」(可选)

用户在群里 @ 机器人时,QQ 客户端会弹出一个**原生的指令列表**。这个列表不是代码能设置的,
要去开放平台后台填:

[QQ 机器人管理端](https://q.qq.com/qqbot) → **开发设置** → **指令配置** → 新增指令

按下面填,和机器人自己的行为对齐:

| 指令名 | 说明 | 使用示例 |
|---|---|---|
| `/AI` | 和 AI 对话 | `/AI 帮我写个 2048 小游戏` |
| `/帮助` | 查看机器人能力说明 | `/帮助` |
| `/压缩` | 把聊天记录压成摘要,省上下文 | `/压缩` |
| `/delete` | 清空当前会话的全部记忆 | `/delete` |
| `/状态` | 查看当前会话与运行状态 | `/状态` |

> 不配也能用 —— 直接 @ 机器人(不带内容)时,机器人会自己回一份指令帮助。

## 四、绑定自定义域名(可选)

想得到 `https://ai.example.com/<8字符>` 这样的部署链接:

1. `example.com` 必须已经托管在**同一个** Cloudflare 账号下
2. 编辑 `wrangler.toml`,去掉末尾注释:

   ```toml
   [[routes]]
   pattern   = "ai.example.com/*"
   zone_name = "example.com"
   ```

3. 重新部署。Cloudflare 会自动给这个子域签发证书
4. 之后回调地址也可以换成 `https://ai.example.com/qq/webhook`

> 域名下的所有路径都归这个 Worker,包括 `/qq/webhook`、`/check` 和部署出来的页面。
> 项目已经保留了 `qq`、`api`、`admin`、`health`、`check` 等保留字,部署 ID 不会撞车。

## 四点五、⚠️ 域名上开着 Cloudflare 质询 = 机器人收不到消息

这是最容易踩、而且看起来最像「代码坏了」的坑,先说清楚。

**现象**:浏览器打开 `/check` 一切正常(人过了质询),但群里 @ 机器人毫无反应,
`wrangler tail` 里一条日志都没有 —— 因为请求根本没到 Worker。

**原因**:腾讯的服务器要 POST 到你的回调地址,它不会执行 JavaScript,过不了质询。
Cloudflare 在 Worker 之前就把请求拦下,回了 `403` + 一张 `Just a moment...` 页面。

**怎么判断**:`curl` 一下自己的回调地址,如果返回 403 且响应头里有

```
cf-mitigated: challenge
```

那就是被质询拦了。这个头只要出现,机器人的回调就一定收不到。

```bash
curl -i -X POST https://ai.example.com/qq/webhook \
     -H 'User-Agent: QQBot-Callback' -H 'Content-Type: application/json' -d '{}'
```

**怎么修**,按推荐顺序:

1. **关掉整站的质询**(最省事)
   Dashboard → 选中 `example.com` → Security → Settings:
   - **Under Attack Mode**:关掉
   - **Security Level**:改成 `Essentially Off` 或 `Low`
   - **Bot Fight Mode**:关掉
2. **只给回调路径放行**(更安全,推荐)
   Dashboard → Security → WAF → Custom rules → 新建:
   - 表达式:`(http.host eq "ai.example.com" and starts_with(http.request.uri.path, "/qq/webhook"))`
   - 动作:**Skip** → 勾选 `All managed rules`、`Super Bot Fight Mode`、`Managed Challenge`
3. **换个干净的子域做回调**
   比如专门开 `qq.example.com` 只跑回调,不挂任何安全策略;
   部署链接继续用 `ai.example.com`(网页被质询无所谓,人用浏览器点得开)。

> 顺带一提:质询开着的时候,AI 部署出来的网页访客也会被拦一道,体验很差。
> 所以最省心的做法其实是第 1 条。

## 五、上线后检查清单

- [ ] `GET /health` 返回 `{"ok":true}`
- [ ] `GET /check` 全绿
- [ ] 回调配置保存成功(没有「校验失败」)
- [ ] 在测试群 @ 机器人发 `/帮助`,能收到指令列表
- [ ] 发 `@机器人 /AI 你好`,能收到回复
- [ ] 发 `@机器人 帮我写一个 2048 游戏`,能收到链接,点开能玩
- [ ] `npx wrangler tail` 里能看到 `[思考]` 日志(思考过程只在这里)

## 六、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 群里 @ 了没反应,日志里也一条都没有 | 域名开着 Cloudflare 质询,请求被拦在 Worker 之前 —— 见「四点五」 |
| 回调保存时提示校验失败 | 回调地址填错,或者 `QQ_APP_SECRET` 不对;看 `/check` |
| 群里 @ 了没反应 | 开放平台没勾选 `GROUP_AT_MESSAGE_CREATE` 事件;或机器人没进群 |
| 日志里 `[验签失败] signature invalid` | `QQ_APP_SECRET` 填错了 |
| 回复「😵 处理这条消息时出错了」 | 看 `wrangler tail`,通常是上游网关 504 / 额度用完 |
| 部署链接打不开 | 没绑自定义域名时链接是相对的;或已过 10 分钟自动销毁 |
| 群里收到「不允许发送 URL」相关提示 | QQ 对 URL 有风控,项目会自动去掉 `https://` 重发 |
| 部署链接里中文变成了 `%E4%BA%91` 这种 | 已默认改成 `ascii`(纯英文数字);想要中文 ID 就把 `DEPLOY_ID_CHARSET` 改回 `mixed` |

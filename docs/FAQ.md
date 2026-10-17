# 常见问题 Q&A

> 第一次部署请先看 [QUICKSTART.md](QUICKSTART.md);完整部署步骤在 [DEPLOY.md](DEPLOY.md)。
> 这里按「现象 → 原因 → 解决」回答最常见的问题。

---

## 一、登录与初始化

### 登录功能已关闭

**现象**:打开 `/administrator` 只看到一个「登录功能已关闭」的锁定页,没有登录框。

**原因**:这个实例没有配置管理员账号。系统找不到 `ADMIN_USER` / `ADMIN_PASS` 时会把登录功能直接锁死,而不是摆一个永远登不进去的表单。

**解决**:

1. Cloudflare 后台 → Workers & Pages → 你的 Worker → **Settings → Variables and Secrets**
2. 添加两条:**`ADMIN_USER`**(用户名)、**`ADMIN_PASS`**(密码,建议 16 位以上随机串),类型选 Secret
3. 保存后刷新 `/administrator`
4. 还不行的话:确认变量加在**当前** Worker 上,并且**重新部署一次**让变量生效
   (Deployments → Retry deployment,或往仓库推一次提交)

> 为什么不在页面上直接写「缺哪个变量」?登录页是公网可访问的,
> 把内部配置名摆在页面上既不好看,也容易被扫描器收集。
> 现在统一显示锁定状态,修复方法就写在这里。

### 部署之后变量好像「自己丢了」,面板又锁上了

**原因**:旧版 `wrangler.toml` 里有 `[vars]` 的两个空值
`ADMIN_USER = ""` / `ADMIN_PASS = ""`。`wrangler deploy` 默认会用配置文件里的变量
覆盖后台,所以每次部署都可能把后台变量冲掉或删掉。

**解决**:本仓库已经做了三件事:

1. 删掉了 `[vars]` 里的两个空值;
2. 在 `wrangler.toml` 顶部加了 `keep_vars = true`,以后部署会保留后台变量;
3. 管理员账号改为在后台用 **Secret** 类型添加,Secret 不会被部署删除。

如果变量已经被删了,重新添加一次即可:

1. Settings → Variables and Secrets → Add
2. `ADMIN_USER`(用户名)、`ADMIN_PASS`(密码),类型都选 Secret
3. 保存后刷新 `/administrator`;还不行就 Deployments → Retry deployment

这不是你操作错了,是旧配置的副作用。补一次之后,后续部署不会再丢。

### 打开任何地址都返回 503「服务还没有初始化完成」

**原因**:D1 / KV 没绑定,或者管理员账号没设置。

**解决**:按 [QUICKSTART](QUICKSTART.md) 第二步绑定 `DB`(D1)和 `STORE`(KV),
再设置 `ADMIN_USER` / `ADMIN_PASS`。

### 机器人回复「管理员还没有配置 AI 接口」

**现象**:在群里 @ 机器人,它回一句「⚙️ 管理员还没有配置 AI 接口(缺 …)」。

**原因**:面板里的 AI 接口地址或 API Key 是空的。这是故意的拦截 ——
否则请求会发到一个不存在的地址,用户只能看到一句看不懂的 fetch 报错。

**解决**:

1. 进 **设置 → AI 接口**,确认地址填到 `/v1` 那一层、Key 没有多余空格
2. 点 **测试模型**,两项都通过再保存
3. 保存后不需要重新部署,下一句话就会用新配置

> 地址不用手写 `https://`:没写协议会自动补,粘贴了完整的
> `/chat/completions` 也会自动去掉。保存时如果系统帮你改写了地址,
> 右上角会提示整理后的结果。

### 面板能登录,但保存设置时报错

**原因**:通常是 `DB` 绑定缺失,或者变量名写错(必须叫 `DB`)。

**解决**:Settings → Bindings 里确认 D1 的变量名是 `DB`、KV 的是 `STORE`;
绑定完成后重新部署一次。

---

## 二、部署与更新(OTA)

### 怎么更新到最新版?

两条路径,更新方式不同:

| 部署方式 | 更新方式 |
| --- | --- |
| 绑定仓库(推荐) | 往主仓库推一次提交,Cloudflare Workers Builds 会自动重新构建并部署 —— 这就是本项目的 OTA |
| 本地克隆 | `git pull` 后 `npm run deploy`(或 `npx wrangler deploy`) |

- 在 CF 后台 → Workers & Pages → 你的 Worker → **Deployments** 能看到每次构建记录,失败可以回滚到上一个版本
- 重新部署不会动 D1 / KV / R2 里的数据(配置、项目、日志都还在)

### 仓库绑定后没有自动构建?

1. 检查 Worker → Settings → Builds 是否已连接仓库,分支是不是 `main`
2. 检查 GitHub 上是否安装了 Cloudflare 的 GitHub App 并授权了这个仓库
3. 看 Deployments 里有没有失败的构建,点进去看日志

### 构建日志里的「已清理 N 个描述文件」是什么?

这是 `tools/strip-docs.js`:**部署构建时自动删除 README、docs/ 等 `.md` 描述文件**,
避免它们跟着进入部署环境白占空间。

- 只在 Cloudflare 构建环境(`WORKERS_CI`)自动执行
- 本地 `wrangler dev` / `wrangler deploy` 只打印一行提示,**不会动你的文件**
- 想手动清理:`npm run strip:docs`
- 不想清理:删掉 `wrangler.toml` 里的 `[build]` 段即可

> 顺带说明:Workers 只会打包从入口 `import` 到的模块,README / docs 本来就不会
> 进入部署产物,所以这一步**不会缩小 Worker 的体积**。它的作用是保持构建上下文
> 干净,以及以后如果启用静态资源目录,不会把文档一起传上去。

---

## 三、QQ 机器人

### 回调地址校验失败 / 群里 @ 没反应

1. 确认面板里连接方式是 **WebHook**,回调地址就是面板显示的那个(默认 `/qq/webhook`)
2. 用 curl 自测:

   ```bash
   curl -i -X POST https://你的域名/qq/webhook -H 'User-Agent: QQBot-Callback' -d '{}'
   ```

3. 响应头出现 `cf-mitigated: challenge`,说明被 Cloudflare 的托管质询拦了
   (腾讯服务器不执行 JavaScript)。处理办法:
   - 在 CF 后台加一条 WAF Skip 规则,跳过 `/qq/webhook`
   - 或者直接切到 **WebSocket** 模式,不需要任何回调地址
4. 还不行就看面板「日志」页,验签失败会写明原因

### 机器人不回复

按顺序排查:

1. 群是否在白名单里(设置 → 群聊权限),或者打开「允许所有群聊」
2. 是否 @ 了机器人,或者消息是否以 `/AI` 开头
3. 面板「日志」页有没有收到事件、有没有模型报错
4. AI 接口是否可用(设置 → AI 接口 → 测试模型)
5. 主动消息额度是否用完(见下一条)

### 主动消息额度是多少?

QQ 官方限制(2026 年现行):

- 群聊**主动消息**:每个群每月 4 条
- **被动回复**:收到消息后 5 分钟内最多 5 次

所以本项目默认 `auto`:回执只在被动窗口内发,结果优先被动回复,
超出窗口才用一次主动消息兜底。别改成「总是主动」,额度几分钟就会用完。

### WebSocket 还是 WebHook?

- **WebHook**(默认):没人说话时 DO 完全休眠,不占额度;需要在开放平台填回调地址
- **WebSocket**:不用填回调、不暴露入口;但连接常驻,会持续消耗
  Durable Object 时长(免费额度大约八成)

### 地址到底要不要写 `https://`?

分三种情况:

1. **QQ 回调地址**:必须是 `https://`,端口必须是 443。这是腾讯的硬性要求,
   写 `http://` 连保存都过不了。
2. **Worker 自己的地址**:`workers.dev` 和绑定了 Cloudflare 的自定义域名
   默认就是 HTTPS,不用自己配证书。
3. **面板里填的地址**(AI 接口、联网搜索、站点域名):写不写协议都行。
   系统会自动整理:
   - 没写协议 → 补 `https://`
   - 写成公网 `http://` → 升级成 `https://`
   - `localhost` / `127.0.0.1` / 内网 IP → 保留 `http://`(方便本地调试)
   - AI 接口后面多粘了 `/chat/completions` → 自动去掉

> 为什么不建议用 `http://`?API Key 会以明文经过中间网络;而且部署出来的页面
> 是 HTTPS 的,页面里再请求 HTTP 接口会被浏览器当成混合内容拦掉。

---

## 四、联网搜索

### 支持哪些服务商?

秘塔、Exa、Tavily、Serper、Brave、Bing、Google 等,按接口域名自动识别;
识别不出的走通用模式(可以在「返回结构映射」里手动指定字段)。

### 搜索报错 / 不生效?

1. 设置 → 联网搜索:确认开关打开
2. Base URL 填到 `/v1` 那一层,Key 正确
3. 点「测试搜索与读取」,弹窗里有原始返回,能直接看出是鉴权问题还是格式问题
4. 需要额外请求头的服务商,在「额外请求头」里填
5. 搜索不可用时机器人会明确说不能联网,不会编造结果

### 测试搜索报错,怎么看是哪一步的问题?

先看 HTTP 状态码:

| 返回 | 多半是什么 | 怎么办 |
| --- | --- | --- |
| 401 / 403 | Key 错误、没开通服务、请求头不对 | 换 Key;在「额外请求头」里补服务商要求的字段 |
| 404 | 路径不对 | 确认 Base URL 是到 `/v1`,不是完整 `/v1/search`;或改「搜索路径」 |
| 429 | 额度/频率用完了 | 换 Key 或等服务商重置 |
| 200 但返回一段 HTML | 地址填成了官网/登录页 | 换成 API 域名,不是网页地址 |
| 200 但结果为空 | 返回结构和默认字段对不上 | 照测试弹窗里的原始 JSON,在「返回结构映射」里填字段路径 |

> 浏览器里的 CORS 报错和这里无关 —— 搜索是 Worker 在服务端发的请求,
> 不经过浏览器。测试失败一定是服务端能看到的真实错误。

### 地址没写 `https://` 能行吗?

能。系统会自动补协议;公网 `http://` 会自动升级成 `https://`,
`localhost` 和内网地址保留 `http://`。详见上面「地址到底要不要写 https://」。

### 测试通过,但机器人还是说不知道?

模型不一定会主动调用搜索工具。可以:

1. 在问题里明确说「搜一下」「查最新消息」
2. 检查 **设置 → 扩展** 里 `web_search` / `fetch_url` 是不是被关掉了
3. 看面板日志里有没有 `web_search` 的调用记录

---

## 五、部署项目(网页)

### 链接为什么是 `/abcd1234` 这种半截地址?

在「设置 → 站点域名」里填上公开地址(例如 `https://ai.example.com`),
之后生成的链接就是完整可点的网址。

### 页面打不开 / 404?

- 每个部署默认只活 10 分钟,到期自动销毁(面板可改)
- 确认项目里有 `index.html`
- ID 是小写字母 + 数字;链接过期后只能重新部署

### 部署的网页能存数据吗?

能。用内置的 `/__data/<键>`:GET 读、POST 写,每个项目默认 256 KB。
适合排行榜、存档这类小数据。

### 为什么部署出来的页面自动多了 SEO 标签?

系统提示词要求 AI 把 SEO / 质量分相关的内容写全;如果 AI 漏了、写空了,
平台会用默认值补齐,已经写好且非空的一律不覆盖。自动补的范围:

- `charset`、`title`、`description`(≤160 字)、`viewport`
- `robots`、`author`、`theme-color`、`color-scheme`
- `canonical`、`favicon`(内联 SVG,不额外发请求)
- Open Graph:`og:type` / `og:title` / `og:description` / `og:url` / `og:site_name` / `og:locale`
- Twitter Card:`twitter:card` / `twitter:title` / `twitter:description`
- JSON-LD:`WebPage` + `WebSite`(schema.org)
- AI 只返回 `<div>…</div>` 这种裸片段时,自动包成 `<!DOCTYPE html>` + `head` + `body`

同时所有部署页面都会自动带上安全响应头(CSP、HSTS、nosniff、Referrer-Policy、
Permissions-Policy、X-Frame-Options),这样页面在 SEO / 安全扫描里的分数会更好。

### 为什么没有 hreflang?

`hreflang` 只在**多语言站点**(同一页面有多个语言版本)时才需要。
本项目和部署页面都是单一语言(zh-CN),加它没有意义。

---

## 六、安全与 SEO 检查项对照

用 webanalyzer 之类的工具扫描时,这些项目的处理方式:

| 检查项 | 处理 |
| --- | --- |
| 元描述(meta description) | 面板页/错误页自带;部署页要求 AI 填写,缺失或为空时自动补默认值(≤160 字) |
| 标题 / 编码 / viewport | 部署页缺失时自动补 `title`、`charset="utf-8"`、`width=device-width` |
| canonical | 部署页自动补指向自己的 canonical(已有则不覆盖) |
| Open Graph | 部署页自动补 `og:type/title/description/url/site_name/locale` |
| Twitter Card | 部署页自动补 `twitter:card/title/description` |
| favicon | 部署页自动补内联 SVG 图标,不产生额外请求 |
| JSON-LD 结构化数据 | 部署页自动补 `WebPage` + `WebSite`(已有则不覆盖) |
| Content-Security-Policy | 面板/错误页用严格 CSP(`default-src 'none'`);部署页用宽松 CSP(允许内联脚本/样式与 https 资源) |
| HSTS | 所有响应带 `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` |
| HSTS 预加载 | 响应头已带 `preload`;要真正进入浏览器预加载列表,需在 hstspreload.org 提交你的域名 |
| X-Content-Type-Options | 所有响应带 `nosniff` |
| Referrer-Policy | `strict-origin-when-cross-origin` |
| Permissions-Policy | `camera=(self), microphone=(self), geolocation=(self)` |
| X-Frame-Options | 部署页带 `SAMEORIGIN`,防点击劫持 |
| HTTP/2 / HTTP/3 | 由 Cloudflare 边缘提供;自定义域名在 CF 面板 → 网络 里确认 HTTP/3 已开启 |
| robots.txt | 已提供:允许抓取公开页面,禁止 `/administrator` |
| 管理面板收录 | 面板页面 `noindex,nofollow` |

> 说明:HSTS 头由 Worker 返回,浏览器只在 HTTPS 下生效;`preload` 指令只是
> 「符合提交条件」的声明,真正预加载需要域名所有者去 hstspreload.org 提交。

---

## 七、其他

### 免费额度够用吗?

看 [LIMITS.md](LIMITS.md),里面有每项免费额度的实测数据。

### 日志在哪看?

面板「日志」页,支持按级别筛选、下载、清空;调试模式在「设置 → 日志」里打开。

### 管理路径能改吗?

固定是 `/administrator`。安全性靠登录鉴权 + 失败锁定 + noindex,而不是靠路径保密。

### 数据库 / 存储里的东西会丢吗?

重新部署、改代码都不会动 D1 / KV / R2。只有你主动删除项目、清空日志、
或部署到期销毁时才会删数据。

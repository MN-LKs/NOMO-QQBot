# NOMO-QQBot 大改造任务清单

所有功能组已实现并通过测试。下面注明每组的实际落地情况与关键实现位置。

## A. 面板死开关(已完成)
- [x] check-switches.js 检查器
- [x] forceUpdate 绑定修复
- [x] 接入 test:all
- [x] DOM 级自检 tools/check-switches-dom.mjs(jsdom 真点击,断言 class 翻转 + POST 落点)
- [x] 统一入口 bindTog(root, attr, makePatch, save):null 保护 + 点击即存

## B. 部署流程改造(已完成)
- [x] B1 deploy_site 增加 enableCustomBackend / enablePrefabBackend 参数 — src/agent/tools.js
- [x] B2 只有启用后端才走审批(纯静态直接部署) — src/core/do.js createPendingDeploy
- [x] B3 pending 表加 arch 字段 + waitSeconds 超时 — src/core/schema.js
- [x] B4 卡片撤回(QQ  recall API)+ 超时回调给 AI — recallDeployCard / expirePendingDeploys
- [x] B5 确认/取消/超时三类结果统一回给 Agent — feedAgentSystemNotice

## C. 并行与并发(已完成)
- [x] C1 命令接收与 Agent 解耦 — src/qq/webhook.js Promise.race([enqueue, sleep(4000)]) 4 秒内必返
- [x] C2 同一轮多个工具调用并行执行 — src/agent/loop.js Promise.allSettled,结果按序回填
- [x] C3 多条 AI 消息并发 — src/core/do.js tick() 按 agentConcurrency(默认4,1~10)批量领任务

## D. 上下文隔离(已完成)
- [x] D1 设置项 contextScope: group | user — src/config.js
- [x] D2 user 模式下按 openID 分会话
- [x] D3 切换模式时的双向清理 + 二次确认 — clearContext

## E. 万能模型层(已完成)
- [x] E1 模型配置结构 models.ocr/asr/tts/imageGen/compress — src/config.js DEFAULT_SETTINGS.models
- [x] E2 协议适配 chat | responses | google | claude — src/agent/models.js
- [x] E3 OCR 图片识别(优先 OCR,原生视觉可关) — src/core/do.js runTurn
- [x] E4 ASR 语音识别 — guessAudioFormat + asrAudio
- [x] E5 TTS 语音合成 + QQ 语音发送(fileType 3) — deliverRaw
- [x] E6 图像生成 + QQ 图片发送(fileType 1) — draw_image 工具 + ctx.media
- [x] E7 压缩模型(独立 API / 复用主 API) — compressContext 优先 modelCompressReady
- [x] E8 每个模型的测试弹窗(参数表单 + 结果预览) — src/panel/ui.js pageModels/openModelTest + /api/test-model
- [ ] 已知限制:ASR/TTS 依赖上游实现具体形态,已在代码里做多形态兼容与降级

## F. 创造模式(已完成)
- [x] F1 /AI 创造模式 <内容> 精准匹配 — CREATIVE_MODE_RE 单空格,parseCreativeMode
- [x] F2 仅管理员,单轮生效 — do.js isAdmin 校验 + loop.js creative 只在本轮生效
- [x] F3 免审批 + 全套管理工具 — creativeCfg 强制 canDeploy/canPrefab/canCustomBackend/deployConfirm=false
- [ ] 注:非管理员发送同样内容会被静默忽略(不当普通 AI 请求),避免被提权

## G. 万物工具架构(已完成)
- [x] G1 工具分类注册表(内部/外部/MCP/模型能力/自写) — src/agent/registry.js buildRegistry
- [x] G2 AI 可自写扩展/工具/插件(JS) — exec.js create_tool,kind='script' 扩展 + jsmini 沙盒
- [x] G3 热重载 — saveExt 后 invalidateSettings() 清缓存,每轮 loop 重读 DB,下一条消息生效
- [x] 工具总览接口 /api/tools — src/panel/api.js
- [ ] create_tool / list_tools 仅在创造模式(管理员)下可见,普通群友无法触发

## H. 版本号对比更新(已完成)
- [x] H1 提交附带 emergency 标签识别 — /\[emergency\]|EMERGENCY/i
- [x] H2 版本号对比,小于等于不更新 — newerVersion 严格大于才提示
- [x] H3 Deploy Hook 触发 — /update/deploy
- [x] H4 登录后一次性弹窗(应急信息/失败提示) — showUpdateInfo,emergency 红字抬头
- [ ] 保留手动 force 开关作为线下事故止血,与提交里的 emergency 是两个独立通道

## I. 测试资源(已完成)
- [x] I1 中英文测试图片(OCR) — test/fixtures/ocr-zh.png / ocr-en.png
- [x] I2 中英文测试音频(ASR) — test/fixtures/asr-zh.wav / asr-en.wav
- [x] data-urls.json 供面板测试弹窗直接粘贴
- [ ] 音频为正弦波,只验证链路可达;真实验证识别准确率请用真人录音

## 测试
单元 238 + 模型层 75 + jsmini 59 + 集成 105 + 开关 DOM 自检,全绿。
新增 test/models.test.mjs(E/F/G 组的配置加工、协议解析、边界、注册表归桶、创造模式解析规则)。

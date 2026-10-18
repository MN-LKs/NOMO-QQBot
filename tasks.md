# NOMO-QQBot 大改造任务清单

按依赖顺序执行,每完成一组跑一次 npm run test:all。

## A. 面板死开关(已完成)
- [x] check-switches.js 检查器
- [x] forceUpdate 绑定修复
- [x] 接入 test:all

## B. 部署流程改造
- [ ] B1 deploy_site 增加 enableCustomBackend / enablePrefabBackend 参数
- [ ] B2 只有启用后端才走审批(纯静态直接部署)
- [ ] B3 pending 表加 arch 字段 + 30 秒超时
- [ ] B4 卡片撤回(QQ 撤回 API)+ 超时回调给 AI
- [ ] B5 确认/取消/超时三类结果统一回给 Agent

## C. 并行与并发
- [ ] C1 命令接收与 Agent 解耦(agent 跑的时候 /help /禁言 不被阻断)
- [ ] C2 同一轮多个工具调用并行执行
- [ ] C3 多条 AI 消息并发(多 agent 同时工作)

## D. 上下文隔离
- [ ] D1 设置项 contextScope: group | user
- [ ] D2 user 模式下按 openID 分会话
- [ ] D3 切换模式时的双向清理 + 二次确认

## E. 万能模型层(OCR/ASR/TTS/图像生成/压缩模型)
- [ ] E1 模型配置结构 models.ocr / asr / tts / imageGen / compress
- [ ] E2 协议适配 chat | responses | google | claude
- [ ] E3 OCR 图片识别(优先 OCR,原生视觉可关)
- [ ] E4 ASR 语音识别
- [ ] E5 TTS 语音合成 + QQ 语音发送
- [ ] E6 图像生成 + QQ 图片发送
- [ ] E7 压缩模型(独立 API / 复用主 API)
- [ ] E8 每个模型的测试弹窗(参数表单 + 结果预览)

## F. 创造模式
- [ ] F1 /AI 创造模式 <内容> 精准匹配
- [ ] F2 仅管理员,单轮生效
- [ ] F3 免审批 + 全套管理工具(模块/技能/扩展/MCP)

## G. 万物工具架构
- [ ] G1 工具分类注册表(内部/外部/MCP/模型能力)
- [ ] G2 AI 可自写扩展/工具/插件(JS)
- [ ] G3 热重载

## H. 版本号对比更新(替换现有 force 机制)
- [ ] H1 提交附带 emergency 标签识别
- [ ] H2 版本号对比,小于等于不更新
- [ ] H3 Deploy Hook 触发
- [ ] H4 登录后一次性弹窗(应急信息/失败提示)

## I. 测试资源
- [ ] I1 中英文测试图片(OCR)
- [ ] I2 中英文测试音频(ASR)

# Cox 的 T3 分叉审计

审计范围为 T3 官方 main 上从分叉点 `79f1fadfc6020b820d541ca4691d2feebb15dd1b` 到固定头 `d26066000d31146070a94a178e2cebe5513bb279` 的全部可达提交。从 Cox 来源快照 `0102f07afb01c06881ec7525338cafe3013c2a96` 计算得到相同的分叉点。该范围包含 3,911 条提交，其中合并提交为 0 条。[Git 清单](upstream-shas.txt)与[逐提交台账](commits.tsv)的 SHA 和顺序完全一致。[复核输出](range-verification.json)记录了两份文件的 SHA-256，以及原有七个文件中 19 处编辑片段的哈希和核对结果。Cox 的审计起始基线为 `d67ae88a011b1daf5a96c5d3d34d00c702500404`。

| 结论                        | T3 提交数 |
| --------------------------- | --------: |
| 移植已验证，保留在工作区    |       629 |
| 移植纳入此前的本地提交      |        36 |
| Cox 已有等价行为            |      1448 |
| 已由后续或 Cox 自有实现替代 |        68 |
| 本次不采用                  |      1725 |
| 暂缓移植                    |         1 |
| 已接入，待平台验证          |         4 |

[逐提交台账](commits.tsv) 保留上游标题、采用理由及验证场景。[36 条本地提交映射](local-ports.tsv) 记录 Cox 提交与上游 SHA。原始审计结束时的本地 HEAD 为 `eb502c4c60c65b5f3f8de16164f6014e851b1898`。当时追加的代码改动留在工作区。原有七处编辑的差异片段逐一比对，全部保留。确认框和更新测试在原有改动之外追加了单独片段。

0.2.20 候选将这 36 条本地提交接到公开版基线 e940a1fd42，其余审计改动见 ae5fa85eb0。候选保留 Cursor SDK 1.4.2 及已发布的实时转向。独立安装的 npm 包通过 CLI 版本检查、Cursor 离线预热、密码登录和 WebSocket 检查。

全量验收发现的回归通过了原用例复测，包含 Pi 的 8 个协议回放、MCP 的 2 个委派回放、ACP 与注册缓存的 3 个定向用例，以及文件预览、终端和侧栏的相关 Web 用例。Windows、macOS、iOS 与已认证供应商的原生场景仍按下文标记。历史入口凭据保留原分类。

最终 `pnpm typecheck`、生产构建和 `git diff --check` 都通过。专项验证覆盖浏览器、服务端、客户端运行时及原生协议回放。最后几轮包含 131 项 Web 回归、141 项时间线回归、40 项文件引用回归、25 项时区回归、19 项工作树交接回归、270 项 Git checkpoint 和清理回归，以及 17 项本地更新备份回归。浏览器用例和协议回放不计为原生供应商实跑。

干净基线复现了 ProviderSwitch 的两项回退断言、ProviderSessionManager 的两项清理断言和 ACP 压缩生命周期断言。Pi 扩展提问、编辑压缩期间排队消息和 ACP 重连仍未在原生会话中实跑。iOS 播放和 Windows ConPTY 检查需要对应平台。

完整工作日志和手动 QA 证据保留在 `/tmp/cox-upstream-audit-K0VB8D/`。最终检查记录见 `audit-delivery-summary.log`、`audit-viewed-images-summary.log`、`audit-cited-files-summary.log` 、`audit-closing-verified-summary.log`、`audit-submodule-checkpoint-summary.log` 和 `audit-backup-staging-summary.log`。每个批次的测试输出和退出状态可用同目录记录核对。本轮下载的临时供应商包已清理，端口、工作树和留存证据见[清理记录](cleanup-verification.json)。

逐条证据索引覆盖 669 条已有移植。其中 572 条引用批次归档，27 条引用历史回执，52 条只有台账引用。本轮补回 8 条历史测试或测试套件的前后结果，其中 3 条找到了早期笔记中预先写明的场景。批次记录和回执仍缺逐条入口验收所需的原始材料。[逐条证据索引](entry-evidence-index.tsv) · [入口验证记录](entry-verification.json) · [历史回执复核](historical-receipt-recovery.json)

历史失败定向复测通过 13 项服务端用例和 4 项 Web 用例。侧栏拖拽用例仍在查找旧的文件夹角色，改用当前按钮角色后单独复测通过，Web TypeScript 检查也通过。另有离线重连、Zed 路径回退和 Windows Markdown 路径三组历史失败，通过原用例定向复测共 6 项。[批次检查记录](batch-gate-verification.json)

续审接入了 Cursor SDK 1.2.0 原生压缩调用、编辑器和终端线程快捷键、Windows node-pty 输出收尾，并补跑了压缩期间排队编辑回归。快捷键的两项浏览器断言在修改前失败，修复后两套浏览器测试共 119 项通过。Windows 的三项 JavaScript 退出回归修改前失败，修复后通过，同批 17 项终端测试通过，Linux PTY 实测收到完整输出并以 0 退出。Cursor 回放通过 36 项，冻结锁检查、工作区类型检查、生产构建和差异检查均为 0。

仍有验证或交付边界的条目

- `c8a601c0dfa5` Cursor 已调用 SDK 1.2.0 的 `Agent.summarize()`。SDK 导入、Linux 沙箱帮助和回放已通过，原生压缩仍需认证会话。
- `8a38c637069f` 线程快捷键通过 Chromium 的 MacIntel 模拟和 Ghostty 事件夹具，尚缺真实 macOS 的按键分发结果。
- `1ea523608b4f` iOS 工作区已启用内联播放，需要 iPhone 或 iOS 模拟器验证。
- `6a8f022b451f` Windows 退出补丁已验证 JavaScript 定时器的刷新和收尾，需要真实 ConPTY 测量退出耗时及末尾输出。
- `f82162f0336c` Grok 1.0.89 识别 `_x.ai/interject`。`session/new` 要求认证，当前没有活动会话成功排队的原生证据，移植暂缓。

# Cox Desktop

macOS / Windows 桌面壳，复用 Cox Web UI，内置独立 Node 运行时和本地后端。安装后双击即可启动，无需用户预装 Node、pnpm 或手动启动服务器。Agent 的 CLI、认证和模型订阅仍需单独配置；不附带所有 Agent。

## 行为与数据

- 后端固定绑定 `127.0.0.1`，自动选择可用端口，保留现有浏览器会话认证和 WebSocket Origin 校验。不会连接远程服务器，也不会接管或停止现有 Cox 服务。
- 正式版数据位于 `~/.cox/desktop`，包含后端 `userdata`、浏览器 `browser`、日志 `logs` 和窗口尺寸 `window.json`。与 CLI 默认 `~/.cox/userdata` 隔离，不自动复制、迁移或改动已有数据。
- 开发版数据位于仓库 `.cox/desktop-dev`，与正式版和现有 CLI 数据隔离。
- 重复双击只唤醒已有桌面窗口，不启动第二个后端。
- macOS 关闭窗口后程序和任务继续运行，通过 Dock 再次打开；Windows 关闭窗口进入退出确认。菜单 Quit / 系统退出均提示中断风险，确认后停止自有后端和终端。
- Windows 默认隐藏原生菜单栏（Alt 可临时调用），窗口按钮融入应用顶部并跟随主题颜色，保留原生最小化、最大化和关闭，以及顶部空白区域拖动。退出确认复用应用内弹窗、字体与主题，默认聚焦取消；确认后才停止后端。仅在页面未就绪或崩溃时回退系统提示框。
- 桌面进程异常结束时，IPC 断开触发后端清理。强制退出和机器断电无法保证运行中任务完成。
- 内嵌页面禁用 Node 集成，启用 sandbox / context isolation；外部 HTTP(S) 链接在系统浏览器中打开。不提供自动更新、云账号、远程连接或遥测服务。
- 后端不会继承 `COX_*`、`T3CODE_*`、`VITE_*`、`ELECTRON_*`、`NODE_OPTIONS` 和 `NODE_PATH` 覆盖配置；其他 provider 环境变量保留。macOS 启动时尝试读取登录 shell 的 PATH。

## 本地开发

需要仓库要求的 Node、pnpm、Go `1.27.3` 和已安装的 workspace 依赖。可通过 `COX_GO_BINARY` 指定 Go 可执行文件：

```sh
pnpm install
pnpm desktop:dev
```

开发启动器将当前独立 Node 路径传入 Electron，避免使用 Electron 内置 Node 运行后端和原生依赖。开发和打包命令会显式执行 `pnpm electron:install`：当前 Electron 包不再通过依赖安装时的 postinstall 自动下载运行时，单独执行 `pnpm install` 不会下载 Electron 浏览器二进制。

```sh
pnpm desktop:test
pnpm --filter @cox/desktop typecheck
```

## 构建安装包

在目标系统及目标 CPU 架构上运行：

```sh
pnpm desktop:build
```

- macOS arm64 / x64：生成 `.dmg` 和 `.zip`，分别使用 Apple Silicon / Intel 构建机。
- Windows x64：生成当前用户安装的 NSIS `.exe`，可选择目录并创建桌面快捷方式。
- 输出在根目录 `release/desktop`，附 SHA-256 和构建版本信息。
- 安装包使用最大压缩；只保留当前系统与架构的协议桥和终端预编译文件，移除调试 source map、Node 开发头文件和 man 手册，保留 npm、运行依赖、完整 UI 功能与许可证。以后通过 npm 安装需要编译的扩展时，构建工具可能需要联网下载 Node 头文件。
- 不跨系统或跨架构复用原生依赖；Windows 构建机可能需要 Visual Studio C++ Build Tools 和 Python，以便 `node-pty` 无可用预编译产物时编译。
- 打包从 Node 官方 HTTPS 地址下载仓库固定版本的完整 Node/npm 发行版，验证其官方 SHA-256，安装并修补独立后端运行依赖，检查原生模块后再封装。缓存、临时文件均位于 `release`，不会打包 workspace、用户配置、数据库或凭据。
- Node、Electron、Chromium、原生依赖和 Cox 的许可证随发行包保留。
- 首次打包需要联网。构建脚本不会启动 Agent 推理或修改运行中应用的数据。

仅验证当前平台的解包目录（Linux 上也可用于工程验证，不代表提供 Linux 产品支持）：

```sh
pnpm build
pnpm --filter @cox/desktop build
pnpm --filter @cox/desktop package --dir
pnpm --filter @cox/desktop smoke
pnpm --filter @cox/desktop smoke:app
```

`smoke` 使用临时数据验证打包后的 Node、后端、终端、认证与 Origin 校验；`smoke:app` 验证实际窗口、自动登录、渲染器隔离、剪贴板、单实例和退出。Linux 的窗口测试需要 Xvfb，并仅在该测试启动命令中使用 `--no-sandbox` 以兼容 CI 宿主限制，不改变正式客户端配置；不要用该参数启动日常客户端。

GitHub Actions 的 `Cox desktop packages` 工作流支持手动触发，在 macOS arm64 / Intel 和 Windows x64 上构建、运行上述 smoke 并上传安装包，不自动发布 Release。

macOS 的 DMG 与 ZIP 分开上传：默认 `cox-desktop-macos-*` 附件只含 DMG，便携 ZIP 在对应 `-zip` 附件中，无需同时下载两份相同的应用。

仅调整 Windows 客户端时，可在手动触发工作流时勾选 `windows_only`，避免重复构建两个 macOS 安装包；默认仍验证全部三个目标。

### 签名与发布边界

本地没有签名凭据时，macOS 显式使用 ad-hoc 签名生成内测包，Windows 生成未签名内测包。ad-hoc 签名保证应用签名结构完整，但不提供开发者身份认证或公证，仍可能被 Gatekeeper 拦截。macOS 公开分发前需要 Apple Developer ID 签名、公证及干净机器验收，Windows 公开分发前需要代码签名和安装验收。不要把证书或密码提交到仓库。macOS 可通过 `CSC_NAME` 指定钥匙串身份，或通过 `CSC_LINK` 等标准环境变量导入发布证书；当前 CI 不注入发布证书，也不自动上传或发布安装包。

macOS 构建后运行 `pnpm --filter @cox/desktop verify:mac`：严格校验解包目录、ZIP 解压结果和只读挂载 DMG 内的应用及内置 Node 签名。CI 在窗口 smoke 前执行该检查；直接启动构建目录不能证明下载后的应用签名有效。此检查不等于 Gatekeeper 公证验收。

发布前应在两种系统真机覆盖：首次启动、重复启动、已有 CLI 服务并行运行、项目/Git/终端、各目标 Agent 的安装与认证、关闭窗口与退出、崩溃恢复、含空格和非 ASCII 的路径、卸载重装后数据保留。Linux 上的测试和构建不等于 macOS / Windows 真机验证。

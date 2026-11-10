# Cox Desktop

macOS / Windows 桌面壳，复用 Cox Web UI，内置独立 Node 运行时和可选本地后端。安装后双击即可启动，无需用户预装 Node、pnpm 或手动启动服务器。也可以直接连接用户自行部署的远程 Cox 服务端。Agent 的 CLI、认证和模型订阅仍需在对应服务端单独配置；不附带所有 Agent。

## 行为与数据

- 本地后端固定绑定 `127.0.0.1`，自动选择可用端口，保留现有浏览器会话认证和 WebSocket Origin 校验。不会接管或停止并非由桌面客户端拥有的 Cox 服务。
- 原生菜单的“连接管理”用于添加、连接和忘记远程服务器。远程地址只接受不含凭据、路径、查询或片段的 HTTPS origin；预检同时要求有效的 Cox descriptor 和密码登录模式。自签名证书必须由系统明确信任，不提供忽略证书错误或改用 HTTP 的开关。
- 远程服务端托管与自身版本匹配的 Web UI，HTTP、WebSocket、附件和预览继续使用同源地址。密码只在远程 Cox 登录页输入，不写入 `connections.json`。每个服务器使用独立持久化 partition，忘记服务器会清除该 partition 的会话、存储和缓存。
- 远程页面只获得窗口与同源设置所需的受限 Bridge，不暴露本地后端或客户端更新接口；主进程另行校验连接模式、窗口、main frame 和精确 origin。剪贴板读取、剪贴板写入和通知按服务器分区单独授权。不同服务器不聚合项目或线程，也不会在远程故障时静默回退到本地。
- 本地与远程实例可同时保留并随时切换；连接或切换远程实例不会停止自有本地后端，本地 Agent 和终端继续运行。侧栏的连接入口显示当前实例名称，连接管理也可通过原生菜单打开。远程退出或断开只关闭客户端连接，不停止服务端 Agent 或终端。client-only 包在首次选择本地模式时才安装 Cox，纯远程使用不会触发本地后端安装。
- 正式版数据位于 `~/.cox/desktop`，包含后端 `userdata`、浏览器 `browser`、日志 `logs` 和窗口尺寸 `window.json`。与 CLI 默认 `~/.cox/userdata` 隔离，不自动复制、迁移或改动已有数据。
- 开发版数据位于仓库 `.cox/desktop-dev`，与正式版和现有 CLI 数据隔离。
- 重复双击只唤醒已有桌面窗口，不启动第二个后端。
- 桌面设置使用独立窗口，复用现有设置页面的主题、字体、导航和控件；菜单、快捷键和设置入口共用同一个窗口，重复打开时聚焦已有窗口。项目和 Agent 设置保留原入口的上下文，主窗口中的会话和终端继续保留。关闭设置只关闭设置窗口，窗口位置与尺寸单独保存。主题、语言和设备偏好在两个窗口之间同步，关闭前提交当前输入。旧版后端界面不声明独立窗口能力时，继续使用原设置交互。
- 首次本地安装和后端更新显示真实下载字节、百分比、速度和预计剩余时间，并区分校验、安装依赖、验证和启动阶段；总大小未知时显示当前字节与步骤，不显示虚构的百分比。启动页沿用上次窗口配色，更新面板复用现有设置和通知样式。
- macOS 关闭窗口后程序和任务继续运行，通过 Dock 再次打开；Windows 关闭窗口进入退出确认。菜单 Quit / 系统退出均提示中断风险，确认后停止自有后端和终端。
- Windows 默认隐藏原生菜单栏（Alt 可临时调用），窗口按钮融入应用顶部并跟随主题颜色，保留原生最小化、最大化和关闭，以及顶部空白区域拖动。退出确认复用应用内弹窗、字体与主题，默认聚焦取消；确认后才停止后端。仅在页面未就绪或崩溃时回退系统提示框。
- 桌面进程异常结束时，IPC 断开触发后端清理。强制退出和机器断电无法保证运行中任务完成。
- 内嵌页面禁用 Node 集成，启用 sandbox / context isolation；外部 HTTP(S) 链接在系统浏览器中打开。客户端更新仅从官方 GitHub Release 下载，不提供云账号、服务发现、relay/tunnel 产品或遥测服务。身份验证代理所需的第三方 SSO 跳转不属于当前内嵌远程登录范围。
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

- macOS arm64 / x64：仅生成 `.dmg`，分别使用 Apple Silicon / Intel 构建机。
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

桌面版固定下载入口为 `https://github.com/doublepi123/cox/releases/tag/cox-desktop-latest`。
`Update desktop latest release` 工作流在 `Release desktop combinations` 成功完成、桌面 Release 发布或编辑后自动同步，也支持手动触发。
它按语义版本选择最新的已公开稳定 `desktop-v*`，将 `cox-desktop-latest` 滚动标签指向该版本提交，并更新独立 Release 的三平台下载链接、SHA256 清单和 `desktop-update.json` 机器可读更新源。
同一客户端有多组内置后端时，选择最新稳定后端；安装包缺失时拒绝更新。草稿、预发布和服务端版本不参与选择，旧任务完成也不会回退到旧客户端。
版本标签和安装包保持不变，滚动页链接版本 Release 的原始附件，不重复上传安装包，也不占用服务端的 GitHub Latest 标记。版本发布跳过内容相同的已有附件，拒绝覆盖内容不同的同名附件；构建元数据包含客户端和后端版本，允许同一客户端添加新的后端组合而不破坏旧校验清单。需要变更同名安装包时必须发布新的客户端版本。已有客户端更新清单保持不变，滚动下载页可以展示此客户端的较新后端组合。

客户端新版本的首次发布需要完整的三平台、两种包类型。给已有客户端版本追加后端组合时，关闭 `client_only`，保留已发布的精简包与客户端更新清单，只新增对应后端组合。

每个正式客户端发布必须包含 macOS arm64 / x64、Windows x64 的 bundled / client-only 共六个目标，以及各自的 `BUILD-*.json`、`UPDATE-*.json` 和校验文件。发布任务在所有原生构建、签名检查和 smoke 成功后重新验证实际安装包的大小、SHA-256、SHA-512、客户端提交和后端版本，再生成版本 Release 的 `desktop-update-<client-version>.json`。任何目标缺失或身份不匹配都拒绝生成更新源。滚动任务检查版本更新源与 GitHub 附件一致，再发布相同内容的 `desktop-update.json`；已经发布的较高版本不会被较低版本替换。历史版本缺少机器可读源时，任务会失败并保留已有更新源，需要发布一个完整的新客户端版本。

macOS 的 CI 附件与正式发布均只含 DMG 安装包及其校验文件，不再生成或上传重复的 ZIP 应用包。

原生菜单及更新、权限、退出、启动失败等弹窗跟随系统首选语言：中文系统只显示中文，其他语言回退英文，不同时显示中英文。浏览器界面继续使用已有的语言设置。

更新提示支持“忽略本版本”和“永久忽略更新”，偏好保存在桌面数据目录的 `backend-updates/preferences.json`，重启后仍生效。忽略本版本只跳过该版本，仍提醒更高版本；永久忽略只关闭自动检查，仍可在设置或原生菜单中手动检查，并恢复自动检查。已下载的更新仍会在下次启动生效；仅客户端包首次启动所需的 Cox 安装不受忽略偏好阻止。此设置不修改全局 npm 安装。

### 客户端自身更新

客户端与 Cox 后端分别检查版本、保存偏好。客户端偏好位于 `client-updates/preferences.json`，下载和签名更新缓存也保存在桌面数据目录的 `client-updates` 内。忽略当前版本仍允许发现更高版本；关闭自动检查后，手动检查仍可使用。下载是显式操作，不会因为关闭窗口或普通退出而安装，也不会在下次启动时自动替换客户端。离线启动不检查或下载更新。

更新源固定为 `https://github.com/doublepi123/cox/releases/download/cox-desktop-latest/desktop-update.json`。客户端只接受与自身平台、CPU 架构和 bundled / client-only 类型一致的更高稳定版本；安装包必须来自对应不可变 `desktop-v*` Release。下载仅允许 HTTPS 官方仓库地址和 GitHub Release CDN 重定向，限制响应大小和重定向次数，并在下载完成及安装前分别验证大小、SHA-256、SHA-512。下载状态包含字节数、速度、预计剩余时间和校验阶段。

macOS 支持“重启并更新”：下载并验证 DMG 后，在应用旁边准备替换副本，检查包标识、版本、CPU 架构、包类型、内置 Node 和代码签名。用户确认退出后，临时更新进程备份桌面后端数据、后端版本指针和浏览器资料，等待旧客户端退出，再替换应用并重新启动。新版后端和浏览器界面都就绪后才清理旧应用；启动失败时先停止本次启动的进程，再恢复旧应用和配套数据并重新打开。不会停止其他 Cox 服务。更新进程只服务于这一次明确确认的更新，不安装常驻服务。

macOS 自动更新沿用现有 DMG，无需额外 ZIP。ad-hoc 内测包仍校验完整代码签名与官方发布校验和；已使用 Developer ID 签名的客户端要求更新保持同一签名团队，并通过系统 Gatekeeper 评估。不移除隔离属性、不重新签名，也不使用提权脚本。应用需要安装到可写的位置；从 DMG 或 App Translocation 运行时会提示先完成安装。失败详情保存在 `client-updates/mac-updates/<id>`，回滚结果会在客户端更新设置中显示。

Windows 未签名 NSIS 使用手动安装方式：下载并校验，在用户明确确认退出后停止自有后端，再打开安装包完成安装向导；“安装包已打开”不表示安装已经完成。系统拒绝打开安装包时返回错误，主进程保留应用并恢复自有后端。

Windows 支持可选的 `electron-updater` 签名 NSIS 路径：构建时同时设置 `COX_DESKTOP_SIGNED_UPDATES=true`、`COX_DESKTOP_PUBLISHER_NAME` 及标准 `CSC_LINK` / `CSC_KEY_PASSWORD`，打包任务验证安装包 Authenticode 状态和发布者，并写入 `backend.json` 的 `clientAutomaticUpdates` / `clientPublisherName`。主进程必须把这些本地构建信息传给 `ClientUpdates` 的 `automaticUpdates` / `publisherName`；新版本的更新源也必须声明支持签名安装。下载使用固定版本的 `electron-updater`、固定的单一安装包源和发布者签名校验，禁用预发布、降级、差分下载、Web 安装器、自动下载及退出时自动安装。确认后再次校验签名并启动 NSIS，只有启动成功才允许父进程退出。签名路径失败时直接报错，不会降级到未签名安装。应用打包阶段会安装并包含完整 updater 运行依赖树。

当前工作流不注入发布证书；macOS 内测包默认支持上述应用内自动替换，Windows 默认使用手动安装。macOS 工作流额外运行 `smoke:mac-update`，在隔离的含空格和非 ASCII 路径内验证实际 DMG、临时更新进程、应用替换、重启、后端与界面就绪确认及数据保留。公开分发的 Developer ID 签名、公证与真机验收要求仍需满足。

后端集成入口为 `src/client-updates.ts` 的 `ClientUpdates`：构造后按需调用 `check(manual = false)`、`download()`、`setPolicy("automatic" | "ignore-version" | "never", version?)`，这些方法返回最新状态；`getState()` 读取状态副本，`onState` 接收变化。`apply(): Promise<void>` 仅在 ready 后接受显式请求，成功表示安装器已成功交给系统或启动，不会调用应用退出；失败会更新 error 状态并抛出异常。`close()` 取消正在进行的下载并清理 updater 监听。退出确认及自有后端停止、恢复和应用退出由主进程统一处理。

仅调整 Windows 客户端时，可在手动触发工作流时勾选 `windows_only`，避免重复构建两个 macOS 安装包；默认仍验证全部三个目标。

### 签名与发布边界

本地没有签名凭据时，macOS 显式使用 ad-hoc 签名生成内测包，Windows 生成未签名内测包。ad-hoc 签名保证应用签名结构完整，但不提供开发者身份认证或公证，仍可能被 Gatekeeper 拦截。macOS 公开分发前需要 Apple Developer ID 签名、公证及干净机器验收，Windows 公开分发前需要代码签名和安装验收。不要把证书或密码提交到仓库。macOS 可通过 `CSC_NAME` 指定钥匙串身份，或通过 `CSC_LINK` 等标准环境变量导入发布证书；当前 CI 不注入发布证书。普通构建只上传工作流附件，正式 `desktop-v*` 发布流程在所有目标成功后发布版本附件和更新源。

macOS 构建后运行 `pnpm --filter @cox/desktop verify:mac`：严格校验解包目录和只读挂载 DMG 内的应用及内置 Node 签名。CI 在窗口 smoke 前执行该检查；直接启动构建目录不能证明下载后的应用签名有效。此检查不等于 Gatekeeper 公证验收。

发布前应在两种系统真机覆盖：首次启动、重复启动、已有 CLI 服务并行运行、项目/Git/终端、各目标 Agent 的安装与认证、关闭窗口与退出、崩溃恢复、含空格和非 ASCII 的路径、卸载重装后数据保留。Linux 上的测试和构建不等于 macOS / Windows 真机验证。

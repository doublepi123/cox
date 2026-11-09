<p align="center">
  <img src="apps/web/public/cox.svg" width="96" height="96" alt="Cox 图标" />
</p>

# Cox

[English](README.md) | 简体中文

[项目官网](https://doublepi.dev/) · [CoCode 安卓版](https://doublepi.dev/cocode/)

Cox 是一个面向编码智能体的 Web 界面和桌面客户端，派生自 [T3 Code](https://github.com/pingdotgg/t3code)，起点是 `doublepi123/t3code` 复刻中的提交 `0102f07afb`。

在你的电脑上运行服务端，就能在浏览器中操控本机安装的编码智能体。你的项目、对话历史、凭据和检查点都保存在本地的 Cox 数据目录中。

## 项目主页

产品主页是 [doublepi.dev](https://doublepi.dev/)，[CoCode 安卓版介绍页](https://doublepi.dev/cocode/)也位于同一个 GitHub Pages 站点。中英双语网站的源码位于 [`site/`](site/README.md)，包含响应式的功能展示、示意性的工作台界面和可复制的安装命令。网站独立于本地 Cox 应用，不托管智能体，也不存放用户数据。运行 `pnpm pages:test` 和 `pnpm pages:build` 可以校验并构建网站。账号主页及可选项目 Pages 的部署方法见[网站部署指南](site/README.md#account-homepage)（英文）。

## 通过 npm 快速开始

公开的 npm 包是 [`@doublepi123/cox`](https://www.npmjs.com/package/@doublepi123/cox)。请使用 Node.js `26.12.1`（CI 中测试的版本）和 npm。无需检出源码，也无需 pnpm：这个包已经包含构建好的浏览器界面和本地服务端。

```sh
npm install --global @doublepi123/cox@latest
cox
```

也可以不全局安装，直接运行最新版本：

```sh
npx @doublepi123/cox@latest
```

### 首次运行

1. 保持终端运行。Cox 会启动一个只监听本机回环地址的服务端，并打开浏览器。如果浏览器没有打开，请按照终端中打印的本地地址和认证说明操作；不要分享认证链接或令牌。
2. 在**设置**中配置一个受支持的提供商。基于 CLI 的提供商需要在本机安装其智能体 CLI 并完成认证；安装 Cox 不会顺带安装所有智能体，也不包含模型订阅或 API 额度。
3. 添加本地项目目录，新建对话，选择提供商和模型，然后发送消息。

Cox 的数据默认保存在 `~/.cox`。请妥善保管这个目录，不要让他人访问：其中保存着本地状态，包括对话历史和凭据。Cox 不会从 `~/.t3` 迁移数据。

### 常用命令

```sh
cox --help
cox --version
cox --no-browser
cox --host 127.0.0.1 --port 3773
cox --home-dir "$HOME/.cox-test" --port 3774
```

请以服务端打印的地址为准，不要假定端口固定不变。`--no-browser` 只是不再自动打开浏览器，本地认证仍然有效。`--home-dir` 用于指定单独的数据目录，适合用来搭建隔离的测试安装。

### 升级

先等智能体完成正在进行的轮次，再停止 Cox（在终端中运行时按 `Ctrl+C`）。然后更新软件包并重新启动：

```sh
npm install --global @doublepi123/cox@latest
cox --version
cox
```

沿用相同的数据目录和启动参数，即可保留现有的工作区。升级前，请在服务端停止的状态下备份 Cox 数据目录。如果你用服务管理器来管理 Cox，请更新该服务实际使用的那份安装，并通过服务管理器重启，不要另外再启动一个服务端。

请允许 npm 运行安装脚本，以便 Cox 为运行时依赖打补丁。如果原生依赖没有可用的预编译二进制文件，可能需要在本机安装 C/C++ 构建工具链。全局安装后如果找不到 `cox` 命令，请检查 npm 的全局可执行文件目录是否在 `PATH` 中，或者改用上面的 `npx` 命令。

## 项目范围

- Web 界面，以及本地的 Node HTTP/WebSocket 服务端。
- 本地智能体提供商、项目、对话、流式聊天、终端会话、Git/工作树和检查点。
- 提供 macOS / Windows Electron 桌面客户端；不提供 React Native/iOS/Android 应用，也不通过应用商店分发。
- 桌面客户端可直连用户自行部署的 Cox 服务端；不包含 T3 Connect、Clerk 云账号、中继、隧道服务、托管应用、服务发现或托管远程环境。
- 不使用上游的发布/更新服务，也不会自动从 T3 安装中迁移数据。

默认本地运行不代表离线推理。智能体提供商仍会使用各自配置的模型服务，Git 集成也可能访问你配置的代码托管平台。提供商认证和本地凭据存储功能仍然保留。

## 界面语言

Cox 支持简体中文和英文。首次打开时，界面会跟随设备或浏览器中受支持的语言偏好：偏好中文时显示中文，其他语言则回退到英文。语言设置只影响 Cox 自身的界面，不影响项目文件、智能体回复、终端输出或用户编写的内容。

在**设置 → 常规 → 语言**中可以选择 English、简体中文或“跟随设备语言”。所选语言保存在浏览器中，切换后界面立即更新，草稿不会丢失。设置页面（包括高级选项和根据 schema 生成的提供商字段）也会跟随所选语言。外部提供商的错误信息、原始诊断输出以及提供商提供的模型描述保留原文；翻译的覆盖范围和贡献指南见[本地化说明](apps/web/src/i18n/README.md)（英文）。

## 对话交互

处理中的对话显示在已置顶和活跃对话的上方。**处理中**分组默认展开；你手动展开或折叠后，浏览器会记住这个选择。

智能体运行一轮任务期间发送的消息默认进入队列。需要立即引导时，打开**发送**按钮旁的菜单，选择**立即引导**。如果你之前明确设置过后续消息的行为，该设置会被保留；智能体无法接受引导时，引导不可用。可以上移或下移排队中的消息，调整它们的发送顺序。

对话标题旁的圆点表示有已完成、但你还没查看的结果。

## 环境要求

- Node.js `26.12.1`（已测试）；使用已发布的 npm 包需要 npm，源码开发或使用 GitHub Release 归档需要 pnpm `12.14.0`。
- Git，以及在本机配置好的受支持智能体提供商。基于 CLI 的提供商需要安装其智能体 CLI 并完成认证（例如 Codex 或 Claude Code）。
- 如果某个原生依赖没有适用于你平台的预编译二进制文件，可能需要 C/C++ 构建工具链。

## 输入与项目操作

输入框中的行内 Markdown 格式标记现在可以直接编辑：将光标移入格式文本可修改标记，
移出后恢复格式显示。PR 描述中的任务复选框仅在已连接账号和本地连接都允许编辑时保存。

在 **设置 → 对话 → 新项目** 中启用 **按主机目录克隆**，新仓库的默认路径会采用
`基础目录/主机/所有者/仓库`，类似 ghq。默认关闭，不会移动现有检出目录；不安全或本地
URL 保留普通仓库目录名回退。受支持版本的 Claude Code 可以复用当前会话渲染 MCP Apps，
旧 CLI 仍显示普通工具结果，应用内工具调用保留权限校验。

## 订阅额度与 Codex 速度

在**用量 → 额度**中，只要已连接的提供商报告了相关数据，Cox 就会显示剩余百分比和重置时间。缺少额度数据时，不会被视为额度尚未使用。Cox 目前无法读取 ChatGPT 套餐共享（plan sharing）的剩余额度。仅凭 Cursor SDK/API 凭据，也拿不到 Cox 额度读取所需的控制台令牌；Cox 不会用其他账号的本地登录来代替。对于这些连接，Cox 会说明原因，并提供该提供商用量控制台的链接，请用已连接的账号在那里查看。使用 API 密钥或自定义 API 的连接不会查询 ChatGPT 订阅额度。

### API 网关与自定义模型

在**设置 → 提供商**中打开一个 Codex 或 Claude 实例，配置**API 网关 → API 地址 / API 密钥**。密钥单独保存在本机，不会以明文形式返回给浏览器。对该实例而言，这些设置优先于订阅认证；如果想同时保留 API 连接和订阅连接，请分别使用不同的实例。Codex 网关必须支持 OpenAI Responses API，Claude 网关必须支持 Anthropic Messages API。

保存设置后，在**模型**下选择**从网关刷新模型**。Cox 会读取网关的模型列表接口（包括分页），不会发送需要付费的推理探测请求。模型 ID、名称、上下文上限、推理强度选项和图片输入支持，只有在网关报告时才会填入。许多 `/models` 接口只返回 ID，因此未知的能力会保持未设置。

点击模型的编辑按钮，可以覆盖它的上下文窗口（令牌数）、图片输入支持或推理强度选项。覆盖设置按实例保存，优先于之后的自动发现结果，但不会让上游模型获得它本身不具备的能力。每项覆盖只替换它所设置的值：未设置的值（包括旧版设置保存的空推理强度列表）仍沿用自动发现的值。清除网关设置后，实例会恢复原来的认证配置。已有对话可能需要开启新会话，才能使用更改后的连接设置。

Cox 托管的 Codex 会保留其模型目录报告的速度档位，并把所选档位（包括快速档位 Fast）转发给 app-server。目录里列出某个档位，并不能证明你有权使用；上游服务可能针对特定账号或连接拒绝该档位。Cox 不会悄悄换用其他档位重试。账号目录中的速度选项会补上原生模型发现缺失的部分，但不会丢弃原生模型设置。两个目录都没有报告 Fast 时，Cox 不会提供该选项。

## 模型服务中心

在 **设置 → 模型服务中心** 配置 base URL、API key 和支持的协议，点击 **保存并获取模型**。
模型发现只读取元数据，不发起推理请求；服务未提供模型列表时，可以手动添加和编辑模型。
在 **设置 → Providers** 中，将 Codex、Claude Code、Pi 或 OpenCode 实例绑定到服务，选择模型范围和默认模型。
解除绑定后恢复实例原有的独立配置。

上游密钥和私有请求头存入本地独立凭据存储，agent 使用各自的本地网关凭据。
原生协议直接转发，跨协议请求通过内嵌的 MIT 开源项目
[CLIProxyAPI translator SDK](https://github.com/router-for-me/CLIProxyAPI) 转换，支持 OpenAI Responses、
Chat Completions、Anthropic Messages 和 Gemini，以及流式响应和工具调用。
转换无法赋予模型本身不具备的能力；Responses 跨协议转换需要完整对话输入，不支持跨协议估算 token 数。
集中更新密钥即时生效。修改绑定或模型目录可能重建 agent 会话，请在活跃任务结束后操作。

## 开发

源码构建还需要 Go `1.27.3`。开发时先运行 `node scripts/build-protocol-bridge.ts`，即可使用协议转换；
运行 `pnpm test:protocol-bridge` 验证转换器。`pnpm build` 会自动构建转换器，发布包内置原生二进制，
使用发布包无需安装 Go。构建和协议限制见 [`native/protocol-bridge/README.md`](native/protocol-bridge/README.md)。

```sh
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:5733`，按照服务端打印的本地认证流程操作。开发服务器会把 API 和 WebSocket 请求代理到 `127.0.0.1:4773`；不要设置 `VITE_HTTP_URL` 或 `VITE_WS_URL`。

开发状态隔离保存在当前工作副本的 `.cox/` 中，不会读取 `~/.t3`，也不会从中导入初始数据。如需更改端口，可以在环境变量或 `.env` 中设置 `COX_SERVER_PORT` 和 `COX_WEB_PORT`。`pnpm dev:server` 和 `pnpm dev:web` 可以分别单独运行服务端或前端。

## 生产部署

npm 的安装和升级命令见[通过 npm 快速开始](#通过-npm-快速开始)。

如果使用 GitHub Release，请下载 `cox-v<VERSION>.tar.gz` 和 `SHA256SUMS`，核对校验和后解压归档，再依次运行 `pnpm install --frozen-lockfile` 和 `pnpm start`。发布附件包含预构建的 Web 和服务端代码，但不包含 Node 和依赖。目前首先验证的平台是 Linux x64。详见 [RELEASING.md](RELEASING.md)（英文）。

如果改为从源码检出构建：

```sh
pnpm build
pnpm start
```

本地服务端在同一个源（origin）下同时提供构建好的 Web 应用及其 API。请使用启动时打印的本地浏览器地址。生产数据默认保存在 `~/.cox`；`--home-dir` 可以指定其他 Cox 数据目录。运行 `pnpm --filter cox start --help` 查看命令行选项。

Cox 默认监听本机回环地址，不要把它直接暴露给不受信任的网络。如需从其他设备访问，见[密码登录与远程访问](#密码登录与远程访问)。智能体能够操作文件系统和终端，因此本地认证和来源（Origin）检查始终必不可少。

## 密码登录与远程访问

桌面客户端可通过原生菜单的**连接管理**在本机与已保存的远程服务器之间切换。远程地址必须是 `https://cox.example.com` 这样的 HTTPS origin，服务端必须配置 `COX_AUTH_PASSWORD`；不接受 URL 中的凭据、明文 HTTP 或忽略证书错误。远程服务端提供与其版本匹配的 Web UI，并沿用 Cox 密码登录、同源 HTTPS API 和 WSS 连接。连接配置不保存密码。每个服务器使用独立的浏览器资料；忘记服务器会清除对应的本地会话和缓存。远程页面无权管理本地后端或桌面更新。从本地模式切出时，经确认后才停止自有后端；断开或退出远程模式不会停止服务端上的 Agent 和终端。身份验证代理的第三方 SSO 跳转不会嵌入桌面窗口。

Cox 默认监听 `127.0.0.1`。不设密码时，本机浏览器自动建立会话，不再需要配对码或配对链接；不要通过反向代理、隧道或端口转发暴露无密码模式。需要登录验证时，在启动 Cox 前设置一个至少 8 个字符的密码：

```sh
COX_AUTH_PASSWORD='use-a-long-random-password' cox --no-browser
```

密码同时保护本机和外部访问，设置密码不会自动扩大监听范围。浏览器登录后最多保持 30 天。5 分钟内失败 10 次后，密码登录会暂停，直到这段时间过去。用服务管理器运行 Cox 时，请把这个变量放在只有自己能读取的环境文件里，不要写在命令行上。旧名称 `T3CODE_AUTH_PASSWORD` 仍然可用。

要监听回环以外的地址，必须同时设置密码并显式传入 `--host 0.0.0.0`、`--host ::` 或数值 IPv4/IPv6 地址；除 `localhost` 外不接受 DNS 主机名。开发 Web 地址仍限于回环。非本机浏览器访问应使用 HTTPS，通常由 TLS 反向代理转发到 Cox。CLI 的 `auth session issue/list/revoke` 是可信本地管理入口，会复用持久化的认证策略；即使当前终端未继承服务密码，也不会修改该策略。

密码登录适用于在可信内网中自用。在公网上不要只依靠它：那样密码就是挡在能执行命令、修改文件的智能体前面的唯一屏障。如果要通过公网访问，请在 Cox 前面加一层带身份验证的代理，例如 Cloudflare Access（配合 Cloudflare Tunnel），或其他类似的身份感知代理或 VPN，并保留密码作为第二道防线。代理需要使用 HTTPS、支持 WebSocket，并通过 `Host` 保留公网域名；不可信的转发头不会授权浏览器来源。

从配对鉴权升级后，已有浏览器和客户端会话（包括 MCP）会失效，需要重新登录或批准客户端。项目、线程、消息和 provider 凭据会保留。修改或移除密码也会使已有会话失效。升级前请备份 Cox 数据目录；跨此认证迁移降级时，必须恢复对应的升级前备份。

## 检查

```sh
pnpm test
pnpm typecheck
pnpm build
```

各个包的测试也可以用 `pnpm exec vp test run <test-file>` 运行。

完整的服务端测试套件（`pnpm --filter cox test`）还需要：C 编译器，用于原生启动器的测试夹具；Playwright Chromium 及其平台依赖库，用于无头浏览器测试。用 `pnpm --filter cox exec playwright-core install chromium` 安装浏览器。这些只是测试的前置条件，不是桌面客户端的组件。

## 目录结构

- `apps/web`：浏览器界面。
- `apps/server`：本地 API、智能体进程与编排。
- `packages/client-runtime`：浏览器状态与本地连接运行时。
- `packages/contracts`、`packages/shared`：通信协议契约与共享工具。
- `packages/provider-*`：本地智能体适配器。
- `packages/source-control-*`：本地项目使用的 Git 托管平台集成。

内部包名仍沿用 `@t3tools/*`，以保持派生源码的兼容性；这并不表示会连接 T3 的云服务。

Cox 图标维护在 `apps/web/public/cox.svg`，界面、启动画面和浏览器标签页图标（favicon）都复用这个文件。修改后请运行 `node scripts/generate-icons.mjs` 重新生成 PNG 和 ICO 版本。这个维护命令需要 Playwright 的无头 Chromium。

## 署名与许可

本项目保留上游的 MIT 许可证和第三方声明，详见 [LICENSE](LICENSE)。Cox 是派生项目，不是 T3 的官方发行版本。

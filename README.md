# 小满桌宠

一个跑在 Windows 桌面上的 **Live2D 情感桌宠**。它有一副能看会动的身体，会读你的情绪、记得你们聊过的事，也会在没被叫的时候安静待在屏幕角落。

- **有身体**：Live2D 模型实时渲染，呼吸、眨眼、视线跟随鼠标，说话时嘴形跟着动。
- **会读情绪**：文字、声音、表情三路信号融合成一次情绪判断，它自己的心情也会随之改变。
- **记得住**：最近对话直接进上下文，跨度更长的事会被抽成长期记忆与相处摘要。
- **能说话**：叫它的名字就能唤醒，语音识别与语音合成都跑在本机，不上传。
- **看得见**：所有记忆、情绪曲线、聊天记录、功能开关都在网页端管理，改完立即生效。
- **不上传**：对话走你自己填的接口，语音与表情识别全在本机完成。

> 本项目是一个独立实现，参考了「Live2D + 大模型 + 本地语音」这一路线上开源项目的公开思路，代码为全新编写。

---

## 一分钟跑起来

需要 **Node.js 22.15 或更新**（脚本里用了 `--use-system-ca`，低版本没有这个参数）。

```powershell
npm install
npm run setup      # 拉取 Live2D 模型与前端运行时
npm start          # 开发模式启动
```

启动后桌宠会出现在屏幕右下角，管理页在 `http://127.0.0.1:8799/`。

想在管理页里也能用语音和表情识别，再补一步（约 150 MB，也可以在管理页点按钮下载）：

```powershell
npm run fetch:runtime
```

### 让它真的会聊天

首次启动是「本地模式」：内置规则先顶上，保证不联网也能回应。要接上真模型：

1. 打开管理页 → **模型与人格**；
2. 填 **接口地址**（DeepSeek 用 `https://api.deepseek.com`）、**模型名**（`deepseek-chat`）、**API Key**；
3. 点「测试连接」，绿灯后保存。

密钥只写在 `config.json` 里，只保存在本机，界面上永远只显示掩码。

---

## 打包成 exe

```powershell
npm run dist
```

产物在 `dist/`：

| 文件 | 说明 |
| --- | --- |
| `xiaoman-pet-1.0.0-setup.exe` | 安装版，可选安装目录，带开始菜单与桌面快捷方式 |
| `xiaoman-pet-1.0.0-portable.exe` | 免安装版，双击即走 |

只想要一个能直接跑的目录（不生成安装包）：

```powershell
npm run pack     # 产物在 dist/win-unpacked/
```

国内网络下第一次打包会卡在拉 NSIS、7zip 这些打包工具上，先挂镜像会快很多：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
npm run dist
```

打包特意关掉了 asar（`"asar": false`）。应用要直接读 Live2D 模型、MediaPipe 的 wasm、PowerShell 脚本，还要拉起 `whisper-cli.exe` 子进程——这些都需要真实文件路径，打进归档反而容易出问题。

打包版的数据目录在 `%APPDATA%\小满桌宠\`：`data\` 放配置/记忆/情绪/日志，`models\` 放语音组件。卸载不会删这两个目录。

---

## 怎么用

| 想做的事 | 怎么做 |
| --- | --- |
| 跟它说话 | 点它头上的输入条打字；或打开麦克风按钮直接说 |
| 叫醒它 | 管理页打开「语音监听」，然后叫「小满」 |
| 让它闭嘴 | 托盘菜单 → 静音模式；或管理页关掉「回复时读出来」 |
| 摸它 | 直接点它的头或身体，会触发对应动作 |
| 调大小/位置 | 管理页 → 桌宠，改完立刻生效；也可直接拖窗口 |
| 看它在想什么 | 管理页 → 情绪，有 72 小时曲线 |
| 看它记住了什么 | 管理页 → 记忆，可搜索、可改、可删、可手动加 |
| 出事看日志 | 管理页 → 日志，或 `%APPDATA%\小满桌宠\data\logs\pet.log` |

托盘图标的右键菜单里有：显示/隐藏、置前、静音、点击穿透、打开管理页、退出。

---

## 目录结构

```
app/
  main/          主进程：窗口、托盘、IPC、本地 HTTP 服务、app:// 协议
  core/          与界面无关的逻辑
    emotion/     情绪词典、三路信号融合、情绪状态机
    memory/      记忆存储、检索、抽取、摘要
    voice/       whisper 识别、SAPI 合成、唤醒词、语音服务编排
  renderer/
    pet/         桌宠窗口（Live2D 渲染、气泡、输入条、麦克风、摄像头）
    console/     网页管理台
  assets/
    live2d/      Live2D 模型（Haru，随包分发）
    scripts/     调用 Windows SAPI 的 PowerShell 脚本
    icons/       图标
scripts/         一次性脚本：拉素材、拉运行时、生成图标、清理
docs/            文档
runtime/         开发期的数据与模型目录（打包版改用 %APPDATA%）
```

### 技术选型

| 部分 | 用什么 | 为什么 |
| --- | --- | --- |
| 桌面框架 | Electron 38 | 透明窗口 + 无边框 + 托盘，一套代码管完 |
| Live2D | pixi.js 6.5.10 + pixi-live2d-display 0.4.0 | 0.4.0 是给 Pixi 6 写的，两者版本必须配对 |
| 对话 | 任意 OpenAI 兼容接口 | DeepSeek / Ollama / 本地服务都能填 |
| 语音识别 | whisper.cpp 独立进程 | 不走 N-API，避免 Electron 的 ABI 冲突 |
| 语音合成 | Windows SAPI | 零安装，中文音色开箱即用 |
| 面部情绪 | MediaPipe FaceLandmarker | 本地 WASM 推理，画面不出渲染进程、不落盘，默认关闭 |
| 记忆 | JSONL + 内存索引 | 数据量小，可读可备份，不引数据库 |

---

## 常见问题

**`npm run setup` 报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`**
这台机器的 Node 自带根证书不认 GitHub。npm 脚本里已经带了 `--use-system-ca`；如果你是自己手敲命令，也要加上这个参数。

**画面全白 / 模型没出来**
管理页 → 日志里搜 `模型已加载`。若走的是 `PET_SCALE` 之类环境变量，先确认没写错。Live2D 正常加载会打印内容范围与缩放值。

**它一直不回应打字**
管理页 → 模型与人格看是否「未配置」。没填 Key 时会走内置规则兜底，回复后面会带一行「现在是本地模式」，这是设计好的降级，不是坏了。

**语音识别没有结果**
`npm run fetch:runtime` 或管理页 → 语音 → 下载语音组件。下载完在识别参数里选模型规格，`base` 是速度与准确率的平衡点。

**端口被占用**
管理页默认 8799，被占用会自动往后试，最多 12 次。实际端口在日志「管理页已启动」那一行。

---

## 许可与致谢

- 代码：MIT
- Live2D 示例模型 **Haru** 与 Cubism Core 版权归 Live2D Inc. 所有，按 Live2D Free Material License Agreement 使用，原文见 `docs/live2d-sample-models-LICENSE.md`
- 第三方组件的版本与许可见 `docs/THIRD-PARTY-NOTICES.md`

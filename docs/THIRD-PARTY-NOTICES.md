# 第三方组件与许可

本应用分发的二进制里包含以下第三方组件。它们在打包后的位置一并列出，方便核对。

## 随应用分发的运行时代码

| 组件 | 版本 | 许可 | 用途 | 打包位置 |
| --- | --- | --- | --- | --- |
| [Electron](https://github.com/electron/electron) | 38.8.6 | MIT | 桌面运行时 | `小满桌宠.exe` 与 Electron 框架文件 |
| [pixi.js](https://github.com/pixijs/pixijs) | 6.5.10 | MIT | WebGL 渲染引擎 | `resources/app/app/renderer/pet/vendor/pixi.min.js` |
| [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) | 0.4.0 | MIT | Live2D 与 Pixi 的桥接 | `resources/app/app/renderer/pet/vendor/pixi-live2d-display.min.js` |
| [Live2D Cubism Core](https://www.live2d.com/sdk/cubism/) | 官方 Web 版 | Live2D Proprietary Software License Agreement | 解析并驱动 Cubism 4 模型 | `resources/app/app/renderer/pet/vendor/live2dcubismcore.min.js` |
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) | 1.1.1 | Apache-2.0 | 面部关键点与表情识别 | `resources/app/app/renderer/pet/vendor/mediapipe/` |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | b5454 | MIT | 本地语音识别 | 首次使用时下载到 `%APPDATA%\小满桌宠\models\whisper\`，**不随安装包分发** |
| [OpenAI Whisper ggml 权重](https://huggingface.co/ggerganov/whisper.cpp) | tiny / base / small / medium | MIT | 语音识别模型 | 同上，用户按需下载 |
| [MediaPipe face_landmarker.task](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) | float16/1 | Apache-2.0 | 面部模型权重 | 首次使用时下载到 `%APPDATA%\小满桌宠\models\mediapipe\` |
| Windows SAPI（Microsoft Speech API） | 系统组件 | 随 Windows 授权 | 语音合成 | 调用系统 `System.Speech`，不复制文件 |

## 模型与素材

**Live2D 示例模型 Haru**

- 来源：[Live2D/CubismWebSamples](https://github.com/Live2D/CubismWebSamples) → `Samples/Resources/Haru`
- 位置：`resources/app/app/assets/live2d/Haru/`（47 个文件，约 4.08 MB）
- 版权归 Live2D Inc. 所有，按 **Live2D Free Material License Agreement** 使用。
- 许可原文已随项目保存：`docs/live2d-sample-models-LICENSE.md`（由 `scripts/fetch-live2d.mjs` 在拉取模型时自动下载）
- 使用前请自行阅读该许可对用途的限制。**若要商用，请先确认许可范围，或换成你有权使用的模型。**

**应用图标**

由 `scripts/make-icons.mjs` 程序化生成，不使用任何第三方素材。

## 仅开发期使用、不随包分发

| 组件 | 版本 | 许可 |
| --- | --- | --- |
| [electron-builder](https://github.com/electron-userland/electron-builder) | 26.15.3 | MIT |

`node_modules` 里的开发依赖不会进入安装包。应用本体运行时只依赖 Node 内置模块与 Electron 自身。

## 网络请求

应用会主动联网的场景只有三处，都可以在离线状态下完全不触发：

1. **对话模型**：请求你自己配置的接口地址（默认 `https://api.deepseek.com`）。发给它的内容是你与桌宠的对话上下文；不发语音、不发图像。
2. **下载运行时组件**：仅在管理页点「下载语音组件」或 `npm run fetch:runtime` 时发生，从 whisper.cpp 的 GitHub Release / 镜像、HuggingFace 与 jsdelivr 拉二进制与权重。
3. **本地管理页**：`127.0.0.1` 上的一个 HTTP 服务，只在你自己机器上监听（除非你在配置里显式打开 `console.lanAccess`）。

除此之外没有任何遥测、统计或后台上报。语音识别（whisper.cpp）与表情识别（MediaPipe）都在本机推理，音频与画面不出本机。

## 许可文本获取

MIT / Apache-2.0 的完整文本在各组件的仓库里，或安装后位于：

- `resources/app/app/renderer/pet/vendor/`（前端运行时）
- Electron 自身的 `LICENSE`（安装目录下）

Apache-2.0 要求保留版权与许可声明，MIT 同理；上游文件中均保留了原始头部注释，未做删改。

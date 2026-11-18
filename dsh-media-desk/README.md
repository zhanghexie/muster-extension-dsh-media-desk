# 媒体创作台

复用 [dsh-media-desk](https://github.com/woniuniuniu/dsh-media-desk) 的 React 界面、示例素材、领域操作和成稿流程，接入 Muster 当前唯一的扩展宿主。上游基线为 `fc237f3388d048f51c3145cfd411dbb80ba2b388`（2.6.2），MIT 许可保留在 LICENSE。

## 界面和工作流

- 原版灵感墙、内容、排期、复盘、风格五个页面，以及卡片成稿工作室、内部助手和弹窗。
- 灵感录入、撤销、搜索、卡片编辑、日历排期、数据复盘和写作规则。
- 文字模型经 worker broker 流式调用；生图可在扩展设置中填写兼容 OpenAI Images 的接口地址、模型名和 API Key，试画后保存；也可选用已有宿主生图模型。无模型时明确标记本地结构草稿，不伪造生成结果。
- 系统文件选择器导入图片/视频；资产保存在宿主数据区，重开应用后可以恢复预览。
- 成稿和媒体导出到 Documents 下的目录，再通过当前实例的导出 ID 显示文件夹。
- 面板和 Pi Agent 操作同一个 DomainRuntime，Agent 修改会刷新界面。

布局、组件和素材来自原版；颜色、字体和进出场动画接入宿主主题与动画体系。设置页选择宿主已有模型，不保存另一份 API key。

## 构建与入口

`client/` 是可维护源码，`lib/` 是领域逻辑，`assets/` 是原版示例素材。运行 `node scripts/build-dsh-media-desk.mjs` 生成随包交付的 `ui/client.js` 和 `ui/host.css`，Electron 构建也会自动执行。`ui/panel.html` 加载当前 SDK 和生成产物。

`domain.mjs` 通过 `desk.read` / `desk.write` 接收面板与 Agent 请求，通过通用 broker 使用数据、模型和媒体能力。状态和设置分别写入工作区数据区的 `media-desk/state.json`、`media-desk/settings.json`，不写进源码目录。

## 边界

Monid 账号自动导入与账号刷新尚未接入，会明确说明；可粘贴素材提炼风格或手动录入数据。浏览器文件拖放尚未接通，使用「记灵感 → 图片/视频」的系统选择器导入。当前原版界面提供文字与生图流程；宿主网关的视频、TTS、ASR 能力仍存在，但没有另外增加这些工具的界面。

文字 worker 流式目前支持 OpenAI chat-completions 协议，其他协议明确拒绝。真实在线模型与 macOS/Linux 原生播放、文件管理器需要独立实机验收。

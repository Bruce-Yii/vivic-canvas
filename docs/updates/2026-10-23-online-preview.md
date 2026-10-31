# Vivic Online 第一版

用户本轮确认优先线上端，本地启动器以后再做；交付可部署版本，**本轮不发布**。本轮未修改正在使用的18787安装，不推送GitHub。

## 使用变化

- 首次进入“认识 Vivic → 连接在线服务 → 进入 Space”。第一步是明确标示的卡片示例；第二步使用已有 StepFun Coding Plan 连接测试、provider切换与状态复核；第三步可带清单草稿，由用户确认发送。未连接可以先体验内置文字指令。
- UI直接复用 `ECdison6227/rea-ui-library@26ac2724/platforms/web/hark` 已接入项目的七份原字体、原SVG glyph、连续圆角helper、透明表面、按钮与冻结天空。引导流程、连接状态与中英文字内容是Vivic目标适配，不伪称原版Hark引导。
- 线上设置保留模型/语音、外观、更多三组，移除本地准备、启动器、Pi登录和手机中继；商店未开放，不提供空跳转。卡片能力表默认折叠；新手引导可重新打开。重新查看隐藏但不卸载原owner/设置，保留草稿与连接。
- 首次不请求麦克风/定位；PTT或明确授权时再请求麦克风。线上缺设备坐标时不以服务器IP作用户位置。暂时没有线上常驻唤醒。

## 云端边界

新增独立 `online/index.ts`，严格使用带标记的 `dist-online`。每个HttpOnly/Secure/SameSiteStrict cookie对应独立应用、内存凭据与provider状态；内部bearer不发浏览器，客户端bearer拒绝。同源校验、端点白名单、请求大小/并发/限流、闲置/绝对TTL、取消和会话销毁均有界。线上不读取本机授权/偏好/中继，不运行托管或旧Kev模型；专用决策API未配置，仍可用现有规则和StepFun规划。

当前只支持用户自己的StepFun Coding Plan连接；不是任意供应商API接入或共享免费Key平台。模型连接成功也不保证该Key具有ASR/TTS权限。没有真实套餐/计费、账号或跨浏览器云同步；画布仍在当前浏览器。

Key断开、会话到期或服务重启即清除；异步验证受版本与取消保护，不能在旧会话销毁后重新挂入凭据。GPT dispose只清内存工作，不删除本机已有授权。

## 交付和验证

入口：[部署说明](../online-deployment.md)。部署源包含源码、锁文件、已构建网页、Docker/Compose与SHA256；没有Windows node_modules、服务器凭据或模型权重。基础镜像按官方manifest固定。当前只支持独立域名根路径，尚无子路径部署或多副本共享会话。

- 前端定向30项、后端定向90项通过；后端装配另有11文件277项集成检查通过。之后设置布局改动再跑相关14项通过。
- 3项生产构建浏览器流程通过：真实cookie bootstrap、引导失败/重试、模拟provider验证UI、真实基础卡片/Display、草稿不自动发送、重新引导保留owner/输入、390px/减少动效、深浅色、初始无麦克风调用。provider验证结果在浏览器测试中明确模拟，**不等同真实LLM服务验收**。
- 最终截图6张人工查看，窄屏顶部挤压已修复并加入无重叠断言；来源与目标仍有已记录中文字体fallback差异。
- Web/API类型检查、在线生产构建和打包通过；定向lint无错误，存在已记录的React effect/ref等建议警告及Vite既有WASM/大包提示，没有掩盖或skip测试。
- 部署源包独立目录 fresh offline frozen install：788包、0下载；Web在线构建、API类型、生产依赖部署、包内真实factory加载/StepFun状态/禁用本地接口/dispose及workspace子路径解析通过。测试没有调用外部模型。
- **未运行Linux/Docker镜像、真实用户Key推理/ASR/TTS或公网TLS代理。** 当前机器无Docker，不能把Windows源码闭包检查称为Linux运行通过。本轮不部署、不收费、不推送。

隔离证据在 `.cache/online-20261023/`；原失败截图与后续 `browser-final` / `browser-release` 保留。本机预览 `http://localhost:18794` 使用线上服务入口，原18787服务不重启；其公网可用性没有被宣称。

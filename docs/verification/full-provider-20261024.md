# StepFun 与本地运行实测（2026-10-24）

本轮使用用户此前授权的 StepFun Coding Plan Key，密钥由无回显 stdin 进入测试进程内存。未写入源码、报告或浏览器存储，未切换按量计费端点。在线引导优先输入 API key，本地启动器仍为可选。

## 真实 StepFun

端点为 `https://api.stepfun.com/step_plan/v1`，模型 `step-3.5-flash`。固定作者提供的测试输入，经过产品真实 `/api/intent`、Schema 和事实校验，没有用固定响应替代模型。

首轮发现 single_notification 只回复“收到”而不建卡；补充场景提示词，明确收到实际通知正文时保存为通知卡，同时保留解释、引用、不要建卡的区别。没有添加把关键词当模型判断的捷径。

修复后完整重跑：**29/29 通过**。包括 21 场景、便笺/计时/提醒、两项无卡场景、引用删除而不执行、真实 TTS、合成 WAV 的真实 ASR。无卡用例同时禁止任何卡片修改动作，不以“没创建卡片”掩盖误删除。TTS 音频仅保存/解码，未播放；没有采集物理麦克风。

- 最终证据：`.cache/full-acceptance-20261024/stepfun-final/report.json`。
- 首轮证据保留于 `apps/local-api/.cache/full-acceptance-20261024/stepfun/`，未把首轮写成全过。
- 修复验证脚本的 cwd：从 pnpm 子包目录启动时，仍将报告与音频转换路径固定到工作树，避免跳过 ASR。
- 场景回归专项 9 项通过；本轮 API 全量 1302 项通过、3 项既有外部用例跳过。

这是本次样本的实测结果，不代表模型对任意输入保证正确。旅游响应仍为产品明确标记的 DEMO，没有冒充真实旅行库存。

修复后的最终API全量为1319项通过。默认跳过的3项外网诊断随后启用开关全部补跑通过：真实Open-Meteo、无Key搜索诊断、公开网页与DNS/重定向/大小/超时保护。首轮重定向探针因httpbingo上游改为403而失败；直接检查第一跳确认httpbin仍返回预期302后，替换测试夹具地址并保留必须由Vivic返回400的原断言。没有以接受502代替校验通过。日志 `full-external-diagnostics-20261024-final.log`；其中无Key搜索诊断允许明确BLOCKED，不能据此声称该免费上游必然可用，真实StepSearch成功另有12项报告。

## Windows 本地运行

真实运行 `node scripts/verify-local-runtime.mjs --tts --cache .cache/local-runtime-next/managed`，复用此前独立缓存，重新验收准备、启动、推理、停止。

- StartLux 0.8B Instant：就绪成功；“展开这张便笺”被接受，约 973ms；“不要删除卡片”被保护门控拦截并降级，约 941ms。
- Sherpa-ONNX / Kokoro：就绪成功，两段不同文字生成不同的有效 24kHz WAV（120226 / 112982 字节）；没有播放。
- 两个运行时均停止并回到 cached。结果副本：`.cache/full-acceptance-20261024/windows-runtime.json`。

最终Mac兼容锁修复后，又在Windows正常准备0.8B缓存并更新运行回执；随后机器可用内存约0.7GiB，脚本拒绝再次加载，没有强行占用用户内存。这次重试不是成功推理，独立保存在 `windows-runtime-final-memoryguard.json`。此前成功的原始推理/TTS结果副本保留；最终锁对Windows选中的依赖版本没有变化。4B Windows仅准备通过，真实4B推理通过来自Mac。

这是运行能力与旧七标签受控流程验证。原生 Jev v2 的正式特调质量不由上述通过项代替，生产执行门控仍关闭。推荐 4B 与 Mac 的实测结果另见本轮对应报告。

## Computer Use：真实 Chrome + StepFun

使用独立测试地址 `127.0.0.1:18796`，新建“验收 20261024”画布，不修改用户 18787 服务或画布。通过可见 UI 验证：

1. 创建目标进度 6/10，真实模型生成并显示 60%。
2. 自然语言改为 8/10，展示页实时更新为 80%。
3. 展示页传送门送回用户页，按钮增加到 9/10。
4. 重载用户页，内容及 9/10 进度保留。
5. 点击可撤销删除，再输入“撤销”，卡片与进度恢复。
6. 再次放回副屏，展示页显示 90%。
7. 设置→连接→手机连接显示与正式 APK 对应的下载入口；设置→偏好可切换球配色，保持唤醒及语音回复关闭。

截图：`.cache/full-acceptance-20261024/cua/progress-restored.png`、`android-download-panel.png`、`settings-orb.png`。由展示按钮新开的一个窗口在 CUA 环境中未完成节点测量且 CDP 截图超时；同一 URL 直接新建浏览器标签页显示正常。随后独立浏览器在正常后台节流参数下，通过真实展示按钮新开窗口、冻结、owner 新增卡片、恢复/前台补齐、重载测试。该现象未在独立复测复现，保留为 CUA 窗口激活/控制环境限制，未因此更改 React Flow 或安装扩展。

## 真实在线会话与外部数据

新增 `scripts/verify-online-features-live.ts`，真实调用隔离在线会话的连接、模型、数据与退出接口，没有公开部署。首轮 9/11 通过：发现“用柱状图记录”不匹配，以及读取过大网页误报连接中断。修复后完整 **12/12 通过**：

- 在会话 A 验证真实 Key；会话 B 保持未连接，跨源请求被拒绝。
- 真实上海天气带 Open-Meteo 地理/预报来源；StepSearch 返回三张有来源卡片。
- React Flow 页面实测约 654KB，超过原 256KB 读取上限。保留上限，修复销毁响应时 `aborted` 抢先覆盖大小错误的问题，准确反馈过大且不建卡。另读 142KB 的公开 RFC 正文成功并带来源。
- 表格与“用柱状图记录”保留用户 3/5/4 数据，不虚构数值。
- SSE 完整返回；断开后 Key 清除；会话关闭后旧 cookie 被拒绝。

最终证据 `.cache/full-acceptance-20261024/online-live-final/report.json`，首轮失败证据保留在 `online-live/report.json`。读取页受原大小/文本/公开 HTTPS 限制，不宣称所有任意网页均可抓取。

## 本轮发现的离线命令兼容回归

backend-first 任务接线令旧浏览器解析器的成功动作不能直接执行，导致未连接模型时“放大倒计时”“删除这个”“暂停开会提醒”失去兼容。已将闭合语法的单目标兼容放到后端无 planner 分支，继续要求 task/owner/保存回执；在线模型明确澄清或拒绝的结果不能由此前端规则覆盖。

多个目标、截断上下文、否定/引用/复合指令仍不自动执行。暂停/继续仅支持普通计时与一次性提醒，日期/重复/条件计时拒绝。新增任务链路回归用例验证执行前状态、回执后完成及上述边界；最终浏览器复验见 Web 报告。

## Browser Extension 的判断

目前不添加扩展。现有需求是同源 Control/Display 同步、保存、重连、扫码远控，应在现有 owner、数据库与传输中验证和修复。没有证据说明安装扩展能替代这些保证。

Chrome 扩展的 service worker 本身可能因空闲而停止，官方要求设计为可恢复；网页也有 frozen/discarded 生命周期。因此“装一个扩展就不会掉线”不成立。未来如明确需要采集外部网页、右键收藏或跨站权限，再独立设计可选扩展。

来源：[Chrome extension service worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)。上述是否需要扩展为结合产品架构与本轮测试的工程判断。

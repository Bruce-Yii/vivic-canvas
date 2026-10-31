# Travel Vivic Space

一个只包含旅行的 Vivic 空间。参赛体验者打开链接即可规划、编辑和收藏，不进入个人 Control/Display，也不需要连接本地主产品。

**当前交付是完整的离线 DEMO。** 行程是确定性规划模板，不是模型或实时服务推荐；住宿是三个虚构的偏好画像，没有价格、评分、库存或预订链接。预算金额来自用户输入，分配建议由确定算式生成。飞猪 live、真实模型以及订票能力均未接入。添加任何 API key 都不会自行开启联网。

## 体验

1. 填写出发地、目的地、1–7 天、总预算与偏好，点击「生成旅行卡片」。默认上海 → 杭州 3 天只是可修改的表单示例。
2. 在每日行程点「编辑行程」，修改主题与上午/下午/晚上安排。
3. 在节奏对比卡点击方案名记录推荐；住宿卡点「选择」收藏偏好、填写备注。
4. 修改预算后会提示条件尚未应用；点「重新规划」更新卡片。每日手动安排会重建，同一目的地仍有效的收藏与备注保留。修改目的地清除旧目的地收藏与备注。
5. 「刷新结果」只刷新住宿卡，保留其他卡片；空结果会清除已失效的选择。失败和取消保留上一次计划。
6. 刷新页面，编辑与收藏恢复；「导出计划」下载 Markdown。「清空旅行空间」只清除此体验的保存。
7. 展开「演示状态与数据说明」，可切换正常、空结果、模拟失败。生成时可以取消。

计划只保存在当前浏览器的 `vivic.travel-space.demo.v1`，应用链接不包含计划。其他浏览器/context 各自拥有空白空间。没有共享账户、服务端计划数据库或主产品 owner 连接。

## 从源码运行

在 Vivic 仓库根目录运行。复用现有锁定依赖，不新增根依赖，不运行主 `vite.config.ts` 的凭据代理。

```sh
# 首次使用按仓库贡献指南安装 Node/pnpm 以及冻结锁依赖。
node apps/web/node_modules/vite/bin/vite.js --config contrib/travel-space/vite.config.mjs

# 独立生产构建
node apps/web/node_modules/vite/bin/vite.js build --config contrib/travel-space/vite.config.mjs

# 本地静态体验 http://127.0.0.1:5196/
node contrib/travel-space/server.mjs
```

源码依赖 Vivic 的共享组件/契约，`contrib/travel-space` 不是可单独 npm install 的新产品。构建后的 `dist/` 与 Node 部署包完全独立，不需原仓库或 npm 依赖。

## 部署与交付

**静态优先：** 将 `contrib/travel-space/dist/` 的内容部署到 HTTPS 站点根目录。路径不是 `/` 时，构建前设置 `TRAVEL_BASE_PATH=/travel/`。应用不需要服务端 API；不用部署主产品、数据库、owner 或密钥。

**Node 部署包：** 构建后运行：

```sh
node contrib/travel-space/package-delivery.mjs
```

输出 `artifacts/travel-vivic-space-demo.zip` 与 `.sha256`。包仅包含 `dist/`（含第三方完整许可证）、`server.mjs` 和启动说明。根路径构建可在解压后用 Node 22+ 执行 `node server.mjs`。由已有 HTTPS 反向代理指向 `127.0.0.1:5196`，设置 `TRAVEL_PUBLIC_ORIGIN=https://实际域名`。进程启动配置由部署者设置，server 不自动读 `.env`。最终交付产物按 `/travel-vivic/` 构建，供 `https://edsionc.top/travel-vivic/` 的静态部署；该包的静态资源路径与根路径本地 server 不同，请按包内启动说明选择静态路径或重建根路径版本。

环境变量：`TRAVEL_HOST` 默认 `127.0.0.1`、`TRAVEL_PORT` 默认 `5196`、`TRAVEL_PUBLIC_ORIGIN` 为精确外部 origin。公开绑定必须显式设置 origin。静态包中的端点只支持根路径；若采用子路径部署，建议直接静态托管 dist。

Node 服务提供 CSP、禁止相机/麦克风/定位、路径边界、请求超时、同源 POST 校验、每 IP 每分钟 20 次 API 写请求限流、最多 2000 个一小时访客会话、HttpOnly/SameSite=Strict cookie。HTTPS origin 自动加 Secure。来源校验不信任 Host/X-Forwarded-*；反代场景下频控默认共享代理 IP，是保守的全局上限，尚未实现可信代理解析。会话仅用于验证未来接入边界，当前静态 UI 不创建 cookie、不请求 API。每会话实际服务调用预算固定为 **0**。

- `GET /api/travel/capabilities`：如实返回 `mode:demo, liveEnabled:false`。
- `POST /api/travel/session`：精确同源请求建立独立的临时访客 cookie。
- `POST /api/travel/query`：缺会话 401；有效会话也返回 503 `live_not_configured`。不接受查询体、不调用上游。

未部署、未 push、未报名或提交比赛。GitHub 源码可作为此目录的独立提交加入原 Vivic 仓库；提交/推送/比赛报名由负责人统一操作。公开 GitHub + 体验 URL 是本次用户交付要求，尚未把它当作已核验的官方参赛细则。

## 验证

```sh
node apps/web/node_modules/typescript/bin/tsc -p contrib/travel-space/tsconfig.json
node apps/web/node_modules/vitest/vitest.mjs run --config contrib/travel-space/vitest.config.mjs
node --test contrib/travel-space/server.test.mjs
node apps/web/node_modules/vite/bin/vite.js build --config contrib/travel-space/vite.config.mjs
# 与仓库其他 Playwright 串行运行。隔离 context、无麦克风、无语音输出。
node apps/web/node_modules/@playwright/test/cli.js test --config contrib/travel-space/playwright.config.mjs
```

6 项逻辑测试覆盖契约、只读服务字段、收藏恢复、空结果、取消/错误、预算及损坏存储；4 项服务测试覆盖隔离 cookie、跨源拒绝、禁用 live、频控、容量与路径边界。浏览器验证和截图记录见 `VERIFICATION.md`。

## 实现边界与接入专用 Key

复用 `SceneCardShell`、`TravelOffersCardView`、`ComparisonCardView`、Lucide、主产品 tokens 与流光以太 12 配色。每日安排是既有 NoteCard 的旅行视图，不新增 cardType。数据复用 `TravelQuerySchema → demoTravelProvider → queryTravel → buildTravelCard`，宿主用 `CardRecordSchema` 和 `cardFieldPolicyIssue` 验证更新。独立入口不导入主 owner、store、sync、OAuth、语音或凭据代理。新增文件均在此目录；未改变主产品路由、共享契约或根 lock。

官方核验及 live 待办见 [PROVIDER-INTEGRATION.md](PROVIDER-INTEGRATION.md)。专用 key 将来只能存在于服务端环境变量/凭据管理，绝不可使用 `VITE_*`、写入卡片、前端包、浏览器存储、日志或 Git。此版本没有 key 设置入口，也没有 key reader。下一步必须先核验官方 MCP transport、鉴权、`tools/list` 与脱敏响应，再实现和验证受控 server adapter；不能把 CLI 参数名当 MCP tool schema，不能仅将 mode 改成 live。

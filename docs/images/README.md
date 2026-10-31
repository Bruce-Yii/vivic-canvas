# README 图片来源

采集日期：2026-10-17。来源：[VIVIC 官网](https://edsionc.top/vivic/)。

| 文件 | 内容与来源 |
| --- | --- |
| `hero.jpg` | 官网首页 `#top` |
| `scene-cards.jpg` | 场景卡片展示 `#scenes` |
| `two-windows.jpg` | 双窗口工作方式 `#how` |
| `time-and-reminders.jpg` | 时间与提醒 `#time` |
| `editable-cards.jpg` | 卡片编辑演示 `#hands` |
| `ambience.jpg` | 背景与配色 `#ambience` |
| `community.jpg` | 联系我们 `#contact`：小红书、微信、官网和麦当劳 MCP 仓库四个二维码 |
| `wechat-group.png` | 官网原始图片：`https://edsionc.top/vivic/contact/wechat-group.png` |
| `xiaohongshu-group.png` | 官网原始图片：`https://edsionc.top/vivic/contact/xiaohongshu-group.png` |
| `website-qr.png` | 本地生成的标准二维码，内容为 `https://edsionc.top/vivic/`，用于扫码访问官网 |

截图使用独立 Chromium 浏览器上下文，桌面宽度 1600 px、设备像素比 1、中文与上海时区，启用减少动态效果的偏好，以便阅读静态卡片。截图保留官网实际渲染内容，未提交报名表单、登录账号或启用麦克风。

画面里的数字、日期、新闻和卡片均为官网演示数据，不表示实时查询结果。官网与本仓库的发布节奏可能不同，具体功能以当前源码和交接文档为准。

演示照片沿用项目 `apps/web/src/landing/demoCards.ts` 中的 Unsplash 图片来源：

- [湖边小屋](https://images.unsplash.com/photo-1470770841072-f978cf4d019e?w=900&q=75)
- [山路](https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=900&q=75)
- [日落](https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=900&q=75)
- [海边](https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1000&q=75)

交流群二维码可能更新；最新二维码以官网「联系我们」为准。

## 2026-10-22 本地功能截图

`card-portal-20261022.jpg` 来自 `apps/web/tests/e2e/card-portal.spec.ts` 的独立 Chromium 测试上下文，展示深色卡片传送门、搜索、聚焦和双向传送入口。画布内容为测试合成的“拖入传送门”待办，不含用户画布、账号或凭据。原始 PNG 保存在本机忽略目录 `evidence/card-portal-20261022/`，提交图片仅缩放至 1440px 并压缩为 JPEG，没有改变界面内容。

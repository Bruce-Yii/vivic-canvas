# 展示页NewsCard对比度修复

G阶段实际截图确认：展示页NewsCard的表面透明，文字仍采用浅色模式的深色文字，在黑色舞台上难以阅读。

本补丁仅让展示页的NewsCard采用已有Hark实色表面，自动跟随深浅色令牌。保持原卡片内容、图片、布局、字体和其他卡型。对应源码已同步到 `apps/web/src/cards/scene/views/NewsCardView.css`。

发布基于F5当前完整恢复包，先逐文件检查1866文件未变，复制为新发布目录，只新增CSS并更新入口与头配置。沿用已验证的前端原子切换、健康检查和自动回滚实现。

```powershell
python scripts/publish-display-contrast.py
python scripts/publish-display-contrast.py --apply
python scripts/publish-display-contrast.py --rollback
```

真实模型样本的修复前后截图、深浅色计算与图片加载结果见G阶段报告。原F5发布保留供回滚；本补丁不重启后端、不改变卡片包接口或直接执行名单。

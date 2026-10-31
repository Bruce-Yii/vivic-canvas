# 服务端澄清与删除确认保护

G阶段实际网页复测发现：服务端已返回冻结编号的澄清问题，旧前端却将legacy-fallback的clarify结果改成本地候选；点击候选时直接删除，跳过服务器的第二次确认。

本补丁保留服务端问题的task与continuation；服务端clarify/awaiting_clarification不再转本地选择器。旧本地选择器也不能处理删除。候选点击继续回复服务端编号，删除仍需明确确认，取消保留原卡片。

源码为 `control/legacyChoicePolicy.ts` 和 `ControlApp.tsx`，含4项回归测试。基于当前前端快照定点修补相应分支，复制既有v54入口和运行时为新文件名，避免缓存继续使用旧分支；没有用旧源码全量覆盖线上界面。对比度修复和F5卡包三项均保留。

```powershell
python scripts/publish-clarification-guard.py
python scripts/publish-clarification-guard.py --apply
python scripts/publish-clarification-guard.py --rollback
```

发布前逐文件校验当前完整前端，采用原子指针切换和健康检查自动回滚。复测覆盖实际网页的候选点击、选择后另行确认、取消保留两卡、明确确认只删所选卡。前后证据与原始失败均保留在G阶段报告。

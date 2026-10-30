import { useEffect, useRef, useState } from "react";
import type { HostedSpaceSnapshot } from "@vivic/contracts";
import type { CanvasRecord } from "@/persistence/canvasRecord";
import type { StoredCardDefinition } from "@/persistence/db";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { newId } from "@/lib/id";
import { hostedClient, HostedApiError, isUnknownResult } from "./client";
import { HostedDialog } from "./HostedDialog";
import { writeLocal } from "./storage";
import { beginMigration, commitMigration, errorMessage, inspectLegacySource, migrationKey, migrationStatus, pickedLegacyAsset, readLegacySources, readMigration, replayMigration, stageMigrationAssets, type LegacySource, type MigrationStatus } from "./migrationClient";

export function HostedMigration({ spaceId, onSnapshot, onClose }: { spaceId: string; onSnapshot(snapshot: HostedSpaceSnapshot): void; onClose(): void }) {
  const [records, setRecords] = useState<CanvasRecord[]>([]), [definitions, setDefinitions] = useState<StoredCardDefinition[]>([]), [selected, setSelected] = useState("");
  const [source, setSource] = useState<LegacySource | null>(null), [status, setStatus] = useState<MigrationStatus | null>(null), [receipt, setReceipt] = useState(() => readMigration(spaceId));
  const [canReplay, setCanReplay] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("正在读取此浏览器的旧 Space…"), alive = useRef(true), running = useRef(false);
  const accept = (value: MigrationStatus) => { if (!alive.current) return; setStatus(value); if (value.status === "succeeded" && value.snapshot) { onSnapshot(value.snapshot); writeLocal(migrationKey(spaceId), ""); setReceipt(null); setMessage("导入已保存。旧浏览器数据仍保留。"); } else setMessage(`原件已暂存 ${value.received.length} 份，还缺 ${value.missing.length} 份。卡片尚未提交。`); };
  useEffect(() => { alive.current = true; void readLegacySources().then(value => { if (alive.current) { setRecords(value.records); setDefinitions(value.definitions); setSelected(readMigration(spaceId)?.sourceId ?? value.records[0]?.id ?? ""); setMessage(value.records.length ? "选择旧 Space，检查后再导入当前服务器 Space。" : "此浏览器没有找到旧 Space。请在原浏览器执行导入。"); } }).catch(error => { if (alive.current) setMessage(errorMessage(error)); }); return () => { alive.current = false; }; }, [spaceId]);
  const run = (operation: () => Promise<void>) => { if (running.current) return; running.current = true; setBusy(true); void operation().catch(error => { if (alive.current) setMessage(errorMessage(error)); }).finally(() => { running.current = false; if (alive.current) setBusy(false); }); };
  const inspect = async () => { const record = records.find(record => record.id === selected); if (!record) return; setSource(await inspectLegacySource(record, definitions)); setMessage("检查完成。导入会保留卡片内容、顺序、卡片包和原件，不删除旧数据。"); };
  const stageAvailable = async (current: MigrationStatus) => {
    if (!source) throw new HostedApiError(400, "migration-source", "请先重新检查同一个旧 Space，再继续上传原件。");
    let value = current; const available = source.assets.filter(asset => current.missing.some(missing => missing.legacyId === asset.metadata.legacyId));
    let batch = [] as typeof available, size = 0;
    for (const asset of available) { if (asset.blob.size > 10_000_000) throw new HostedApiError(400, "migration-batch", "单个原件超过10MB，尚未导入。");
      if (batch.length === 5 || size + asset.blob.size > 10_000_000) { value = await stageMigrationAssets(spaceId, current.requestId, batch); accept(value); batch = []; size = 0; }
      batch.push(asset); size += asset.blob.size;
    }
    if (batch.length) { value = await stageMigrationAssets(spaceId, current.requestId, batch); accept(value); }
    if (!value.missing.length) accept(await commitMigration(spaceId, current.requestId));
  };
  return <HostedDialog title="导入旧 Space" onClose={onClose}><div className="hosted-form"><p className="hosted-muted">从此浏览器读取旧数据。导入至当前账号的服务器 Space；旧 IndexedDB 保留。</p>
    <label>此浏览器的旧 Space<select value={selected} disabled={busy || Boolean(receipt)} onChange={event => { setSelected(event.target.value); setSource(null); setStatus(null); }}><option value="">选择来源</option>{records.map(record => <option key={record.id} value={record.id}>{record.title} · {record.cardOrder.length} 张卡片</option>)}</select></label>
    <button className="hosted-quiet" disabled={busy || !selected} onClick={() => run(inspect)}><HarkIcon name="search" />检查来源</button>
    {source && <div className="hosted-migration-preview"><p>{source.record.cardOrder.length} 张卡片 · {source.definitions.length} 个卡片包 · {source.assets.length} 份可用原件</p>{source.missing.length > 0 && <p className="hosted-muted">有 {source.missing.length} 份原件不在此浏览器，需补齐后才能保存。</p>}</div>}
    {!receipt && source && status?.status !== "succeeded" && <button className="hosted-primary" disabled={busy} onClick={() => run(async () => { const requestId = newId("import"), current = await hostedClient.snapshot(spaceId), next = { requestId, sourceId: source.record.id }; setReceipt(next);
      let value: MigrationStatus;
      try { value = await beginMigration(spaceId, requestId, current.space.version, source); }
      catch (error) { if (!isUnknownResult(error)) { writeLocal(migrationKey(spaceId), ""); setReceipt(null); } else setReceipt(readMigration(spaceId)); throw error; }
      setReceipt(readMigration(spaceId));
      accept(value); if (value.status !== "succeeded") await stageAvailable(value);
    })}>导入到当前 Space</button>}
    {receipt && status?.status !== "succeeded" && <><button className="hosted-quiet" disabled={busy} onClick={() => run(async () => { try { accept(await migrationStatus(spaceId, receipt.requestId)); setCanReplay(false); } catch (error) { if (error instanceof HostedApiError && error.status === 404) setCanReplay(true); throw error; } })}>查询原导入进度</button>{source && <button className="hosted-primary" disabled={busy} onClick={() => run(async () => { const value = await migrationStatus(spaceId, receipt.requestId); accept(value); if (value.status !== "succeeded") await stageAvailable(value); })}>继续原导入</button>}{source && canReplay && <button className="hosted-quiet" disabled={busy} onClick={() => run(async () => { const value = await replayMigration(spaceId, source); setCanReplay(false); accept(value); if (value.status !== "succeeded") await stageAvailable(value); })}>来源未改，按原编号重试</button>}</>}
    {status?.missing.map(missing => <label key={missing.legacyId} className="hosted-migration-missing"><span>补齐：{missing.expected?.name ?? missing.legacyId}</span><input type="file" disabled={busy} accept={missing.kind === "image" ? "image/jpeg,image/png,image/webp" : undefined} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) run(async () => { const asset = await pickedLegacyAsset(file, missing), value = await stageMigrationAssets(spaceId, status.requestId, [asset]); accept(value); if (!value.missing.length) accept(await commitMigration(spaceId, status.requestId)); }); }} /></label>)}
    <p role="status" className="hosted-muted">{busy ? "正在处理，请保留此页…" : message}</p>
  </div></HostedDialog>;
}

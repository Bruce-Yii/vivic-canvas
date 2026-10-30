import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { CardRecord, FileCard, HostedSpaceSnapshot, SceneImage } from "@vivic/contracts";
import { HostedMediaResolverContext } from "@/cards/scene/HostedMediaScope";
import { assetPath, queryUpload, uploadFiles, uploadKey, uploadPhotos } from "./client";
import { readLocal } from "@/hosted/storage";
import "./assets.css";

const HostedAssetPanels = lazy(() => import("./HostedAssetPanels").then(module => ({ default: module.HostedAssetPanels })));
interface HostedAssetActions {
  openFile(card: CardRecord): void;
  upload(files: File[]): Promise<void>;
  addPhotos(files: File[]): Promise<SceneImage[]>;
  manageAssets(): void;
}
const Context = createContext<HostedAssetActions | null>(null);
export function useHostedAssets() { const context = useContext(Context); if (!context) throw new Error("Hosted assets need a Space provider"); return context; }
export function HostedAssetProvider({ spaceId, onSnapshot, children }: { spaceId: string; onSnapshot(snapshot: HostedSpaceSnapshot): void; children: ReactNode }) {
  const [file, setFile] = useState<FileCard | null>(null), [manage, setManage] = useState(false), [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [notice, setNotice] = useState(""), [uploadPending, setUploadPending] = useState(() => readLocal(uploadKey(spaceId))), uploading = useRef(false), alive = useRef(true);
  const resolver = useCallback((reference: string) => { const match = /^media:(image_[a-f0-9]{64})$/.exec(reference); return match ? `${assetPath(spaceId, match[1])}/content` : undefined; }, [spaceId]);
  useEffect(() => { alive.current = true; const id = readLocal(uploadKey(spaceId)); if (id) void queryUpload(spaceId, id).then(result => { if (alive.current) { onSnapshot(result.snapshot); setUploadPending(""); setNotice("已确认上次文件上传。"); } }).catch(() => { if (alive.current) setNotice("上次文件上传结果尚待确认。"); }); return () => { alive.current = false; }; }, [spaceId, onSnapshot]);
  const actions: HostedAssetActions = {
    openFile: card => { if (card.type === "FileCard") setFile(card); },
    upload: async files => { if (uploading.current) return; uploading.current = true; try { const result = await uploadFiles(spaceId, files); if (alive.current) { onSnapshot(result.snapshot); setUploadPending(""); setNotice(""); } }
      catch (error) { if (alive.current) { setUploadPending(readLocal(uploadKey(spaceId))); setNotice(readLocal(uploadKey(spaceId)) ? "文件上传结果待确认，打开原件管理查询。" : ""); } throw error; }
      finally { uploading.current = false; } },
    addPhotos: files => uploadPhotos(spaceId, files),
    manageAssets: () => setManage(true),
  };
  return <Context value={actions}><HostedMediaResolverContext value={resolver}>{children}<div ref={setContainer} className="hosted-assets-portals" />
    {notice && <div className="hosted-assets-notice" role="status"><button onClick={() => setManage(true)}>{notice}</button><button aria-label="收起提示" onClick={() => setNotice("")}>×</button></div>}
    {(file || manage) && container && <Suspense fallback={<span role="status">正在打开原件…</span>}><HostedAssetPanels spaceId={spaceId} file={file} manage={manage} container={container} uploadPending={uploadPending} onCloseFile={() => setFile(null)} onCloseManage={() => setManage(false)} onRecovered={snapshot => { onSnapshot(snapshot); setUploadPending(""); setNotice("已确认文件上传。"); }} /></Suspense>}
  </HostedMediaResolverContext></Context>;
}

import { useEffect, useRef, useState } from "react";
import { HoverCard } from "radix-ui";
import QRCode from "qrcode";
import { hostedClient, type HostedDevice } from "./client";
import { Button } from "@/components/ui/button";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { AndroidDownload } from "@/control/mobile/AndroidDownload";

export function OwnerDevices() {
  const [devices, setDevices] = useState<HostedDevice[]>([]), [code, setCode] = useState(""), [expiresAt, setExpiresAt] = useState("");
  const [message, setMessage] = useState(""), [qr, setQr] = useState(""), [qrLoading, setQrLoading] = useState(false), [qrError, setQrError] = useState("");
  const qrAttempt = useRef(0);
  useEffect(() => { void hostedClient.devices().then(value => setDevices(value.devices)).catch(() => setMessage("设备列表暂不可用。")); }, []);
  useEffect(() => () => { qrAttempt.current += 1; }, []);
  const generateCode = () => {
    setMessage("");
    setQr("");
    setQrError("");
    void hostedClient.pair().then(value => {
      setCode(value.code);
      setExpiresAt(value.expiresAt);
      setMessage("在另一台设备扫描二维码，或打开登录页输入设备码。");
    }).catch(() => setMessage("设备码生成失败，请重试。"));
  };
  const loadQr = () => {
    if (!code || qr || qrLoading) return;
    const attempt = ++qrAttempt.current;
    const url = new URL("/", window.location.origin);
    url.searchParams.set("pair", code);
    setQrLoading(true);
    setQrError("");
    void QRCode.toDataURL(url.href, { width: 220, margin: 2, errorCorrectionLevel: "M" }).then(value => {
      if (attempt === qrAttempt.current) setQr(value);
    }).catch(() => {
      if (attempt === qrAttempt.current) setQrError("二维码加载失败，请直接输入设备码。");
    }).finally(() => {
      if (attempt === qrAttempt.current) setQrLoading(false);
    });
  };
  return <section className="se-device-settings" data-vivic-owner-devices>
    <p className="se-caption">手机和电脑使用同一账号的云端 Space。</p>
    <div className="se-device-actions">
      <AndroidDownload />
      <a href="/remote/" target="_blank" rel="noreferrer">打开手机页面</a>
      <Button size="sm" onClick={generateCode} data-vivic-device-code-generate>生成设备码</Button>
    </div>
    {code && <div className="se-device-code-block">
      <div className="se-device-code-line">
        <span>设备码</span>
        <HoverCard.Root openDelay={140} closeDelay={100} onOpenChange={open => { if (open) loadQr(); }}>
          <HoverCard.Trigger asChild>
            <output className="se-device-code" tabIndex={0} aria-label={`设备码 ${code}，悬停或聚焦查看配对二维码`} data-vivic-device-code>{code}</output>
          </HoverCard.Trigger>
          <HoverCard.Content side="right" align="start" sideOffset={10} collisionPadding={16}
            className="se-device-qr-popover" data-vivic-device-qr>
            <div className="se-device-qr-heading"><strong>配对二维码</strong><span>扫描后确认授权</span></div>
            {qrLoading ? <div className="se-device-qr-loading" role="status"><HarkIcon name="refresh" size={18} aria-hidden="true" /><span>正在加载二维码…</span></div>
              : qr ? <img src={qr} alt={`设备码 ${code} 的配对二维码`} width={220} height={220} />
                : qrError ? <p className="se-error" role="status">{qrError}</p>
                  : <div className="se-device-qr-loading"><span>悬停后加载二维码</span></div>}
            <p className="se-caption">设备码仅限一次使用{expiresAt ? `，有效至 ${new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}。</p>
          </HoverCard.Content>
        </HoverCard.Root>
      </div>
      <p className="se-caption">鼠标移到设备码上可加载配对二维码。</p>
    </div>}
    {message && <p className="se-caption" role="status">{message}</p>}
    <div className="se-device-list">
      <h3>已授权设备</h3>
      {devices.length ? devices.map(device => <div className="se-device-row" key={device.id}>
        <span><HarkIcon name="computer" size={16} aria-hidden="true" />{device.name}</span>
        {device.current && <span className="se-device-current">当前设备</span>}
      </div>) : <p className="se-caption">暂无已授权设备。</p>}
    </div>
  </section>;
}

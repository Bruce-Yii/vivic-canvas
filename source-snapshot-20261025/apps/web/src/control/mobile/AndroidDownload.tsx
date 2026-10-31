import { useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { HarkIcon } from "@/components/hark/HarkPrimitives";

/** Missing development artifacts must never become a misleading download link. */
export function AndroidDownload() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void fetch("/downloads/android.json", { cache: "no-store", signal: abort.signal })
      .then(async response => response.ok ? response.json() : null)
      .then(value => {
        if (value?.file === "Vivic-Remote.apk" && /^\d+\.\d+\.\d+$/.test(value.version) && /^[a-f0-9]{64}$/.test(value.sha256) && value.bytes > 0) setVersion(value.version);
      }).catch(() => {});
    return () => abort.abort();
  }, []);
  return version ? <a className={buttonVariants({ size: "sm", variant: "ghost" })} data-vivic-button="ghost" data-vivic-button-size="sm"
      href="/downloads/Vivic-Remote.apk" download={`Vivic-Remote-${version}.apk`} title={`Android ${version}`} data-vivic-android-download>
      <HarkIcon name="download" />下载安卓 App
    </a> : null;
}

import { createRoot } from "react-dom/client";
import { LocalSpeechSettings } from "../../../control/LocalSpeechSettings";
import { LocalWakeInput } from "../../../control/LocalWakeInput";
import "../../../index.css";

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-xl space-y-5 p-6">
    <LocalSpeechSettings />
    <LocalWakeInput ownerKey="isolated-ui" recognition="local" onTranscript={() => {}} />
  </main>,
);

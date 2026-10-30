import { createRoot } from "react-dom/client";
import { HostedBootstrap } from "@/hostedMobile/HostedBootstrap";

// Only the immutable service bootstrap ships in the APK. The confirmed service
// provides /remote/ and its authenticated server Space UI.
createRoot(document.getElementById("root")!).render(<HostedBootstrap />);

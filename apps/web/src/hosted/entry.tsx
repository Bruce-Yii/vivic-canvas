import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { HostedWorkspace } from "./HostedWorkspace";

// The online graph starts here instead of App's local route declarations.
// Shared renderer dependencies are checked separately in the production build.
createRoot(document.getElementById("root")!).render(<StrictMode><HostedWorkspace /></StrictMode>);

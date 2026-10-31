import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { OwnerApp } from "./OwnerApp";
import { HostedWorkspace } from "./HostedWorkspace";
const remote = /^\/remote(?:\/|$)/.test(window.location.pathname);
createRoot(document.getElementById("root")!).render(<StrictMode>{remote ? <HostedWorkspace /> : <OwnerApp />}</StrictMode>);

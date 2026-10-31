import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import "@/cards/scene/sceneCards.css";
import "@/control/userCardLayer.css";
import "./landing.css";
import { LandingPage } from "./LandingPage";

createRoot(document.getElementById("landing-root")!).render(
  <StrictMode>
    <LandingPage />
  </StrictMode>,
);

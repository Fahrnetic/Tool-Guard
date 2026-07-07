import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { initializeProductAnalytics } from "./lib/analytics.js";
import { initializeUiErrorTracking } from "./lib/error-tracking.js";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("ToolGuard UI root element was not found.");
}

initializeUiErrorTracking();
initializeProductAnalytics();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);

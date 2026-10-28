import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { applyTheme } from "./store";

applyTheme("system", "comfortable"); // before first paint; real settings re-apply once loaded
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

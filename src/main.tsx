import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/global.css";

const path = window.location.pathname;
document.documentElement.dataset.surface = path.startsWith("/overlay") ? "overlay" : "admin";

const root = document.getElementById("root");
if (root === null) throw new Error("App root is missing");
const reactRoot = createRoot(root);

if (path.startsWith("/overlay")) {
  void import("./overlay/OverlayApp").then(({ OverlayApp }) => {
    reactRoot.render(<StrictMode><OverlayApp /></StrictMode>);
  });
} else {
  void import("./admin/AdminApp").then(({ AdminApp, LoginApp }) => {
    const App = path.startsWith("/login") ? LoginApp : AdminApp;
    reactRoot.render(<StrictMode><App /></StrictMode>);
  });
}

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { resolveRoute } from "./routing";
import "./styles/global.css";

const path = window.location.pathname;
const route = resolveRoute(path);
document.documentElement.dataset.surface = route.surface;

const root = document.getElementById("root");
if (root === null) throw new Error("App root is missing");
const reactRoot = createRoot(root);

if (route.app === "overlay") {
  void import("./overlay/OverlayApp").then(({ OverlayApp }) => {
    reactRoot.render(<StrictMode><OverlayApp /></StrictMode>);
  });
} else if (route.app === "challenges") {
  void import("./challenges/ChallengeSourceApp").then(({ ChallengeSourceApp }) => {
    reactRoot.render(<StrictMode><ChallengeSourceApp /></StrictMode>);
  });
} else if (route.app === "live") {
  void import("./live/LiveApp").then(({ LiveApp }) => {
    reactRoot.render(<StrictMode><LiveApp /></StrictMode>);
  });
} else {
  void import("./admin/AdminApp").then(({ AdminApp, LoginApp }) => {
    const App = route.app === "login" ? LoginApp : AdminApp;
    reactRoot.render(<StrictMode><App /></StrictMode>);
  });
}

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { resolveRoute } from "./routing";
import "./styles/global.css";

const path = window.location.pathname;
const route = resolveRoute(path);
document.documentElement.dataset.surface = route.surface;

if (path === "/admin/composition" || path === "/admin/composition/" || path === "/admin/challenges" || path === "/admin/challenges/") {
  window.history.replaceState(window.history.state, "", `/admin${window.location.search}${window.location.hash}`);
}

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
} else if (route.app === "composite") {
  void import("./composite/CompositeApp").then(({ CompositeApp }) => {
    reactRoot.render(<StrictMode><CompositeApp /></StrictMode>);
  });
} else if (route.app === "live") {
  void import("./live/LiveApp").then(({ LiveApp }) => {
    reactRoot.render(<StrictMode><LiveApp /></StrictMode>);
  });
} else {
  void import("./admin/AdminApp").then(({ AdminApp, LoginApp }) => {
    if (route.app === "login") {
      reactRoot.render(<StrictMode><LoginApp /></StrictMode>);
    } else {
      reactRoot.render(<StrictMode><AdminApp workspace={route.workspace} /></StrictMode>);
    }
  });
}

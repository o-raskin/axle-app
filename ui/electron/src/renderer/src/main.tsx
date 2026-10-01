import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./styles.css";

// Keep keyboard focus visible without retaining a ring after mouse/touch dialogs.
document.documentElement.dataset.inputMethod = "pointer";
document.addEventListener("pointerdown", () => { document.documentElement.dataset.inputMethod = "pointer"; }, true);
document.addEventListener("keydown", (event) => {
  if (!event.metaKey && !event.ctrlKey && !event.altKey) document.documentElement.dataset.inputMethod = "keyboard";
}, true);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

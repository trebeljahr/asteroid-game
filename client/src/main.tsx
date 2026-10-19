import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./sketch";
import { App } from "./App";
import { recordDonationSupport } from "./donation";
import { startErrorReporting } from "./errorReporting/start";

// Before p5 runs `setup` on load, so an error there is held and reported.
void startErrorReporting();
recordDonationSupport();

const container = document.getElementById("menu");
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./sketch";
import { App } from "./App";
import { recordDonationSupport } from "./donation";

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

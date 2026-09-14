import { createRoot } from "react-dom/client";
import { MentraProvider } from "@mentra/miniapp/ui";
import "../shared/channels";
import App from "./App";
import "./styles.css";
import "./browser.css";

import { installBrowserBridge } from "./browser";
const browserPreview = installBrowserBridge();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(
  browserPreview ? (
    <App browserMode />
  ) : (
    <MentraProvider>
      <App />
    </MentraProvider>
  ),
);
mentra.ready();

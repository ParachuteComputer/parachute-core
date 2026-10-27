import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// Single-mount basename detection. As of hub#231 the admin SPA mounts at
// /admin/* exclusively — the prior /vault and /hub mounts are 301-redirected
// in `hub-server.ts` so any cached operator URL keeps working. react-router
// needs the *runtime* basename so <Link to="/vaults"> resolves to
// /admin/vaults; without this it would try to navigate to /vaults at the
// origin root and 404.
function detectBasename(): string {
  const path = window.location.pathname;
  if (path === "/admin" || path.startsWith("/admin/")) return "/admin";
  // Stand-alone dev served at origin root (VITE_BASE_PATH=/).
  return "";
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename={detectBasename()}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

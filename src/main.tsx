import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./style.css";

const Owner = React.lazy(() => import('./Owner'));
const Page = new URLSearchParams(location.search).get('gestion') === '1' ? Owner : App;

if ("serviceWorker" in navigator)
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <React.Suspense fallback={<p>Chargement…</p>}><Page /></React.Suspense>
  </React.StrictMode>,
);

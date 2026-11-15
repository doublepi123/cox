import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ConnectionStore } from "./connections/store";
import "./styles.css";

class MissingRootError extends Error {}

const root = document.getElementById("root");
if (!root) throw new MissingRootError("Cox Mobile root element is missing.");

const store = new ConnectionStore({ storage: localStorage });
createRoot(root).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);

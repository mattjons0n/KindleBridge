import "./styles.css";
import "./library-modern.css";
import "./library-health.css";
import "./library-transfer-modern.css";
import "./library-ux-polish.css";
import { AppController } from "./controller";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing #app root element");

new AppController(root);

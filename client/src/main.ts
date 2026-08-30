import "./styles.css";
import { AppController } from "./controller";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing #app root element");

new AppController(root);

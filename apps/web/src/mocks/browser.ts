import { setupWorker } from "msw/browser";
import { handlers } from "./handlers.js";

export const worker = setupWorker(...handlers);
export { setMockRole, setFailingOps, setEmptyOps } from "./handlers.js";

import { setupWorker } from "msw/browser";
import { handlers } from "./handlers.js";

export const worker = setupWorker(...handlers);
export { setMockRole, setFailingOps } from "./handlers.js";

/**
 * Mode-agnostic browser-driving surface used by the QA agent's MCP tools.
 *
 * Two implementations exist:
 *  - `SidecarBrowserOps` (in `playwright-mcp.service.ts`): drives the headed
 *    Chromium running in our Docker QA browser image, via Playwright over CDP.
 *  - `UserBrowserOps` (in `user-browser.service.ts`): forwards each call to the
 *    user's locally-installed Chrome extension over a WebSocket. The extension
 *    runs the actual command via `chrome.debugger` against the active tab.
 *
 * Methods return plain data so tool handlers can format identical MCP
 * responses for both modes — the agent doesn't know (or care) which is in use.
 */

export type WaitUntil = "load" | "domcontentloaded" | "networkidle";
export type WaitState = "attached" | "detached" | "visible" | "hidden";

export interface BrowserOps {
  navigate(args: { url: string; waitUntil?: WaitUntil }): Promise<{
    url: string;
    title: string;
  }>;
  click(args: { selector: string; timeoutMs?: number }): Promise<{
    url: string;
  }>;
  fill(args: {
    selector: string;
    value: string;
    timeoutMs?: number;
  }): Promise<void>;
  press(args: { selector: string; key: string }): Promise<void>;
  waitFor(args: {
    selector: string;
    state?: WaitState;
    timeoutMs?: number;
  }): Promise<void>;
  snapshot(): Promise<{ url: string; title: string; ariaTreeYaml: string }>;
  screenshot(args: { fullPage?: boolean }): Promise<{ pngBase64: string }>;
  evaluate(args: { expression: string }): Promise<unknown>;
  currentState(): Promise<{ url: string; title: string }>;
  goBack(): Promise<{ url: string }>;
  reload(): Promise<{ url: string }>;
  textContent(args: { selector: string }): Promise<string | null>;
}

/**
 * Single page-side driver function.
 *
 * Critical: `chrome.scripting.executeScript({ func })` ships only the
 * function's `toString()` to the target tab — closures and module-scope
 * helpers are NOT available there. So this whole file collapses into ONE
 * function with every helper defined inside it, and the background dispatches
 * by op name through a single executeScript call.
 *
 * Selector format mirrors a tiny subset of Playwright's selector engine:
 *   - `text=Some text` → element whose visible text contains that string
 *   - `role=button[name="Save"]` → element by ARIA role + accessible name
 *   - everything else falls through to `document.querySelector(sel)`
 */

export type DriverOp =
  | "click"
  | "fill"
  | "press"
  | "wait_for"
  | "snapshot"
  | "evaluate"
  | "current_state"
  | "text_content";

/**
 * MUST be self-contained — every reference inside this function must resolve
 * either to (a) the function's own arguments, (b) symbols defined inside this
 * function, or (c) globals available in the target page (window, document,
 * Element, etc.). Do NOT pull in imports or call helpers from outside.
 */
export async function pageDriver(
  op: DriverOp,
  params: Record<string, unknown>
): Promise<unknown> {
  // ── helpers (all local — see file header) ──────────────────────────────
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const errMsg = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

  const isVisible = (el: Element): boolean => {
    if (!(el instanceof HTMLElement)) return true;
    if (el.hidden) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const implicitRole = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case "a":
        return (el as HTMLAnchorElement).hasAttribute("href") ? "link" : "";
      case "button":
        return "button";
      case "input": {
        const t = (el as HTMLInputElement).type.toLowerCase();
        if (t === "button" || t === "submit" || t === "reset") return "button";
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        return "textbox";
      }
      case "textarea":
        return "textbox";
      case "select":
        return "combobox";
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return "heading";
      default:
        return "";
    }
  };

  const accessibleName = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) return ref.textContent?.trim() ?? "";
    }
    if (el instanceof HTMLInputElement && el.labels && el.labels.length > 0) {
      return el.labels[0].textContent?.trim() ?? "";
    }
    return el.textContent?.trim() ?? "";
  };

  const findByText = (needle: string): Element | null => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT
    );
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = node.textContent?.trim().toLowerCase() ?? "";
      if (t.includes(needle)) {
        const el = node.parentElement;
        if (el && isVisible(el)) return el;
      }
    }
    return null;
  };

  const findByRole = (role: string, name: string): Element | null => {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        "[role], button, a, input, textarea, select, label, h1, h2, h3, h4, h5, h6"
      )
    );
    for (const el of candidates) {
      const elRole = (
        el.getAttribute("role") || implicitRole(el)
      ).toLowerCase();
      if (elRole !== role) continue;
      if (!name) return el;
      const accName = accessibleName(el).toLowerCase();
      if (accName.includes(name)) return el;
    }
    return null;
  };

  const resolveSelector = (selector: string): Element | null => {
    const trimmed = selector.trim();
    const textMatch = /^text=(.+)$/i.exec(trimmed);
    if (textMatch) {
      const needle = textMatch[1].trim().toLowerCase();
      return findByText(needle);
    }
    const roleMatch =
      /^role=([\w-]+)(?:\[name=(?:"([^"]+)"|'([^']+)')])?$/i.exec(trimmed);
    if (roleMatch) {
      const role = roleMatch[1].toLowerCase();
      const name = (roleMatch[2] ?? roleMatch[3] ?? "").toLowerCase();
      return findByRole(role, name);
    }
    try {
      return document.querySelector(trimmed);
    } catch {
      return null;
    }
  };

  const resolveOrWait = async (
    selector: string,
    timeoutMs: number
  ): Promise<Element | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = resolveSelector(selector);
      if (el && isVisible(el)) return el;
      await sleep(60);
    }
    return resolveSelector(selector);
  };

  const parseKey = (
    input: string
  ): { key: string; code: string; which: number } => {
    const last = input.split("+").pop() ?? input;
    const map: Record<string, { code: string; which: number }> = {
      Enter: { code: "Enter", which: 13 },
      Escape: { code: "Escape", which: 27 },
      Tab: { code: "Tab", which: 9 },
      Backspace: { code: "Backspace", which: 8 },
      Delete: { code: "Delete", which: 46 },
      ArrowUp: { code: "ArrowUp", which: 38 },
      ArrowDown: { code: "ArrowDown", which: 40 },
      ArrowLeft: { code: "ArrowLeft", which: 37 },
      ArrowRight: { code: "ArrowRight", which: 39 },
      Space: { code: "Space", which: 32 },
    };
    const known = map[last];
    if (known) return { key: last, ...known };
    return {
      key: last,
      code: last.length === 1 ? `Key${last.toUpperCase()}` : last,
      which: last.length === 1 ? last.toUpperCase().charCodeAt(0) : 0,
    };
  };

  const ariaTreeYaml = (
    node: Node,
    depth: number,
    lines: string[]
  ): string[] => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (t) lines.push(`${"  ".repeat(depth)}- text: ${JSON.stringify(t)}`);
      return lines;
    }
    if (!(node instanceof Element)) return lines;
    const tag = node.tagName.toLowerCase();
    if (
      tag === "script" ||
      tag === "style" ||
      tag === "noscript" ||
      tag === "template"
    ) {
      return lines;
    }
    if (!isVisible(node)) return lines;

    const role = (
      node.getAttribute("role") || implicitRole(node)
    ).toLowerCase();
    const name = accessibleName(node).slice(0, 200);
    const summary = role
      ? `${role}${name ? ` ${JSON.stringify(name)}` : ""}`
      : tag;
    lines.push(`${"  ".repeat(depth)}- ${summary}`);
    if (depth > 30) {
      lines.push(`${"  ".repeat(depth + 1)}- (truncated)`);
      return lines;
    }
    for (const child of Array.from(node.childNodes)) {
      ariaTreeYaml(child, depth + 1, lines);
    }
    return lines;
  };

  // ── op dispatch ────────────────────────────────────────────────────────
  try {
    switch (op) {
      case "click": {
        const args = params as { selector: string; timeoutMs?: number };
        const el = await resolveOrWait(args.selector, args.timeoutMs ?? 5000);
        if (!el) {
          return { __error__: `Click target not found: ${args.selector}` };
        }
        if (!isVisible(el)) {
          return {
            __error__: `Click target is not visible: ${args.selector}`,
          };
        }
        el.scrollIntoView({
          block: "center",
          inline: "center",
          behavior: "auto",
        });
        if (el instanceof HTMLElement) {
          el.click();
        } else {
          el.dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: window,
            })
          );
        }
        return { url: location.href };
      }

      case "fill": {
        const args = params as {
          selector: string;
          value: string;
          timeoutMs?: number;
        };
        const el = (await resolveOrWait(
          args.selector,
          args.timeoutMs ?? 5000
        )) as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
        if (!el) {
          return { __error__: `Fill target not found: ${args.selector}` };
        }
        el.scrollIntoView({
          block: "center",
          inline: "center",
          behavior: "auto",
        });
        if ("focus" in el && typeof el.focus === "function") el.focus();
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement
        ) {
          const proto = Object.getPrototypeOf(el) as object;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, args.value);
          else el.value = args.value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else if ((el as HTMLElement).isContentEditable) {
          (el as HTMLElement).innerText = args.value;
          el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        } else {
          return {
            __error__: `Fill target is not an input/textarea/contenteditable: ${args.selector}`,
          };
        }
        return { ok: true };
      }

      case "press": {
        const args = params as { selector: string; key: string };
        const el = (await resolveOrWait(args.selector, 5000)) as
          | HTMLElement
          | null;
        if (!el) {
          return { __error__: `Press target not found: ${args.selector}` };
        }
        if (typeof el.focus === "function") el.focus();
        const { key, code } = parseKey(args.key);
        const opts: KeyboardEventInit = {
          key,
          code,
          bubbles: true,
          cancelable: true,
        };
        el.dispatchEvent(new KeyboardEvent("keydown", opts));
        el.dispatchEvent(new KeyboardEvent("keypress", opts));
        el.dispatchEvent(new KeyboardEvent("keyup", opts));
        return { ok: true };
      }

      case "wait_for": {
        const args = params as {
          selector: string;
          state?: "attached" | "detached" | "visible" | "hidden";
          timeoutMs?: number;
        };
        const state = args.state ?? "visible";
        const timeoutMs = args.timeoutMs ?? 10_000;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const el = resolveSelector(args.selector);
          const ok =
            state === "attached"
              ? !!el
              : state === "detached"
                ? !el
                : state === "visible"
                  ? !!el && isVisible(el)
                  : state === "hidden"
                    ? !el || !isVisible(el)
                    : false;
          if (ok) return { ok: true };
          await sleep(80);
        }
        return {
          __error__: `Timed out waiting for ${args.selector} to be ${state} (${timeoutMs}ms)`,
        };
      }

      case "snapshot": {
        const yaml = ariaTreeYaml(document.body, 0, []).join("\n");
        return {
          url: location.href,
          title: document.title,
          ariaTreeYaml: yaml,
        };
      }

      case "evaluate": {
        const args = params as { expression: string };
        // We're in MAIN world here so the page's own globals/Function are
        // available. Wrap so the agent can pass either an expression
        // ("document.title") or a small statement block ("return foo()").
        const fn = new Function(
          `return (async () => { return (${args.expression}); })();`
        );
        const result = await fn();
        return JSON.parse(JSON.stringify(result ?? null));
      }

      case "current_state": {
        return { url: location.href, title: document.title };
      }

      case "text_content": {
        const args = params as { selector: string };
        const el = await resolveOrWait(args.selector, 5000);
        if (!el) return { value: null };
        return { value: el.textContent };
      }

      default:
        return { __error__: `Unknown op: ${String(op)}` };
    }
  } catch (err) {
    return { __error__: errMsg(err) };
  }
}

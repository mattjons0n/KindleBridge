// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(new NodeURL("../../client/src/library-modern.css", import.meta.url), "utf8");

describe("ShelfSend charcoal presentation", () => {
  it("parses the theme with neutral light/dark surfaces and non-clipping grid cards", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const rules = [...style.sheet!.cssRules] as CSSStyleRule[];
    const compact = (value: string) => value.replace(/\s/g, "");
    const rule = (selector: string) => rules.find((entry) => entry.selectorText && compact(entry.selectorText) === compact(selector))!.style;
    expect(compact(rule(":root").getPropertyValue("--modern-canvas"))).toBe("light-dark(#f8f8f8,#121212)");
    expect(compact(rule(":root").getPropertyValue("--surface"))).toBe("light-dark(#ffffff,#1e1e1e)");
    expect(rule(".library-book-card:not(.library-book-row)").getPropertyValue("border-radius")).toBe("14px");
    expect(rule(".library-book-card:not(.library-book-row)").getPropertyValue("overflow")).not.toBe("hidden");
    expect(rule(".library-send-button:disabled").getPropertyValue("background")).toBe("var(--surface-soft)");
    expect(rule(".library-kindle-check.possible, .library-kindle-check.unknown").getPropertyValue("background")).toBe("var(--yellow-soft)");
    expect(rule(".library-book-menu > div").getPropertyValue("max-width")).toBe("100%");
    expect(rule(".library-bulk-actions").getPropertyValue("flex-wrap")).toBe("wrap");
    expect(rule(".library-app-shell button.primary:hover:not(:disabled)").getPropertyValue("background")).toBe("var(--modern-button-hover)");
    style.remove();
  });

  it("keeps white primary-button text above normal-text contrast requirements", () => {
    const hex = css.match(/--modern-button: (#[0-9a-f]{6});/)![1];
    const channels = hex.slice(1).match(/../g)!.map((part) => {
      const value = parseInt(part, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
    expect(css).toContain("--modern-button-text: #ffffff;");
  });
});

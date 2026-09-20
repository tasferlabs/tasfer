import {
  isSafeLinkUrl,
  normalizeLinkUrl,
  openLinkUrl,
  safeLinkHref,
} from "./url-safety";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("normalizeLinkUrl", () => {
  it("accepts the allowed schemes", () => {
    expect(normalizeLinkUrl("https://example.com/a?b=1#c")).toBe(
      "https://example.com/a?b=1#c",
    );
    expect(normalizeLinkUrl("http://example.com/")).toBe("http://example.com/");
    expect(normalizeLinkUrl("mailto:hi@example.com")).toBe(
      "mailto:hi@example.com",
    );
    expect(normalizeLinkUrl("tel:+123456789")).toBe("tel:+123456789");
  });

  it("assumes https for bare hosts and protocol-relative urls", () => {
    expect(normalizeLinkUrl("example.com/docs")).toBe(
      "https://example.com/docs",
    );
    expect(normalizeLinkUrl("www.example.com")).toBe(
      "https://www.example.com/",
    );
    expect(normalizeLinkUrl("//example.com/x")).toBe("https://example.com/x");
  });

  it("refuses relative references rather than inventing a host for them", () => {
    expect(normalizeLinkUrl("/docs/setup")).toBeNull();
    expect(normalizeLinkUrl("./setup.md")).toBeNull();
    expect(normalizeLinkUrl("../setup.md")).toBeNull();
    expect(normalizeLinkUrl("#intro")).toBeNull();
    expect(normalizeLinkUrl("?q=1")).toBeNull();
  });

  it("refuses schemes that execute in the app's origin", () => {
    expect(normalizeLinkUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeLinkUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(
      normalizeLinkUrl("data:text/html,<script>alert(1)</script>"),
    ).toBeNull();
    expect(normalizeLinkUrl("blob:https://example.com/abc")).toBeNull();
    expect(normalizeLinkUrl("vbscript:msgbox(1)")).toBeNull();
    expect(normalizeLinkUrl("file:///etc/passwd")).toBeNull();
  });

  it("refuses custom schemes that would reach another app", () => {
    expect(
      normalizeLinkUrl("intent://scan/#Intent;scheme=zxing;end"),
    ).toBeNull();
    expect(normalizeLinkUrl("market://details?id=com.example")).toBeNull();
    expect(normalizeLinkUrl("itms-apps://apps.apple.com/app/id1")).toBeNull();
  });

  it("sees through whitespace and control characters hiding a scheme", () => {
    // Browsers strip these before parsing, so the allowlist must too.
    expect(normalizeLinkUrl("  javascript:alert(1)")).toBeNull();
    expect(normalizeLinkUrl("java\nscript:alert(1)")).toBeNull();
    expect(normalizeLinkUrl("java\tscript:alert(1)")).toBeNull();
    expect(normalizeLinkUrl("java\u0001script:alert(1)")).toBeNull();
    expect(normalizeLinkUrl("\u0000javascript:alert(1)")).toBeNull();
  });

  it("rejects input that is not a usable url", () => {
    expect(normalizeLinkUrl("")).toBeNull();
    expect(normalizeLinkUrl("   ")).toBeNull();
    expect(normalizeLinkUrl(undefined)).toBeNull();
    expect(normalizeLinkUrl(null)).toBeNull();
    expect(normalizeLinkUrl(42)).toBeNull();
    expect(normalizeLinkUrl({ url: "https://example.com" })).toBeNull();
  });

  it("agrees with isSafeLinkUrl", () => {
    expect(isSafeLinkUrl("https://example.com")).toBe(true);
    expect(isSafeLinkUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("safeLinkHref", () => {
  it("keeps relative references as the document wrote them", () => {
    expect(safeLinkHref("/docs/setup")).toBe("/docs/setup");
    expect(safeLinkHref("./setup.md")).toBe("./setup.md");
    expect(safeLinkHref("../setup.md")).toBe("../setup.md");
    expect(safeLinkHref("#intro")).toBe("#intro");
    expect(safeLinkHref("?q=1")).toBe("?q=1");
  });

  it("applies the same allowlist as normalizeLinkUrl to absolute urls", () => {
    expect(safeLinkHref("https://example.com/a")).toBe("https://example.com/a");
    expect(safeLinkHref("example.com")).toBe("https://example.com/");
    expect(safeLinkHref("//example.com/x")).toBe("https://example.com/x");
    expect(safeLinkHref("mailto:hi@example.com")).toBe("mailto:hi@example.com");
    expect(safeLinkHref("javascript:alert(1)")).toBeNull();
    expect(safeLinkHref("java\nscript:alert(1)")).toBeNull();
    expect(safeLinkHref("")).toBeNull();
    expect(safeLinkHref(null)).toBeNull();
  });
});

describe("openLinkUrl", () => {
  /**
   * Tests run without a DOM, so stand in a document that records the anchor it
   * is handed. That anchor *is* the contract: which attributes it carries, and
   * that it is connected to the document at the moment it is clicked.
   */
  function captureAnchor() {
    const anchor = {
      href: "",
      target: "",
      rel: "",
      style: {} as Record<string, string>,
      clicks: 0,
      connected: false,
      connectedAtClick: false,
      click() {
        this.connectedAtClick = this.connected;
        this.clicks += 1;
      },
      remove() {
        this.connected = false;
      },
    };
    vi.stubGlobal("document", {
      createElement: () => anchor,
      body: {
        appendChild: () => {
          anchor.connected = true;
        },
      },
    });
    return anchor;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clicks a connected, severed anchor instead of opening a popup", () => {
    const anchor = captureAnchor();
    const open = vi.fn();
    vi.stubGlobal("window", { open });

    expect(openLinkUrl("example.com/a")).toBe(true);
    expect(anchor.href).toBe("https://example.com/a");
    expect(anchor.target).toBe("_blank");
    expect(anchor.rel).toBe("noopener noreferrer");
    expect(anchor.clicks).toBe(1);
    // A detached anchor is not guaranteed to navigate, and a leftover one would
    // pile up in the host's DOM.
    expect(anchor.connectedAtClick).toBe(true);
    expect(anchor.connected).toBe(false);
    // The feature-string spelling asks for a popup window rather than a tab,
    // and a popup is refusable in a way a tab is not.
    expect(open).not.toHaveBeenCalled();
  });

  it("hands mailto: and tel: off in place rather than to a new tab", () => {
    for (const url of ["mailto:hi@example.com", "tel:+15551234"]) {
      const anchor = captureAnchor();
      expect(openLinkUrl(url)).toBe(true);
      expect(anchor.href).toBe(url);
      // A target here would strand an empty tab behind the app handoff.
      expect(anchor.target).toBe("");
      expect(anchor.rel).toBe("");
      expect(anchor.clicks).toBe(1);
      vi.unstubAllGlobals();
    }
  });

  it("opens nothing for a scheme outside the allowlist", () => {
    const anchor = captureAnchor();
    expect(openLinkUrl("javascript:alert(1)")).toBe(false);
    expect(openLinkUrl("java\nscript:alert(1)")).toBe(false);
    expect(openLinkUrl("/docs/setup")).toBe(false);
    expect(openLinkUrl(null)).toBe(false);
    expect(anchor.clicks).toBe(0);
  });
});

import { isSafeLinkUrl, normalizeLinkUrl, safeLinkHref } from "./url-safety";
import { describe, expect, it } from "vitest";

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

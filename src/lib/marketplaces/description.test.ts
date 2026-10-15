import { describe, expect, it } from "vitest";
import { isListingUrlFor, parseCraigslistDescription, parseFacebookDescription, parseKijijiDescription } from "./description";

describe("listing page descriptions", () => {
  it("reads a Craigslist posting body without its print-only QR block", () => {
    const html = `<html><body><section id="postingbody">
        <div class="print-information print-qrcode-container"><p class="print-qrcode-label">QR Code Link to This Post</p></div>
Full-size gaming desktop PC in good working condition.<br>
<br>
Intel Core i7-2600 @ 3.40GHz<br>
NVIDIA GeForce GTX 555 &amp; 16GB DDR3 RAM<br>
    </section><div class="postinginfos">post id: 1</div></body></html>`;
    expect(parseCraigslistDescription(html)).toBe(
      "Full-size gaming desktop PC in good working condition.\n\nIntel Core i7-2600 @ 3.40GHz\nNVIDIA GeForce GTX 555 & 16GB DDR3 RAM",
    );
    expect(parseCraigslistDescription("<html><body>This posting has been deleted.</body></html>")).toBeNull();
  });

  it("reads the Product description from a Kijiji page's JSON-LD", () => {
    const product = { "@context": "https://schema.org", "@type": "Product", name: "CUSTOM GAMING PC", description: "Processor (CPU): Intel Core i7-6850K\n\nMemory (RAM): 32GB DDR4" };
    const crumbs = { "@type": "BreadcrumbList", itemListElement: [] };
    const html = `<script type="application/ld+json">${JSON.stringify(crumbs)}</script><script type="application/ld+json">${JSON.stringify(product)}</script>`;
    expect(parseKijijiDescription(html)).toBe("Processor (CPU): Intel Core i7-6850K\n\nMemory (RAM): 32GB DDR4");
    expect(parseKijijiDescription(`<script type="application/ld+json">{broken</script>`)).toBeNull();
  });

  it("reads a Facebook item's redacted_description, escapes included", () => {
    const html = `..."marketplace_listing_title":"Acer Nitro N50-610","redacted_description":{"text":"Core i5 2.9 GHz 10gen \\n8GB DDR4 \\nNvidia GeForce GTX1650 \\u2014 \\"clean\\""},"creation_time":1...`;
    expect(parseFacebookDescription(html)).toBe('Core i5 2.9 GHz 10gen\n8GB DDR4\nNvidia GeForce GTX1650 — "clean"');
    expect(parseFacebookDescription("<html>no listing</html>")).toBeNull();
  });

  it("only fetches listing pages on the marketplace's own site", () => {
    expect(isListingUrlFor("craigslist", "https://www.craigslist.org/view/d/richmond-west-gaming/pnKHy")).toBe(true);
    expect(isListingUrlFor("craigslist", "https://vancouver.craigslist.org/vgm/d/x/1.html")).toBe(true);
    expect(isListingUrlFor("craigslist", "https://craigslist.org.evil.example/x")).toBe(false);
    expect(isListingUrlFor("kijiji", "https://www.kijiji.ca/v-desktop-computers/x/1743569228")).toBe(true);
    expect(isListingUrlFor("kijiji", "http://www.kijiji.ca/v-x/1")).toBe(false);
    expect(isListingUrlFor("facebook", "https://www.facebook.com/marketplace/item/1769731004073358/")).toBe(true);
    expect(isListingUrlFor("facebook", "https://www.facebook.com/settings/")).toBe(false);
    expect(isListingUrlFor("facebook", "not a url")).toBe(false);
  });
});

/**
 * Links to eBay's own sold-listings search, opened in the user's browser. FlipWatch can't fetch these pages
 * itself: eBay blocks automated clients (403 or a "Security Measure" challenge for plain requests, headless
 * and driven browsers alike — checked Sep 2026), and real sold data through the API needs eBay's
 * restricted Marketplace Insights access.
 */
export function ebaySoldSearchUrl(query: string, currency: string): string {
  const host = currency.toUpperCase() === "CAD" ? "www.ebay.ca" : "www.ebay.com";
  const params = new URLSearchParams({ _nkw: query.trim().replace(/\s+/g, " "), LH_Sold: "1", LH_Complete: "1" });
  return `https://${host}/sch/i.html?${params.toString()}`;
}

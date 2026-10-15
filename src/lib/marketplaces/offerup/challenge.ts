/**
 * Markers of the bot-protection interstitials OfferUp (and CDNs in front of it) serve instead of content.
 * Only consulted when a response carries no app data, so a listing titled "press & hold" can't trip it.
 */
const CHALLENGE_MARKERS: RegExp[] = [
  /px-captcha|_pxAppId|window\._pxVid/i, // PerimeterX / HUMAN "Press & Hold"
  /Press\s*(?:&amp;|&)\s*Hold/i,
  /captcha-delivery\.com/i, // DataDome
  /Access to this page has been denied/i,
  /_cf_chl_opt|cf-chl-widget|<title>\s*Just a moment\.\.\.\s*<\/title>/i, // Cloudflare managed challenge
  /Pardon Our Interruption/i, // Imperva / Distil
  /Incapsula incident ID/i,
];

export function looksLikeBotChallenge(body: string): boolean {
  return CHALLENGE_MARKERS.some((marker) => marker.test(body));
}

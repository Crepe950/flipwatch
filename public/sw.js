/* FlipWatch service worker — browser push notifications only (no offline caching). */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function readPayload(event) {
  if (!event.data) return {};
  try {
    const data = event.data.json();
    return data && typeof data === "object" ? data : {};
  } catch {
    return { body: event.data.text() };
  }
}

/** Resolve a payload URL against our origin; only http(s) targets are allowed. */
function resolveUrl(value) {
  try {
    const url = new URL(typeof value === "string" && value ? value : "/", self.location.origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : self.location.origin + "/";
  } catch {
    return self.location.origin + "/";
  }
}

const str = (value) => (typeof value === "string" && value ? value : undefined);

self.addEventListener("push", (event) => {
  const data = readPayload(event);
  const tag = str(data.tag);
  const options = {
    body: str(data.body) || "",
    icon: str(data.icon) || "/icons/icon-192.png",
    // Android shows the badge as a monochrome silhouette (alpha channel only) in the status bar.
    badge: "/icons/badge-96.png",
    image: str(data.image),
    data: { url: resolveUrl(data.url) },
    timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
  };
  // renotify without a tag throws, so only combine them.
  if (tag) {
    options.tag = tag;
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(str(data.title) || "FlipWatch", options));
});

async function openOrFocus(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const exact = windows.find((client) => client.url === url);
  if (exact) return exact.focus();

  if (new URL(url).origin === self.location.origin) {
    // navigate() only works on tabs this worker controls. Focus first: browsers only allow
    // focusing while the click is being handled.
    const controlled = await self.clients.matchAll({ type: "window" });
    const tab = controlled[0];
    if (tab) {
      try {
        const focused = await tab.focus();
        await focused.navigate(url);
        return focused;
      } catch {
        // Tab closed or refused navigation — open a new window instead.
      }
    }
  }
  return self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = resolveUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(openOrFocus(url));
});

async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
}

/** The push service rotated or expired our subscription: re-subscribe and tell the server (best effort). */
async function resubscribe(event) {
  const oldSub = event.oldSubscription || null;
  let newSub = event.newSubscription || null;
  if (!newSub) {
    const key = oldSub && oldSub.options ? oldSub.options.applicationServerKey : null;
    if (!key) return;
    newSub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }
  await postJson("/api/push/subscribe", { subscription: newSub.toJSON() });
  if (oldSub && oldSub.endpoint !== newSub.endpoint) {
    await postJson("/api/push/unsubscribe", { endpoint: oldSub.endpoint });
  }
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    resubscribe(event).catch((err) => {
      console.warn("[FlipWatch] push resubscribe failed", err);
    }),
  );
});

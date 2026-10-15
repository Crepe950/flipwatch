/**
 * Browser-side push subscription state, shared by every <EnablePushButton> through
 * useSyncExternalStore (no setState-in-effect, no hydration mismatch).
 */

export type PushStatus =
  /** Server render / still checking the existing subscription. */
  | "loading"
  | "unsupported"
  /** iOS/iPadOS Safari: push only works in the installed Home Screen app. */
  | "ios-install"
  | "blocked"
  | "off"
  | "on";

export interface PushState {
  status: PushStatus;
  busy: boolean;
  error: string | null;
}

const SERVER_STATE: PushState = { status: "loading", busy: false, error: null };
let state: PushState | null = null;
let checkStarted = false;
const listeners = new Set<() => void>();

function update(patch: Partial<PushState>): void {
  state = { ...getSnapshot(), ...patch };
  listeners.forEach((listener) => listener());
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch support gives it away.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

function detectStatus(): PushStatus {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!supported) return isIos() && !isStandalone() ? "ios-install" : "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return "loading";
}

export function getSnapshot(): PushState {
  if (!state) state = { status: detectStatus(), busy: false, error: null };
  return state;
}

export function getServerSnapshot(): PushState {
  return SERVER_STATE;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!checkStarted) {
    checkStarted = true;
    void refreshStatus();
  }
  return () => {
    listeners.delete(listener);
  };
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration ? registration.pushManager.getSubscription() : null;
}

async function refreshStatus(): Promise<void> {
  if (getSnapshot().status !== "loading") return;
  try {
    update({ status: (await currentSubscription()) ? "on" : "off" });
  } catch {
    update({ status: "off" });
  }
}

/** VAPID public key (base64url) → bytes for PushManager.subscribe(). */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob((base64Url + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(current: ArrayBuffer | null | undefined, expected: Uint8Array): boolean {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === expected.length && bytes.every((b, i) => b === expected[i]);
}

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return;
  const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
  throw new Error(typeof data?.error === "string" ? data.error : `Server returned ${res.status}`);
}

function describe(err: unknown): string {
  if (err instanceof DOMException && err.name === "NotAllowedError") return "The browser refused the push subscription.";
  return err instanceof Error && err.message ? err.message : "Something went wrong.";
}

/** Must be called from a click handler: Safari only prompts for permission inside a user gesture. */
export async function enablePush(vapidPublicKey: string): Promise<void> {
  update({ busy: true, error: null });
  try {
    const permission = await Notification.requestPermission();
    if (permission === "denied") return update({ status: "blocked", busy: false });
    if (permission !== "granted") return update({ status: "off", busy: false, error: "Notification permission wasn't granted." });

    await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    // subscribe() needs an active worker; `ready` resolves once there is one.
    const registration = await navigator.serviceWorker.ready;
    const key = urlBase64ToUint8Array(vapidPublicKey);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
      // Server VAPID keys changed since this browser subscribed; the old subscription is useless.
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });

    try {
      await postJson("/api/push/subscribe", { subscription: subscription.toJSON() });
    } catch (err) {
      // Keep browser and server in agreement: no server record means no alerts.
      await subscription.unsubscribe().catch(() => undefined);
      throw err;
    }
    update({ status: "on", busy: false });
  } catch (err) {
    update({ busy: false, error: describe(err) });
  }
}

export async function disablePush(): Promise<void> {
  update({ busy: true, error: null });
  try {
    const subscription = await currentSubscription();
    if (subscription) {
      const { endpoint } = subscription;
      await subscription.unsubscribe();
      // Best effort: if this fails the server drops the endpoint on its next send (HTTP 410).
      await postJson("/api/push/unsubscribe", { endpoint }).catch(() => undefined);
    }
    update({ status: "off", busy: false });
  } catch (err) {
    update({ busy: false, error: describe(err) });
  }
}

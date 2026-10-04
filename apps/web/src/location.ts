// One-shot "where am I" via the browser's Geolocation API. The fix is used in memory only:
// it is never sent anywhere and never written to the URL.

export interface GpsFix {
  lon: number;
  lat: number;
  accuracyM: number;
}

export type LocateFailure = "unsupported" | "insecure" | "denied" | "unavailable" | "timeout";

export class LocateError extends Error {
  readonly reason: LocateFailure;

  constructor(reason: LocateFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

const MESSAGES: Record<LocateFailure, string> = {
  unsupported: "This browser can't share your location.",
  insecure: "Your browser only shares location on secure (https) pages.",
  denied: "Location access is blocked. Allow it for this site in your browser's settings, or tap the map to pick a start.",
  unavailable: "Your device couldn't work out where you are. Tap the map to pick a start.",
  timeout: "Finding your location took too long. Try again, or tap the map to pick a start.",
};

export function locate(timeoutMs = 12_000): Promise<GpsFix> {
  return new Promise((resolve, reject) => {
    const fail = (reason: LocateFailure) => reject(new LocateError(reason, MESSAGES[reason]));
    if (!("geolocation" in navigator)) return fail("unsupported");
    if (!window.isSecureContext) return fail("insecure");
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lon: p.coords.longitude, lat: p.coords.latitude, accuracyM: p.coords.accuracy }),
      (e) => fail(e.code === e.PERMISSION_DENIED ? "denied" : e.code === e.TIMEOUT ? "timeout" : "unavailable"),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

/** Whether a point lies inside the pack's bounding box, give or take `marginDeg`. */
export function insideBox(bbox: readonly [number, number, number, number], lon: number, lat: number,
  marginDeg = 0.01): boolean {
  const [w, s, e, n] = bbox;
  return lon >= w - marginDeg && lon <= e + marginDeg && lat >= s - marginDeg && lat <= n + marginDeg;
}

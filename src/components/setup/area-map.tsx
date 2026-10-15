"use client";

import { useEffect, useRef } from "react";
import type { Circle, CircleMarker, Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * OpenStreetMap map with the search area drawn as a circle. Click anywhere to move the centre. Leaflet
 * touches `window`, so it is loaded in the browser only.
 */
export function AreaMap({
  lat,
  lng,
  radiusKm,
  onPick,
}: {
  lat: number;
  lng: number;
  radiusKm: number;
  onPick: (lat: number, lng: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const circle = useRef<Circle | null>(null);
  const dot = useRef<CircleMarker | null>(null);
  const pick = useRef(onPick);

  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);

  useEffect(() => {
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled || !box.current || map.current) return;
      const m = L.map(box.current, { scrollWheelZoom: false }).setView([lat, lng], 9);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(m);
      circle.current = L.circle([lat, lng], { radius: radiusKm * 1000, color: "#0f766e", weight: 2, fillOpacity: 0.12 }).addTo(m);
      dot.current = L.circleMarker([lat, lng], { radius: 6, color: "#0f766e", fillOpacity: 1 }).addTo(m);
      m.on("click", (e) => pick.current(e.latlng.lat, e.latlng.lng));
      map.current = m;
      m.fitBounds(circle.current.getBounds(), { padding: [16, 16] });
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
    // The map is created once; later changes move it (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!map.current || !circle.current || !dot.current) return;
    circle.current.setLatLng([lat, lng]).setRadius(radiusKm * 1000);
    dot.current.setLatLng([lat, lng]);
    map.current.fitBounds(circle.current.getBounds(), { padding: [16, 16], animate: true });
  }, [lat, lng, radiusKm]);

  return <div ref={box} className="h-72 w-full overflow-hidden rounded-xl border border-border" role="application" aria-label="Map: click to move the search area" />;
}

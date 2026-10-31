/* MistWalk Google Maps adapter — optional, key required, fog drawn as an overlay. */

const GOOGLE_LOAD_TIMEOUT = 18_000;

const LIGHT_STYLES = [
  { elementType: 'geometry', stylers: [{ color: '#e8eef4' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#edf2ef' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#c5d9e7' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#f7fafc' }] },
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#3d4c5c' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#f5f8fa' }] },
];

const DARK_STYLES = [
  { elementType: 'geometry', stylers: [{ color: '#111b26' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#0d1620' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0a2532' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#22303e' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#263645' }] },
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#91a8bc' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0a1119' }] },
];

let loader = null;

export function googleMapsAvailable() {
  return Boolean(window.google?.maps?.Map);
}

export function loadGoogleMaps(key, { timeout = GOOGLE_LOAD_TIMEOUT } = {}) {
  if (googleMapsAvailable()) return Promise.resolve();
  if (!key) return Promise.reject(new Error('A Google Maps API key is needed.'));
  if (loader && loader.key === key) return loader.promise;

  // Google calls this global when the key is invalid or unauthorized. Install
  // it before the script arrives so failures cannot get lost.
  window.gm_authFailure = () => {
    window.dispatchEvent(new CustomEvent('mistwalk:google-auth-failure'));
  };

  const promise = new Promise((resolve, reject) => {
    const callbackName = `__mistwalkGoogleReady_${Date.now()}`;
    let settled = false;
    const script = document.createElement('script');
    const cleanup = () => {
      delete window[callbackName];
      clearTimeout(timer);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      script.remove();
      loader = null;
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('Google Maps did not finish loading. Check your connection and key.')), timeout);

    window[callbackName] = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (googleMapsAvailable()) resolve();
      else reject(new Error('Google Maps loaded without a Map class.'));
    };

    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=${callbackName}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => fail(new Error('Google Maps could not be downloaded. The free OpenStreetMap map is still available.'));
    document.head.appendChild(script);
  });

  loader = { key, promise };
  return promise;
}

let fogOverlayClass = null;

/**
 * The Google Maps script is loaded lazily, so this class cannot extend
 * google.maps.OverlayView at module-evaluation time. Build it on first use.
 */
function getFogOverlayClass() {
  if (fogOverlayClass) return fogOverlayClass;
  fogOverlayClass = class FogOverlay extends google.maps.OverlayView {
    constructor(canvas, hooks) {
      super();
      this.canvas = canvas;
      this.hooks = hooks;
      this.projection = null;
      this.added = false;
    }

    onAdd() {
      const panes = this.getPanes();
      if (!panes?.overlayLayer) throw new Error('Google Maps overlay layer unavailable.');
      panes.overlayLayer.appendChild(this.canvas);
      this.added = true;
      this.hooks.onAdd?.();
    }

    onRemove() {
      this.canvas.remove();
      this.added = false;
    }

    draw() {
      if (!this.added) return;
      const projection = this.getProjection();
      const map = this.getMap();
      if (!projection || !map) return;
      this.projection = projection;
      const div = map.getDiv();
      const width = div.clientWidth;
      const height = div.clientHeight;
      if (!width || !height) return;
      const center = map.getCenter();
      if (!center) return;
      const cp = projection.fromLatLngToDivPixel(center);
      if (!cp) return;
      this.canvas.style.left = `${Math.round(cp.x - width / 2)}px`;
      this.canvas.style.top = `${Math.round(cp.y - height / 2)}px`;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.hooks.onDraw?.(width, height);
    }

    screenPoint(lat, lng) {
      if (!this.projection) return null;
      try {
        const p = this.projection.fromLatLngToContainerPixel(new google.maps.LatLng(lat, lng));
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
        return { x: p.x, y: p.y };
      } catch {
        return null;
      }
    }

    latLngAt(x, y) {
      if (!this.projection) return null;
      try {
        const ll = this.projection.fromContainerPixelToLatLng(new google.maps.Point(x, y));
        if (!ll) return null;
        return { lat: ll.lat(), lng: ll.lng() };
      } catch {
        return null;
      }
    }
  };
  return fogOverlayClass;
}

export class GoogleMap {
  static async create(options) {
    await loadGoogleMaps(options.key);
    return new GoogleMap(options);
  }

  constructor({ container, center, zoom = 17, basemap = 'osm', onViewChange, onReady, onClick, onUserDrag }) {
    this.container = container;
    this.onViewChange = onViewChange;
    this.onClick = onClick;
    this.onUserDrag = onUserDrag;
    this.destroyed = false;
    this.pending = false;
    this.basemap = basemap;
    this.ready = false;

    this.surface = document.createElement('div');
    this.surface.className = 'google-map-surface';
    container.appendChild(this.surface);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fog-canvas fog-canvas--google';
    this.canvas.setAttribute('aria-hidden', 'true');

    this.map = new google.maps.Map(this.surface, {
      center: { lat: center.lat, lng: center.lng },
      zoom,
      disableDefaultUI: true,
      clickableIcons: false,
      keyboardShortcuts: false,
      gestureHandling: 'greedy',
      tilt: 0,
      heading: 0,
      backgroundColor: '#0b1119',
      styles: basemap === 'dark' ? DARK_STYLES : LIGHT_STYLES,
      mapTypeId: 'roadmap',
      maxZoom: 21,
      minZoom: 2,
    });

    this.map.addListener('click', (event) => {
      if (this.onClick && event.latLng) this.onClick(event.latLng.lat(), event.latLng.lng());
    });

    const FogOverlay = getFogOverlayClass();
    this.overlay = new FogOverlay(this.canvas, {
      onAdd: () => {
        this.ready = true;
        this.scheduleChange();
      },
      onDraw: (width, height) => {
        this.width = width;
        this.height = height;
        // Wait for the first real projection/draw so the fog canvas is never
        // shown for a frame over an unprotected Google map.
        if (!this.notifiedReady) {
          this.notifiedReady = true;
          onReady?.(this);
        }
        this.scheduleChange();
      },
    });
    this.overlay.setMap(this.map);

    for (const event of ['bounds_changed', 'zoom_changed', 'idle']) {
      this.map.addListener(event, () => this.scheduleChange());
    }
    this.map.addListener('dragstart', () => this.onUserDrag?.());
    google.maps.event.addListenerOnce(this.map, 'idle', () => {
      requestAnimationFrame(() => {
        this.scheduleChange();
        if (!this.ready) onReady?.(this);
      });
    });

    // If the key is rejected, tell the app so it can fall back to the free map.
    window.gm_authFailure = () => {
      window.dispatchEvent(new CustomEvent('mistwalk:google-auth-failure'));
    };
  }

  scheduleChange() {
    if (this.destroyed || this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      if (!this.destroyed) this.onViewChange?.();
    });
  }

  get attribution() {
    return '<a href="https://maps.google.com" target="_blank" rel="noopener">Google Maps</a>';
  }

  get providerLabel() {
    return 'Google Maps';
  }

  get zoom() {
    return this.map.getZoom() ?? 17;
  }

  get center() {
    const c = this.map.getCenter();
    return c ? { lat: c.lat(), lng: c.lng() } : { lat: 0, lng: 0 };
  }

  get bounds() {
    const b = this.map.getBounds();
    if (!b) return null;
    return { north: b.getNorthEast().lat(), east: b.getNorthEast().lng(), south: b.getSouthWest().lat(), west: b.getSouthWest().lng() };
  }

  project(lat, lng) {
    return this.overlay.screenPoint(lat, lng);
  }

  unproject(x, y) {
    return this.overlay.latLngAt(x, y);
  }

  setView(lat, lng, zoom = this.zoom, animate = false) {
    this.map.setOptions({ center: { lat, lng }, zoom });
    if (animate) this.map.panTo({ lat, lng });
  }

  panTo(lat, lng, animate = true) {
    if (animate) this.map.panTo({ lat, lng });
    else this.map.setCenter({ lat, lng });
  }

  zoomBy(delta) {
    this.map.setZoom(this.zoom + delta);
  }

  fitBounds(bounds, padding = 48) {
    this.map.fitBounds(
      { north: bounds.north, south: bounds.south, east: bounds.east, west: bounds.west },
      padding,
    );
  }

  setBasemap(name) {
    this.basemap = name;
    this.map.setOptions({ styles: name === 'dark' ? DARK_STYLES : LIGHT_STYLES });
  }

  resize() {
    google.maps.event.trigger(this.map, 'resize');
    this.scheduleChange();
  }

  destroy() {
    this.destroyed = true;
    this.overlay?.setMap(null);
    this.overlay = null;
    this.canvas.remove();
    if (this.map) google.maps.event.clearInstanceListeners(this.map);
    this.map = null;
    this.surface.remove();
    this.container.innerHTML = '';
  }
}

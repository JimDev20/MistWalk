// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	const __SUPABASE_URL__: string;
	const __SUPABASE_ANON_KEY__: string;

	var google: {
		maps: {
			Map: typeof google.maps.Map;
			OverlayView: typeof google.maps.OverlayView;
			LatLng: typeof google.maps.LatLng;
			Point: typeof google.maps.Point;
			event: {
				addListenerOnce(
					instance: google.maps.Map,
					eventName: string,
					handler: () => void
				): google.maps.MapsEventListener;
				trigger(instance: google.maps.Map, eventName: string): void;
				clearInstanceListeners(instance: google.maps.Map): void;
			};
		};
	};

	interface Window {
		google?: typeof google;
		gm_authFailure?: () => void;
	}

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};

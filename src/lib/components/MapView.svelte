<script lang="ts">
	import { onMount } from 'svelte';
	import { app } from '#lib/mistwalk.svelte.ts';

	let mapElement: HTMLDivElement;
	let shellElement: HTMLElement;

	onMount(() => {
		let cancelled = false;
		app.init(mapElement!, shellElement!).catch((error) => {
			if (cancelled) return;
			console.error('MistWalk failed to start', error);
			app.state.ready = true;
			app.state.booted = true;
			app.state.status = { state: 'error', label: 'Start failed', detail: 'Reload to retry' };
			app.toast('MistWalk could not start. Reload the page to try again.', 'error', 8000);
		});
		return () => {
			cancelled = true;
		};
	});
</script>

<main class="map-shell" bind:this={shellElement}>
	<div class="map" bind:this={mapElement} aria-label="Fogged exploration map"></div>
	<div class="map-vignette" aria-hidden="true"></div>
	<div class="map-horizon" aria-hidden="true"></div>
</main>

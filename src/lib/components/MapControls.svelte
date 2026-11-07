<script lang="ts">
	import { app } from '#lib/mistwalk.svelte.ts';
</script>

<div class="map-controls" aria-label="Map controls">
	<div class="control-stack">
		<button class="map-btn" type="button" aria-label="Zoom in" onclick={() => app.zoomIn()}
			><svg><use href="#i-plus"></use></svg></button
		>
		<button class="map-btn" type="button" aria-label="Zoom out" onclick={() => app.zoomOut()}
			><svg><use href="#i-minus"></use></svg></button
		>
	</div>
	<div class="control-stack">
		<button
			class="map-btn map-btn--accent"
			type="button"
			aria-label="Go to my location"
			onclick={() => app.recenter()}><svg><use href="#i-locate"></use></svg></button
		>
		<button
			class="map-btn"
			type="button"
			aria-label="Find the nearest unexplored tile"
			title="Find the nearest mist"
			onclick={() => app.guideToUnexplored()}><svg><use href="#i-target"></use></svg></button
		>
		<button
			class="map-btn"
			type="button"
			aria-label="Open tile notes"
			title="Tile notes"
			onclick={() => app.openJourney('notes')}><svg><use href="#i-note"></use></svg></button
		>
		<button
			class="map-btn"
			class:map-btn--accent={app.state.placePick}
			type="button"
			aria-label={app.state.placePick ? 'Cancel place pick' : 'Mark a favorite place'}
			aria-pressed={app.state.placePick}
			title={app.state.placePick ? 'Cancel place pick' : 'Mark a favorite place'}
			onclick={() => app.togglePlacePick()}><svg><use href="#i-star"></use></svg></button
		>
		<button
			class="map-btn"
			type="button"
			aria-label="Fit explored area"
			onclick={() => app.fitExplored()}><svg><use href="#i-expand"></use></svg></button
		>
	</div>
</div>

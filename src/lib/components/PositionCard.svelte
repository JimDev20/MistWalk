<script lang="ts">
	import { app } from '#lib/mistwalk.svelte.ts';
</script>

<div class="position-card panel">
	<div class="compass" aria-hidden="true">
		<span class="compass-n">N</span>
		<span class="compass-needle" style:transform="rotate({app.state.ui.heading ?? 0}deg)"></span>
		<span class="compass-ring"></span>
	</div>
	<div class="position-copy">
		<span class="eyebrow">Position</span>
		<div class="mono position-coords">{app.state.ui.coordText}</div>
		<div class="position-meta">
			<span class="position-provider">{app.state.ui.providerLabel}</span>
			<a
				class="position-google"
				href={app.state.ui.googleLink}
				target="_blank"
				rel="external noopener"
				title="Open this location in Google Maps">Google Maps</a
			>
			<button
				class="position-note"
				type="button"
				title="Tile notes"
				onclick={() => app.openJourney('notes')}
			>
				<svg><use href="#i-note"></use></svg><span>{app.state.ui.noteCount}</span>
			</button>
			<button
				class="position-note"
				type="button"
				title="Favorite places"
				onclick={() => app.openJourney('places')}
			>
				<svg><use href="#i-star"></use></svg><span>{app.state.ui.placeCount}</span>
			</button>
		</div>
	</div>
</div>

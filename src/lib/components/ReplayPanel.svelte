<script lang="ts">
	import { app } from '#lib/mistwalk.svelte.ts';

	let progress = $derived(
		app.state.replay
			? Math.max(
					0,
					Math.min(
						100,
						Math.round(
							((app.state.replay.index - 1) / Math.max(1, app.state.replay.path.length - 1)) * 100
						)
					)
				)
			: 0
	);
</script>

{#if app.state.replay}
	<aside class="replay-panel panel" aria-label="Route replay" aria-live="polite">
		<div class="replay-copy">
			<span class="eyebrow">Route overlay</span>
			<strong>{app.state.replay.label}</strong>
			<small>{app.state.replay.detail}</small>
			<div class="replay-track" aria-hidden="true"><span style:width="{progress}%"></span></div>
		</div>
		<div class="replay-actions">
			<span class="replay-percent">{progress}%</span>
			<button
				class="map-btn"
				type="button"
				aria-label={app.state.replay.playing ? 'Pause replay' : 'Play replay'}
				onclick={() => app.toggleReplay()}
			>
				<svg><use href={app.state.replay.playing ? '#i-pause' : '#i-play'}></use></svg>
			</button>
			<button
				class="map-btn"
				type="button"
				aria-label="Close route overlay"
				onclick={() => app.stopReplay()}><svg><use href="#i-close"></use></svg></button
			>
		</div>
	</aside>
{/if}

<script lang="ts">
	import { app } from '#lib/mistwalk.svelte.ts';

	function stopSimulation() {
		app.stopSim();
		app.toast('Simulation stopped. Progress is saved.', 'info', 2600);
	}
</script>

{#if app.state.ui.simVisible}
	<div class="sim-panel panel">
		<div class="sim-copy">
			<span class="sim-badge">Simulation</span>
			<span id="sim-hint">{app.state.ui.simHint}</span>
		</div>
		<button
			class="sim-speed"
			type="button"
			title="Simulation speed"
			onclick={() => app.cycleSimSpeed()}>{app.state.ui.simSpeedLabel}</button
		>
		<button
			class="sim-btn"
			type="button"
			title="Place walker at map center"
			onclick={() => app.placeSimWalker()}>Place</button
		>
		<button class="sim-btn" type="button" onclick={stopSimulation}>Stop</button>
		<button
			class="sim-exit"
			type="button"
			aria-label="Exit simulation"
			onclick={() => app.switchProfile('live')}><svg><use href="#i-close"></use></svg></button
		>
	</div>
{/if}

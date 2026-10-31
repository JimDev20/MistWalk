<script lang="ts">
	import { app } from '#lib/mistwalk.svelte.ts';
</script>

{#if app.state.modal === 'gps-modal'}
	<div class="modal" id="gps-modal" role="dialog" aria-modal="true" aria-labelledby="gps-title">
		<div class="modal-card modal-card--narrow">
			<header class="modal-head">
				<div><h2 id="gps-title">Location is blocked</h2></div>
				<button
					class="icon-btn modal-close"
					type="button"
					aria-label="Close"
					onclick={() => app.closeModal('gps-modal')}><svg><use href="#i-close"></use></svg></button
				>
			</header>
			<div class="modal-body">
				<p class="gps-message">
					{app.state.gps.message ||
						'Your browser did not give MistWalk a GPS fix. Allow location access for this page, then try again.'}
				</p>
				<ol class="gps-steps">
					<li>Open the site settings from the lock icon in the address bar.</li>
					<li>Set <strong>Location</strong> to <strong>Allow</strong>.</li>
					<li>Return here and press retry.</li>
				</ol>
				<div class="gps-actions">
					<button class="btn btn--primary" type="button" onclick={() => app.retryGps()}
						><svg><use href="#i-locate"></use></svg><span>Retry GPS</span></button
					>
					<button class="btn btn--ghost" type="button" onclick={() => app.useSimulatorFromGps()}
						><svg><use href="#i-play"></use></svg><span>Use simulator</span></button
					>
				</div>
				<p class="micro-note">Live GPS requires a secure page: <code>localhost</code> or HTTPS.</p>
			</div>
		</div>
	</div>
{/if}

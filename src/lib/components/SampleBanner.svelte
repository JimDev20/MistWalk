<script lang="ts">
	import { app } from '#lib/mistwalk.svelte.ts';
</script>

<div class="sample-banner" role="status">
	<div class="sample-banner__text">
		<strong>Sample simulator</strong>
		<span>
			{#if app.state.cloud.status === 'pending'}
				Waiting for owner approval. Sample progress is not saved.
			{:else if app.state.cloud.user}
				Signed in as {app.state.cloud.email}. Sample progress is not saved.
			{:else}
				Progress here is temporary. Sign in to request a permanent map.
			{/if}
		</span>
	</div>
	<div class="sample-banner__actions">
		<button class="btn btn--small btn--primary" type="button" onclick={() => app.exitSample()}
			>{app.state.cloud.status === 'pending' ? 'Check status' : 'Sign in'}</button
		>
	</div>
</div>

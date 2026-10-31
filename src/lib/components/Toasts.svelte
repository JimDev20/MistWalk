<script lang="ts">
	import { app } from '#lib/mistwalk.svelte.ts';
</script>

<div class="toast-stack" aria-live="polite">
	{#each app.state.toasts as toast (toast.id)}
		<div class="toast" class:is-leaving={toast.leaving} data-kind={toast.kind}>{toast.message}</div>
	{/each}
</div>

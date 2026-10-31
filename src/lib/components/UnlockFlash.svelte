<script lang="ts">
	import { app } from '#lib/mistwalk.svelte.ts';
</script>

<div
	class="unlock-flash"
	class:is-active={app.state.flash.active}
	style:--x="{app.state.flash.x}%"
	style:--y="{app.state.flash.y}%"
	aria-hidden="true"
></div>

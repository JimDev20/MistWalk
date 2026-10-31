<script lang="ts">
	import { app } from '#lib/mistwalk.svelte.ts';
</script>

<div class="boot-screen" class:is-done={app.state.booted} aria-hidden="true">
	<div class="boot-glyph"><svg><use href="#i-logo"></use></svg></div>
	<div class="boot-word">MistWalk</div>
	<div class="boot-sub">Lifting the mist</div>
	<div class="boot-line"><span></span></div>
</div>

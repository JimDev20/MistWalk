<script lang="ts">
	import { app } from '#lib/mistwalk.svelte.ts';
</script>

<header class="topbar">
	<button class="brand" type="button" aria-label="MistWalk home" onclick={() => app.openHelp()}>
		<span class="brand-mark"><svg><use href="#i-logo"></use></svg></span>
		<span class="brand-type">
			<span class="brand-name">MistWalk</span>
			<span class="brand-sub">Local exploration system</span>
		</span>
	</button>

	<div class="topbar-status">
		<div class="status-pill" data-state={app.state.status.state}>
			<span class="status-dot"></span>
			<span class="status-label">{app.state.status.label}</span>
			<span class="status-detail">{app.state.status.detail}</span>
		</div>
	</div>

	<div class="topbar-actions">
		<button
			class="icon-btn"
			type="button"
			aria-label="Open journey record"
			title="Journey, history and badges"
			onclick={() => app.openJourney('overview')}
		>
			<svg><use href="#i-compass"></use></svg>
		</button>
		<button
			class="icon-btn"
			type="button"
			aria-label="Search a place"
			title="Search a place"
			onclick={() => app.openSearch()}
		>
			<svg><use href="#i-search"></use></svg>
		</button>
		<button
			class="icon-btn"
			type="button"
			aria-label="Settings"
			title="Settings"
			onclick={() => app.openSettings()}
		>
			<svg><use href="#i-sliders"></use></svg>
		</button>
		<button
			class="icon-btn"
			type="button"
			aria-label="How it works"
			title="How it works"
			onclick={() => app.openHelp()}
		>
			<svg><use href="#i-help"></use></svg>
		</button>
	</div>
</header>

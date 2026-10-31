<script lang="ts">
	import { app } from '#lib/mistwalk.svelte.ts';
</script>

<aside class="hud panel" aria-label="Exploration progress">
	<div class="hud-head">
		<div>
			<h2>{app.state.ui.levelName}</h2>
		</div>
		<div class="hud-badge">
			<span class="level-number">{app.state.ui.levelNumber}</span>
			<span class="hud-state" data-state={app.state.status.state}
				><i></i><span>{app.state.status.label}</span></span
			>
		</div>
	</div>
	<p class="level-tag">{app.state.ui.levelTag}</p>
	<div class="level-track" aria-hidden="true">
		<span style:width="{app.state.ui.levelProgress}%"></span>
	</div>

	<div class="stat-grid">
		<div class="stat stat--wide">
			<span class="stat-label">Revealed</span>
			<strong>{app.state.ui.statArea}</strong>
			<span class="stat-sub">{app.state.ui.statTiles}</span>
		</div>
		<div class="stat">
			<span class="stat-label">Walked</span>
			<strong>{app.state.ui.statDistance}</strong>
			<span class="stat-sub">all time</span>
		</div>
		<div class="stat">
			<span class="stat-label">Streak</span>
			<strong>{app.state.ui.statStreak}</strong>
			<span class="stat-sub">days</span>
		</div>
	</div>

	<div class="walk-card" data-live={app.state.ui.walkLive}>
		<div class="walk-card-head">
			<span class="walk-live"><i></i> This walk</span>
			<span class="mono">{app.state.ui.walkTime}</span>
		</div>
		<div class="walk-stats">
			<div><span>{app.state.ui.walkDistance}</span><small>distance</small></div>
			<div><span>{app.state.ui.walkSpeed}</span><small>{app.state.ui.walkSpeedUnit}</small></div>
			<div><span>{app.state.ui.walkUnlocks}</span><small>new tiles</small></div>
		</div>
	</div>

	<div class="hud-signal" data-quality={app.state.ui.gpsLevel}>
		<i aria-hidden="true"></i>
		<span>{app.state.ui.gpsLabel}</span>
		<small>{app.state.ui.gpsDetail}</small>
	</div>

	<div class="hud-actions">
		<button
			class="btn btn--ghost"
			class:is-active={app.state.follow}
			type="button"
			aria-pressed={app.state.follow}
			onclick={() => app.toggleFollow()}
		>
			<svg><use href="#i-locate"></use></svg><span>{app.state.ui.followLabel}</span>
		</button>
		<button class="btn btn--dark" type="button" onclick={() => app.toggleWalk()}>
			<svg><use href={app.state.ui.walkButtonIcon}></use></svg><span
				>{app.state.ui.walkButtonLabel}</span
			>
		</button>
	</div>
	<div class="hud-attribution">
		{#each app.state.ui.attribution as part, index (part.text)}
			{#if index > 0}<span aria-hidden="true"> · </span>{/if}{#if part.href}<a
					href={part.href}
					target="_blank"
					rel="external noopener">{part.text}</a
				>{:else}{part.text}{/if}
		{/each}
	</div>
</aside>

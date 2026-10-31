<script lang="ts">
	import { app } from '#lib/mistwalk.svelte.ts';
</script>

<section
	class="onboarding"
	class:is-leaving={app.state.onboardingLeaving}
	aria-label="Welcome to MistWalk"
>
	<div class="onboarding-inner">
		<div class="onboarding-copy">
			<span class="onboarding-kicker">A quiet map for the places you walk.</span>
			<h1>The world<br />is in mist.</h1>
			<p class="onboarding-lede">
				Walk the real world. Every <strong>12-metre tile</strong> you cross lifts the fog. It stays clear
				for good.
			</p>
			<p class="feature-row">
				<span>Walking only.</span><span>Private by design.</span><span>Free to run.</span>
			</p>
			<div class="onboarding-actions">
				<button class="btn btn--primary btn--large" type="button" onclick={() => app.startGps()}>
					<svg><use href="#i-locate"></use></svg>
					<span>Enable live GPS</span>
				</button>
				<button class="btn btn--ghost btn--large" type="button" onclick={() => app.startDemo()}>
					<svg><use href="#i-play"></use></svg>
					<span>Try the simulator</span>
				</button>
			</div>
			<p class="micro-note">
				Local-first. No account required. Cloud backup is optional. <button
					class="micro-link"
					type="button"
					onclick={() => app.openHelp()}>How it works</button
				>
			</p>
		</div>

		<div class="portal-wrap" aria-hidden="true">
			<div class="portal">
				<div class="portal-map"></div>
				<div class="portal-fog"></div>
				<svg class="portal-trail" viewBox="0 0 400 400">
					<path
						d="M112 330c16-62 44-78 78-106 31-26 31-58 10-86-18-24-10-53 21-68"
						fill="none"
						stroke="rgba(156,236,245,.86)"
						stroke-width="2.2"
						stroke-linecap="round"
						stroke-dasharray="2 7"
					></path>
				</svg>
				<div class="portal-cell c1"></div>
				<div class="portal-cell c2"></div>
				<div class="portal-cell c3"></div>
				<div class="portal-cell c4"></div>
				<div class="portal-pin">
					<svg class="portal-icon" aria-hidden="true"><use href="#i-navigation"></use></svg>
				</div>
				<div class="portal-ring"></div>
				<div class="portal-compass">N</div>
			</div>
			<div class="portal-caption">
				<span class="eyebrow">Field note</span>
				<p>“The map is not missing. It is waiting.”</p>
			</div>
		</div>
	</div>
	<div class="onboarding-footer">
		<span>MistWalk / Build 2.0</span>
		<span class="mono">12 m tiles, GPS verified, local save</span>
	</div>
</section>

<script lang="ts">
	import { app } from '#lib/mistwalk.svelte.ts';

	function exportNow() {
		app.closeModal('help-modal');
		app.downloadBackup();
	}
</script>

{#if app.state.modal === 'help-modal'}
	<div class="modal" id="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title">
		<div class="modal-card modal-card--wide">
			<header class="modal-head">
				<div><h2 id="help-title">How MistWalk works</h2></div>
				<button
					class="icon-btn modal-close"
					type="button"
					aria-label="Close manual"
					onclick={() => app.closeModal('help-modal')}
					><svg><use href="#i-close"></use></svg></button
				>
			</header>
			<div class="modal-body help-body">
				<article class="help-card">
					<span class="help-num">01</span>
					<h3>Walk to reveal</h3>
					<p>
						Every point is snapped to a 12-metre tile. A tile unlocks only when a GPS fix inside it
						passes the walking gate. The fog lifts permanently; old tiles never return.
					</p>
				</article>
				<article class="help-card">
					<span class="help-num">02</span>
					<h3>Walking only</h3>
					<p>
						Faster than a brisk walk (about 10.8 km/h) never unlocks tiles. Vehicle-speed fixes
						pause unlocking for 45 seconds, and unlocking resumes only after three calm walking
						fixes.
					</p>
				</article>
				<article class="help-card">
					<span class="help-num">03</span>
					<h3>Private by construction</h3>
					<p>
						No analytics. Your tiles, trail, and stats stay in this browser's local storage with an
						IndexedDB mirror. On private deployments, approved accounts can sync with Supabase using
						a one-time email code. Guests can use the temporary sample simulator.
					</p>
				</article>
				<article class="help-card">
					<span class="help-num">04</span>
					<h3>Field record</h3>
					<p>
						Open Journey to see badges, GPS signal, nearest mist, daily walk history, and tile
						notes. Pause a walk, arrive at a simulator target, or switch profiles to archive it.
						Same-day walks merge into one daily record. Routes can be replayed and exported as
						private GPX or GeoJSON files.
					</p>
				</article>
				<article class="help-card">
					<span class="help-num">05</span>
					<h3>Free map first</h3>
					<p>
						OpenStreetMap tiles need no key, account, or billing. Google Maps is optional: paste a
						restricted browser key in settings. The free map remains the default.
					</p>
				</article>
				<article class="help-card help-card--wide">
					<span class="help-num">06</span>
					<h3>Using it on a phone</h3>
					<p>
						Browsers only give GPS to secure pages. This build runs on Vercel over HTTPS. Open the
						deployment URL on your phone and install MistWalk to the home screen. Local development
						over <code>http://localhost</code> is also secure.
					</p>
				</article>
				<article class="help-card help-card--wide help-card--quiet">
					<div>
						<h3>Emergency backup</h3>
						<p>
							Export one JSON file containing both the live and simulator profiles. Keep it
							somewhere safe; restoring replaces local progress.
						</p>
					</div>
					<button class="btn btn--primary" type="button" onclick={exportNow}
						><svg><use href="#i-download"></use></svg><span>Export now</span></button
					>
				</article>
			</div>
		</div>
	</div>
{/if}

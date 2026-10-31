<script lang="ts">
	import { app } from '#lib/mistwalk.svelte.ts';
	import type { Achievement } from '#lib/types.ts';

	let noteText = $state('');
	let noteKey: string | null = $state(null);

	$effect(() => {
		if (app.state.modal === 'journey-modal' && app.state.journey.tab === 'notes') {
			noteKey = app.currentCellKey();
			noteText = app.noteForCurrent();
		}
	});

	function badgeIcon(metric: string) {
		if (metric === 'cellCount') return '#i-grid';
		if (metric === 'sessions') return '#i-walk';
		if (metric === 'streak') return '#i-flame';
		if (metric === 'distance') return '#i-route';
		if (metric === 'favoriteCells') return '#i-star';
		if (metric === 'maxVisits') return '#i-route';
		return '#i-note';
	}

	function tab(name: string) {
		app.setJourneyTab(name);
	}

	function saveNote() {
		app.saveNote(noteText);
		noteKey = app.currentCellKey();
		noteText = app.noteForCurrent();
	}

	function removeCurrent() {
		noteText = '';
		app.saveNote('');
	}
</script>

{#if app.state.modal === 'journey-modal'}
	<div
		class="modal"
		id="journey-modal"
		role="dialog"
		aria-modal="true"
		aria-labelledby="journey-title"
	>
		<div class="modal-card modal-card--wide journey-modal">
			<header class="modal-head">
				<div>
					<span class="eyebrow">Field record</span>
					<h2 id="journey-title">Journey</h2>
				</div>
				<button
					class="icon-btn modal-close"
					type="button"
					aria-label="Close journey"
					onclick={() => app.closeModal('journey-modal')}
					><svg><use href="#i-close"></use></svg></button
				>
			</header>

			<div class="journey-tabs" role="tablist" aria-label="Journey sections">
				<button
					type="button"
					role="tab"
					aria-selected={app.state.journey.tab === 'overview'}
					class:is-active={app.state.journey.tab === 'overview'}
					onclick={() => tab('overview')}>Overview</button
				>
				<button
					type="button"
					role="tab"
					aria-selected={app.state.journey.tab === 'history'}
					class:is-active={app.state.journey.tab === 'history'}
					onclick={() => tab('history')}>History <span>{app.state.ui.historyCount}</span></button
				>
				<button
					type="button"
					role="tab"
					aria-selected={app.state.journey.tab === 'notes'}
					class:is-active={app.state.journey.tab === 'notes'}
					onclick={() => tab('notes')}>Notes <span>{app.state.ui.noteCount}</span></button
				>
			</div>

			<div class="modal-body journey-body">
				{#if app.state.journey.tab === 'overview'}
					<section class="journey-hero">
						<div>
							<span class="eyebrow">Level {app.state.ui.levelNumber}</span>
							<h3>{app.state.ui.levelName}</h3>
							<p>{app.state.ui.levelTag}</p>
						</div>
						<div class="journey-badge-total">{app.state.ui.badgeCount}<small>badges</small></div>
					</section>

					<div class="journey-metrics">
						<div><span>Revealed</span><strong>{app.state.ui.statArea}</strong></div>
						<div><span>Tiles</span><strong>{app.state.ui.statTiles}</strong></div>
						<div><span>Walked</span><strong>{app.state.ui.statDistance}</strong></div>
						<div><span>Streak</span><strong>{app.state.ui.statStreak}</strong></div>
						<div><span>Sessions</span><strong>{app.state.ui.sessionCount}</strong></div>
						<div><span>Notes</span><strong>{app.state.ui.noteCount}</strong></div>
						<div>
							<span>Favorites</span><strong>{app.state.stats?.favoriteCells ?? 0}</strong>
						</div>
						<div><span>Visits</span><strong>{app.state.stats?.visits ?? 0}</strong></div>
					</div>

					{#if app.state.challenge}
						{@const challenge = app.challengeInfo()}
						<section class="journey-panel">
							<div class="journey-panel-head">
								<div>
									<span class="eyebrow">Friend challenge</span>
									<strong>{app.state.challenge.title}</strong>
									<small class="field-note">
										{challenge
											? challenge.complete
												? 'Challenge complete on this map.'
												: `${challenge.remaining.toLocaleString()} tiles to go`
											: ''}
									</small>
								</div>
								<div class="replay-actions">
									<button class="btn btn--ghost" type="button" onclick={() => app.shareChallenge()}
										>Copy link</button
									>
									<button
										class="btn btn--ghost"
										type="button"
										onclick={() => app.dismissChallenge()}>Dismiss</button
									>
								</div>
							</div>
							{#if challenge}
								<div class="challenge-progress" aria-hidden="true">
									<span style:width="{challenge.percent}%"></span>
								</div>
							{/if}
						</section>
					{/if}

					<section class="journey-panel gps-readout" data-quality={app.state.ui.gpsLevel}>
						<div>
							<span class="eyebrow">Signal</span>
							<strong>{app.state.ui.gpsLabel}</strong>
							<small>{app.state.ui.gpsDetail}</small>
						</div>
						<div class="gps-readout-meta">
							{#if app.state.battery}
								<span>{app.state.battery.level}% battery</span>
								<span>{app.state.battery.charging ? 'Charging' : 'On battery'}</span>
							{:else}
								<span>Battery API unavailable</span>
							{/if}
							<span>{app.state.profile === 'demo' ? 'Simulated profile' : 'Live profile'}</span>
						</div>
					</section>

					<section class="journey-panel">
						<div class="journey-panel-head">
							<div>
								<span class="eyebrow">Nearest mist</span>
								<strong>{app.state.ui.nearestLabel}</strong>
							</div>
							<div class="journey-actions">
								{#if app.state.guide}
									<button class="btn btn--ghost" type="button" onclick={() => app.clearGuide()}
										>Clear</button
									>
								{/if}
								<button
									class="btn btn--primary"
									type="button"
									onclick={() => app.guideToUnexplored()}
									><svg><use href="#i-locate"></use></svg><span>Guide me</span></button
								>
							</div>
						</div>
					</section>

					<section class="journey-section">
						<div class="journey-section-head">
							<h3>Badges</h3>
							<span
								>{app.state.achievements.filter((badge: Achievement) => badge.earned).length} earned</span
							>
						</div>
						<div class="badge-grid">
							{#each app.state.achievements as badge (badge.id)}
								<article class="badge" class:is-earned={badge.earned}>
									<span class="badge-icon"
										><svg><use href={badgeIcon(badge.metric)}></use></svg></span
									>
									<div>
										<strong>{badge.title}</strong>
										<small>{badge.detail}</small>
										<div class="badge-track" aria-hidden="true">
											<span style:width="{Math.round(badge.progress * 100)}%"></span>
										</div>
									</div>
								</article>
							{/each}
						</div>
					</section>

					<section class="journey-actions">
						<button class="btn btn--ghost" type="button" onclick={() => app.exportTracks('gpx')}
							><svg><use href="#i-route"></use></svg><span>GPX</span></button
						>
						<button class="btn btn--ghost" type="button" onclick={() => app.exportTracks('geojson')}
							><svg><use href="#i-route"></use></svg><span>GeoJSON</span></button
						>
						<button class="btn btn--ghost" type="button" onclick={() => app.downloadShareCard()}
							><svg><use href="#i-download"></use></svg><span>Share card</span></button
						>
						<button class="btn btn--ghost" type="button" onclick={() => app.shareChallenge()}
							><svg><use href="#i-trophy"></use></svg><span>Challenge a friend</span></button
						>
					</section>
				{:else if app.state.journey.tab === 'history'}
					<section class="journey-section">
						<div class="journey-section-head">
							<h3>Daily history</h3>
							<span>One record per day · private to this device</span>
						</div>
						{#if app.state.sessions.length}
							<div class="history-list">
								{#each app.state.sessions as session (session.id)}
									<article class="history-item">
										<div class="history-copy">
											<div class="history-title">
												<strong>{session.dateLabel}</strong>
												<span>{session.profileLabel}</span>
											</div>
											<div class="history-meta">
												<span>{session.distanceLabel}</span>
												<span>{session.durationLabel}</span>
												<span>{session.unlocks} new</span>
												<span>{session.pointCount} points</span>
											</div>
										</div>
										<button
											class="btn btn--ghost"
											type="button"
											onclick={() => app.playSession(session.id)}
											><svg><use href="#i-play"></use></svg><span>Open day route</span></button
										>
									</article>
								{/each}
							</div>
						{:else}
							<div class="journey-empty">
								<p>No daily records yet. Pause a walk or switch profiles to record today.</p>
							</div>
						{/if}
					</section>
				{:else}
					<section class="journey-section">
						<div class="journey-section-head">
							<h3>Tile notes</h3>
							<span>{noteKey ? app.currentCellLabel() : 'Move the map first'}</span>
						</div>
						<form
							class="note-form"
							onsubmit={(event) => {
								event.preventDefault();
								saveNote();
							}}
						>
							<label for="tile-note">Note for the tile under the walker or map centre</label>
							<textarea
								id="tile-note"
								maxlength="280"
								rows="3"
								bind:value={noteText}
								placeholder="A bench, a smell, a memory…"></textarea>
							<div class="note-actions">
								<span>{noteText.length}/280</span>
								<button class="btn btn--ghost" type="button" onclick={removeCurrent}>Clear</button>
								<button class="btn btn--primary" type="submit">Save note</button>
							</div>
						</form>
						{#if app.state.notes.length}
							<div class="note-list">
								{#each app.state.notes as note (note.key)}
									<article class="note-item">
										<div>
											<p>{note.text}</p>
											<small>{note.coordsLabel} · {note.dateLabel}</small>
										</div>
										<div class="note-item-actions">
											<button
												class="btn btn--ghost"
												type="button"
												onclick={() => app.jumpToNote(note.key)}>Go</button
											>
											<button
												class="btn btn--danger-ghost"
												type="button"
												onclick={() => app.deleteNote(note.key)}
												><svg><use href="#i-trash"></use></svg><span>Delete</span></button
											>
										</div>
									</article>
								{/each}
							</div>
						{:else}
							<div class="journey-empty"><p>No tile notes yet.</p></div>
						{/if}
					</section>
				{/if}
			</div>
		</div>
	</div>
{/if}

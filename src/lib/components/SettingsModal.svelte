<script lang="ts">
	import { resolve } from '$app/paths';
	import { app } from '#lib/mistwalk.svelte.ts';
	import MemberPanel from './MemberPanel.svelte';

	let fileInput: HTMLInputElement | null = $state(null);
	let trackInput: HTMLInputElement | null = $state(null);

	function submitGoogleKey(event: SubmitEvent) {
		event.preventDefault();
		const data = new FormData(event.currentTarget as HTMLFormElement);
		app.saveGoogleKey(String(data.get('google-key') || ''));
	}

	function submitCloudPassword(event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		const data = new FormData(form);
		void app.changeCloudPassword(String(data.get('cloud-password') || '')).then((ok) => {
			if (ok) form.reset();
		});
	}

	function submitCloudInvite(event: SubmitEvent) {
		event.preventDefault();
		const data = new FormData(event.currentTarget as HTMLFormElement);
		void app.redeemCloudInvite(String(data.get('cloud-invite') || ''));
	}

	async function importFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (file) await app.handleImportFile(file);
	}

	async function importTrack(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (file) await app.importTrackFile(file);
	}

	function savedAtLabel(value: number | string) {
		const time = Number(value);
		if (!Number.isFinite(time) || time <= 0) return 'No cloud backup saved yet.';
		return `Last cloud backup: ${new Date(time).toLocaleString()}`;
	}
</script>

{#if app.state.modal === 'settings-modal'}
	<div
		class="modal"
		id="settings-modal"
		role="dialog"
		aria-modal="true"
		aria-labelledby="settings-title"
	>
		<div class="modal-card">
			<header class="modal-head">
				<div><h2 id="settings-title">Field settings</h2></div>
				<button
					class="icon-btn modal-close"
					type="button"
					aria-label="Close settings"
					onclick={() => app.closeModal('settings-modal')}
					><svg><use href="#i-close"></use></svg></button
				>
			</header>
			<div class="modal-body">
				<section class="settings-section">
					<h3>Map source</h3>
					<div class="segmented" role="tablist" aria-label="Map provider">
						<button
							class:is-active={app.state.settings.provider !== 'google'}
							type="button"
							role="tab"
							aria-selected={app.state.settings.provider !== 'google'}
							onclick={() => app.chooseProvider('osm')}>Free / OpenStreetMap</button
						>
						<button
							class:is-active={app.state.settings.provider === 'google'}
							type="button"
							role="tab"
							aria-selected={app.state.settings.provider === 'google'}
							onclick={() => app.chooseProvider('google')}>Google Maps</button
						>
					</div>

					{#if app.state.settings.provider === 'google'}
						<form class="field" onsubmit={submitGoogleKey}>
							<label for="google-key">Google Maps API key</label>
							<div class="input-row">
								<input
									id="google-key"
									name="google-key"
									type="text"
									autocomplete="off"
									spellcheck="false"
									autocapitalize="off"
									placeholder="AIza…"
									value={app.state.settings.googleKey}
								/>
								<button class="btn btn--primary" type="submit">Connect</button>
							</div>
							<p class="field-note">
								Optional. Use a browser key restricted to this site. The OpenStreetMap mode never
								costs anything.
							</p>
						</form>
					{:else}
						<div class="field">
							<label for="basemap-select">Basemap</label>
							<div class="select-wrap">
								<select
									id="basemap-select"
									value={app.state.settings.basemap}
									onchange={(event) => app.setBasemap(event.currentTarget.value)}
								>
									<option value="osm">OpenStreetMap standard</option>
									<option value="osmfr">OSM France soft colour</option>
									<option value="cyclosm">CyclOSM cycle detail</option>
								</select>
								<svg><use href="#i-chevron"></use></svg>
							</div>
							<p class="field-note">
								Free tiles from OpenStreetMap contributors. No account, no key, no billing.
							</p>
						</div>
					{/if}
				</section>

				<section class="settings-section">
					<h3>Exploration</h3>
					<div class="switch-list">
						<label class="switch-row"
							><span><strong>Metric units</strong><small>Metres and kilometres</small></span><input
								type="checkbox"
								checked={app.state.settings.units === 'metric'}
								onchange={(event) =>
									app.setSetting('units', event.currentTarget.checked ? 'metric' : 'imperial')}
							/><i></i></label
						>
						<label class="switch-row"
							><span
								><strong>Survey grid</strong><small>Show the 12 m tile edges you revealed</small
								></span
							><input
								type="checkbox"
								checked={app.state.settings.showGrid}
								onchange={(event) => app.setSetting('showGrid', event.currentTarget.checked)}
							/><i></i></label
						>
						<label class="switch-row"
							><span
								><strong>Repeat visits</strong><small>{app.state.ui.favoriteSummary}</small></span
							><input
								type="checkbox"
								checked={app.state.settings.showFavorites}
								onchange={(event) => app.setSetting('showFavorites', event.currentTarget.checked)}
							/><i></i></label
						>
						<label class="switch-row"
							><span
								><strong>Unlock sound</strong><small>A quiet chime when tiles appear</small></span
							><input
								type="checkbox"
								checked={app.state.settings.sound}
								onchange={(event) => app.setSetting('sound', event.currentTarget.checked)}
							/><i></i></label
						>
						<label class="switch-row"
							><span
								><strong>Haptics</strong><small>Short vibration on unlock, if supported</small
								></span
							><input
								type="checkbox"
								checked={app.state.settings.haptics}
								onchange={(event) => app.setSetting('haptics', event.currentTarget.checked)}
							/><i></i></label
						>
						<label class="switch-row"
							><span
								><strong>Keep screen awake</strong><small>Wake lock while live tracking</small
								></span
							><input
								type="checkbox"
								checked={app.state.settings.wakeLock}
								onchange={(event) => app.setSetting('wakeLock', event.currentTarget.checked)}
							/><i></i></label
						>
						<label class="switch-row"
							><span
								><strong>Auto-start GPS</strong><small>Resume tracking when you open the app</small
								></span
							><input
								type="checkbox"
								checked={app.state.settings.autoTrack}
								onchange={(event) => app.setSetting('autoTrack', event.currentTarget.checked)}
							/><i></i></label
						>
					</div>
				</section>

				<section class="settings-section">
					<h3>Comfort</h3>
					<div class="field">
						<label for="theme-select">Theme</label>
						<div class="select-wrap">
							<select
								id="theme-select"
								value={app.state.settings.theme}
								onchange={(event) => app.setSetting('theme', event.currentTarget.value)}
							>
								<option value="night">Night field</option>
								<option value="paper">Paper field</option>
							</select>
							<svg><use href="#i-chevron"></use></svg>
						</div>
					</div>
					<div class="switch-list">
						<label class="switch-row"
							><span
								><strong>High contrast</strong><small>Stronger lines and brighter labels</small
								></span
							><input
								type="checkbox"
								checked={app.state.settings.highContrast}
								onchange={(event) => app.setSetting('highContrast', event.currentTarget.checked)}
							/><i></i></label
						>
						<label class="switch-row"
							><span
								><strong>Reduce motion</strong><small
									>Stop pulses, flashes and route animation</small
								></span
							><input
								type="checkbox"
								checked={app.state.settings.reduceMotion}
								onchange={(event) => app.setSetting('reduceMotion', event.currentTarget.checked)}
							/><i></i></label
						>
					</div>
				</section>

				<section class="settings-section">
					<h3>Profile &amp; data</h3>
					<div class="segmented" role="tablist" aria-label="Profile">
						<button
							class:is-active={app.state.profile === 'live'}
							type="button"
							role="tab"
							aria-selected={app.state.profile === 'live'}
							onclick={() => app.switchProfile('live')}>Live map</button
						>
						{#if !app.state.cloud.configured || app.state.cloud.status === 'approved'}
							<button
								class:is-active={app.state.profile === 'demo'}
								type="button"
								role="tab"
								aria-selected={app.state.profile === 'demo'}
								onclick={() => app.switchProfile('demo')}>Simulator</button
							>
						{/if}
					</div>
					<p class="field-note">Live progress is unlocked only by real walking GPS.</p>
					<div class="data-actions">
						<button class="btn btn--ghost" type="button" onclick={() => app.downloadBackup()}
							><svg><use href="#i-download"></use></svg><span>Export backup</span></button
						>
						<button class="btn btn--ghost" type="button" onclick={() => fileInput?.click()}
							><svg><use href="#i-upload"></use></svg><span>Restore backup</span></button
						>
						<input
							bind:this={fileInput}
							type="file"
							accept="application/json,.json"
							hidden
							onchange={importFile}
						/>
						<button class="btn btn--danger-ghost" type="button" onclick={() => app.resetProfile()}
							><svg><use href="#i-trash"></use></svg><span>Reset this profile</span></button
						>
						<button class="btn btn--danger-ghost" type="button" onclick={() => app.wipeLocalData()}
							><svg><use href="#i-trash"></use></svg><span>Delete all local data</span></button
						>
					</div>
					<p class="storage-usage">{app.state.ui.storageUsage}</p>
				</section>

				<section class="settings-section">
					<h3>Track archive</h3>
					<p class="field-note">
						Export private GPX or GeoJSON tracks, or load a track as a map overlay. Imported tracks
						never unlock tiles.
					</p>
					<div class="data-actions">
						<button class="btn btn--ghost" type="button" onclick={() => app.exportTracks('gpx')}
							><svg><use href="#i-route"></use></svg><span>Export GPX</span></button
						>
						<button class="btn btn--ghost" type="button" onclick={() => app.exportTracks('geojson')}
							><svg><use href="#i-route"></use></svg><span>Export GeoJSON</span></button
						>
						<button class="btn btn--ghost" type="button" onclick={() => trackInput?.click()}
							><svg><use href="#i-upload"></use></svg><span>Load track overlay</span></button
						>
						<input
							bind:this={trackInput}
							type="file"
							accept=".gpx,.geojson,.json,application/gpx+xml,application/geo+json"
							hidden
							onchange={importTrack}
						/>
					</div>
				</section>

				<section class="settings-section">
					<h3>
						Account and sync
						<span class="cloud-optional">
							{#if !app.state.cloud.configured}
								local
							{:else if app.state.cloud.sample}
								sample
							{:else if app.state.cloud.status === 'approved'}
								synced
							{:else}
								locked
							{/if}
						</span>
					</h3>
					{#if !app.state.cloud.configured}
						<div class="cloud-card">
							<strong>Local-only mode</strong>
							<p class="cloud-status">
								This deployment has no Supabase connection. Progress stays on this device and
								everything works without an account.
							</p>
							<p class="field-note">
								Set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> to turn on accounts,
								approval and cross-device sync.
							</p>
						</div>
					{:else if app.state.cloud.sample}
						<div class="cloud-card">
							<strong>Sample simulator</strong>
							<p class="cloud-status">{app.state.cloud.message}</p>
							<p class="field-note">
								Sample progress is temporary and never uploaded. Sign in to request a permanent,
								approved map.
							</p>
							<div class="cloud-actions">
								<button class="btn btn--primary" type="button" onclick={() => app.exitSample()}
									>{app.state.cloud.status === 'pending' ? 'Check approval' : 'Sign in'}</button
								>
								{#if app.state.cloud.user}
									<button class="btn btn--ghost" type="button" onclick={() => app.signOutCloud()}
										>Sign out</button
									>
								{/if}
							</div>
						</div>
					{:else if app.state.cloud.status === 'checking'}
						<p class="cloud-status">Checking your access…</p>
					{:else if app.state.cloud.status === 'approved' && app.state.cloud.user}
						<div class="cloud-card">
							<div class="cloud-identity">
								<strong>{app.state.cloud.user.email || 'Signed in'}</strong>
								<span class="cloud-badge">
									{app.state.cloud.member?.role === 'admin' ? 'Owner' : 'Approved explorer'}
								</span>
							</div>
							<p class="cloud-status">{app.state.cloud.message}</p>
							{#if app.state.cloud.syncMessage}
								<p class="cloud-sync-state">{app.state.cloud.syncMessage}</p>
							{/if}
							<p class="storage-usage">{savedAtLabel(app.state.cloud.lastSavedAt)}</p>
							<p class="field-note">
								Auto-sync is on. New walks upload a few seconds after each save, and a newer cloud
								copy can be restored on any device.
							</p>
							<div class="cloud-actions">
								<button
									class="btn btn--primary"
									type="button"
									disabled={app.state.cloud.busy || app.state.cloud.syncState === 'saving'}
									onclick={() => app.syncNow()}
									>{app.state.cloud.syncState === 'saving' ? 'Syncing…' : 'Sync now'}</button
								>
								<button
									class="btn btn--ghost"
									type="button"
									disabled={app.state.cloud.busy}
									onclick={() => app.restoreCloud()}>Restore cloud</button
								>
								<button
									class="btn btn--ghost"
									type="button"
									disabled={app.state.cloud.busy}
									onclick={() => app.deleteCloudCopy()}>Delete cloud copy</button
								>
								<button
									class="btn btn--ghost"
									type="button"
									disabled={app.state.cloud.busy}
									onclick={() => app.signOutCloud()}>Sign out</button
								>
							</div>
							<form class="cloud-form" onsubmit={submitCloudPassword}>
								<label for="cloud-password">Change password</label>
								<div class="input-row">
									<input
										id="cloud-password"
										name="cloud-password"
										type="password"
										autocomplete="new-password"
										minlength="8"
										placeholder="At least 8 characters"
										required
									/>
									<button class="btn btn--ghost" type="submit" disabled={app.state.cloud.busy}
										>{app.state.cloud.busy ? 'Saving…' : 'Update'}</button
									>
								</div>
							</form>
						</div>
						{#if app.isAdmin()}
							<div class="cloud-actions">
								<a class="btn btn--ghost" href={resolve('/admin')}>Open owner console</a>
							</div>
							<MemberPanel />
						{/if}
					{:else if app.state.cloud.user}
						<div class="cloud-card">
							<div class="cloud-identity">
								<strong>{app.state.cloud.user.email || 'Signed in'}</strong>
								<span class="cloud-badge">
									{app.state.cloud.status === 'pending'
										? 'Pending'
										: app.state.cloud.status === 'error'
											? 'Check failed'
											: 'Closed'}
								</span>
							</div>
							<p class="cloud-status">{app.state.cloud.message}</p>
							{#if app.state.cloud.status === 'pending'}
								<form class="cloud-form" onsubmit={submitCloudInvite}>
									<label for="cloud-invite">Invite code</label>
									<div class="input-row">
										<input
											id="cloud-invite"
											name="cloud-invite"
											type="text"
											autocomplete="off"
											autocapitalize="characters"
											spellcheck="false"
											placeholder="ABCD1234EFGH"
										/>
										<button
											class="btn btn--primary"
											type="submit"
											disabled={app.state.cloud.inviteBusy}
											>{app.state.cloud.inviteBusy ? 'Checking…' : 'Redeem'}</button
										>
									</div>
								</form>
							{:else if app.state.cloud.status === 'error'}
								<button class="btn btn--ghost" type="button" onclick={() => app.refreshMembership()}
									>Check again</button
								>
							{/if}
							<div class="cloud-actions">
								<button class="btn btn--ghost" type="button" onclick={() => app.signOutCloud()}
									>Sign out</button
								>
							</div>
						</div>
					{:else}
						<p class="cloud-status">{app.state.cloud.message}</p>
						<p class="field-note">
							Sign in or create an account from the MistWalk access screen with email and password.
							No email code or link is sent. The owner must approve new accounts before the map or
							simulator unlocks.
						</p>
					{/if}
				</section>
			</div>
		</div>
	</div>
{/if}

<script lang="ts">
	import { resolve } from '$app/paths';
	import { app } from '#lib/mistwalk.svelte.ts';

	let email = $state(app.state.cloud.email);
	let password = $state('');
	let confirmPassword = $state('');
	let mode = $state<'signin' | 'signup'>('signin');
	let invite = $state('');

	function setMode(next: 'signin' | 'signup') {
		mode = next;
		password = '';
		confirmPassword = '';
		app.state.cloud.message =
			next === 'signup'
				? 'Create an account with email and password. The owner must approve it before the map unlocks.'
				: 'Sign in with your email and password.';
	}

	function submitCredentials(event: SubmitEvent) {
		event.preventDefault();
		if (mode === 'signup') {
			if (password !== confirmPassword) {
				app.state.cloud.message = 'The passwords do not match.';
				return;
			}
			void app.signUpCloud(email, password);
			return;
		}
		void app.signInCloudWithPassword(email, password);
	}

	function submitInvite(event: SubmitEvent) {
		event.preventDefault();
		void app.redeemCloudInvite(invite);
	}
</script>

<div class="access-gate" role="dialog" aria-modal="true" aria-labelledby="access-title">
	<div class="access-card">
		<div class="access-brand">
			<svg aria-hidden="true"><use href="#i-logo"></use></svg>
			<span>MistWalk</span>
		</div>

		{#if app.state.cloud.status === 'checking'}
			<div class="access-state">
				<p class="access-kicker">Private field</p>
				<h1 id="access-title">Checking your access…</h1>
				<p class="access-copy">One moment while this device talks to the owner's cloud.</p>
			</div>
		{:else if app.state.cloud.status === 'pending'}
			<div class="access-state">
				<p class="access-kicker">Request received</p>
				<h1 id="access-title">Waiting for approval.</h1>
				<p class="access-copy">
					The owner has to approve <strong
						>{app.state.cloud.member?.email || app.state.cloud.email}</strong
					>
					before this account can use the map, the simulator, or cloud backup.
				</p>
				<p class="access-message">{app.state.cloud.message}</p>
				<form class="access-form" onsubmit={submitInvite}>
					<label for="access-invite">Have an invite code? It still needs approval.</label>
					<div class="access-row">
						<input
							id="access-invite"
							name="invite"
							type="text"
							autocomplete="off"
							autocapitalize="characters"
							spellcheck="false"
							placeholder="ABCD1234EFGH"
							bind:value={invite}
						/>
						<button class="btn btn--primary" type="submit" disabled={app.state.cloud.inviteBusy}
							>{app.state.cloud.inviteBusy ? 'Checking…' : 'Redeem'}</button
						>
					</div>
				</form>
				<div class="access-actions">
					<button class="btn btn--ghost" type="button" onclick={() => app.refreshMembership()}
						>Check status</button
					>
					<button class="btn btn--ghost" type="button" onclick={() => app.signOutCloud()}
						>Sign out</button
					>
				</div>
			</div>
		{:else if app.state.cloud.status === 'rejected'}
			<div class="access-state">
				<p class="access-kicker">Access closed</p>
				<h1 id="access-title">This account was not approved.</h1>
				<p class="access-copy">
					Ask the owner for access. The map and simulator stay locked until this account is
					approved.
				</p>
				<p class="access-message">{app.state.cloud.message}</p>
				<div class="access-actions">
					<button class="btn btn--ghost" type="button" onclick={() => app.refreshMembership()}
						>Check status</button
					>
					<button class="btn btn--ghost" type="button" onclick={() => app.signOutCloud()}
						>Sign out</button
					>
				</div>
			</div>
		{:else if app.state.cloud.status === 'error' && app.state.cloud.user}
			<div class="access-state">
				<p class="access-kicker">Access check failed</p>
				<h1 id="access-title">Could not verify this account.</h1>
				<p class="access-message access-message--error">{app.state.cloud.message}</p>
				<div class="access-actions">
					<button class="btn btn--ghost" type="button" onclick={() => app.refreshMembership()}
						>Check again</button
					>
					<button class="btn btn--ghost" type="button" onclick={() => app.signOutCloud()}
						>Sign out</button
					>
				</div>
			</div>
		{:else}
			<div class="access-state">
				<p class="access-kicker">Private field</p>
				<h1 id="access-title">
					{mode === 'signup' ? 'Create your account.' : 'Sign in to MistWalk.'}
				</h1>
				<p class="access-copy">
					{#if mode === 'signup'}
						Use an email and password. No email code or link is needed. The owner must approve new
						accounts before the map and simulator unlock.
					{:else}
						Use the email and password for this account. New accounts wait for owner approval before
						the map and simulator unlock.
					{/if}
				</p>

				<div class="segmented access-tabs" role="tablist" aria-label="Account action">
					<button
						class:is-active={mode === 'signin'}
						type="button"
						role="tab"
						aria-selected={mode === 'signin'}
						onclick={() => setMode('signin')}>Sign in</button
					>
					<button
						class:is-active={mode === 'signup'}
						type="button"
						role="tab"
						aria-selected={mode === 'signup'}
						onclick={() => setMode('signup')}>Create account</button
					>
				</div>

				<form class="access-form access-form--stacked" onsubmit={submitCredentials}>
					<label for="access-email">Email</label>
					<input
						id="access-email"
						name="email"
						type="email"
						autocomplete="email"
						spellcheck="false"
						placeholder="you@example.com"
						bind:value={email}
						required
					/>
					<label for="access-password">Password</label>
					<input
						id="access-password"
						name="password"
						type="password"
						autocomplete={mode === 'signup' ? 'new-password' : 'current-password'}
						minlength={mode === 'signup' ? 8 : undefined}
						placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'}
						bind:value={password}
						required
					/>
					{#if mode === 'signup'}
						<label for="access-confirm">Confirm password</label>
						<input
							id="access-confirm"
							name="confirm"
							type="password"
							autocomplete="new-password"
							minlength="8"
							placeholder="Repeat the password"
							bind:value={confirmPassword}
							required
						/>
					{/if}
					<button
						class="btn btn--primary access-submit"
						type="submit"
						disabled={app.state.cloud.busy}
					>
						{app.state.cloud.busy
							? mode === 'signup'
								? 'Creating…'
								: 'Signing in…'
							: mode === 'signup'
								? 'Create account'
								: 'Sign in'}
					</button>
				</form>

				{#if app.state.cloud.message}
					<p class="access-message">{app.state.cloud.message}</p>
				{/if}
				<p class="access-note">
					No email code and no link are sent. Forgotten passwords are reset by the owner. The map
					and simulator stay locked until this account is approved.
					<a href={resolve('/admin')}>Owner console</a>
				</p>
			</div>
		{/if}
	</div>
</div>

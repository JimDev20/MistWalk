<script lang="ts">
	import { resolve } from '$app/paths';
	import { app } from '#lib/mistwalk.svelte.ts';

	let email = $state('');
	let code = $state('');
	let invite = $state('');

	function submitEmail(event: SubmitEvent) {
		event.preventDefault();
		void app.sendCloudCode(email || app.state.cloud.email);
	}

	function submitCode(event: SubmitEvent) {
		event.preventDefault();
		void app.verifyCloudCode(code);
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
		{:else}
			<div class="access-state">
				<p class="access-kicker">Invite-only map</p>
				<h1 id="access-title">Sign in to request access.</h1>
				<p class="access-copy">
					MistWalk is private for approved explorers. Sign in with your email and wait for the owner
					to approve this account. The map and simulator stay locked until then.
				</p>

				{#if app.state.cloud.status === 'error'}
					<p class="access-message access-message--error">{app.state.cloud.message}</p>
					<div class="access-actions">
						<button class="btn btn--ghost" type="button" onclick={() => app.refreshMembership()}
							>Check again</button
						>
						{#if app.state.cloud.user}
							<button class="btn btn--ghost" type="button" onclick={() => app.signOutCloud()}
								>Sign out</button
							>
						{/if}
					</div>
				{:else if app.state.cloud.step === 'email'}
					<form class="access-form" onsubmit={submitEmail}>
						<label for="access-email">Email</label>
						<div class="access-row">
							<input
								id="access-email"
								name="email"
								type="email"
								autocomplete="email"
								placeholder="you@example.com"
								bind:value={email}
								required
							/>
							<button class="btn btn--primary" type="submit" disabled={app.state.cloud.busy}
								>{app.state.cloud.busy ? 'Sending…' : 'Send code'}</button
							>
						</div>
					</form>
				{:else}
					<form class="access-form" onsubmit={submitCode}>
						<label for="access-code">Code sent to {app.state.cloud.email}</label>
						<div class="access-row">
							<input
								id="access-code"
								name="code"
								type="text"
								inputmode="numeric"
								autocomplete="one-time-code"
								autocapitalize="off"
								spellcheck="false"
								placeholder="123456"
								bind:value={code}
								required
							/>
							<button class="btn btn--primary" type="submit" disabled={app.state.cloud.busy}
								>{app.state.cloud.busy ? 'Checking…' : 'Sign in'}</button
							>
						</div>
					</form>
					<div class="access-small-actions">
						<button
							class="micro-link"
							type="button"
							onclick={() => app.sendCloudCode(app.state.cloud.email)}>Resend code</button
						>
						<button class="micro-link" type="button" onclick={() => app.backToEmailStep()}
							>Use a different email</button
						>
					</div>
				{/if}

				{#if app.state.cloud.status !== 'error' && app.state.cloud.message}
					<p class="access-message">{app.state.cloud.message}</p>
				{/if}
				<p class="access-note">
					Sign-in sends a 6-digit code by email; there is no link to click. The map and simulator
					stay locked until the owner approves this account. Supabase's built-in email only reaches
					project team addresses, so invited explorers need custom SMTP.
				</p>
			</div>
		{/if}
		<p class="access-owner-link">
			Owner? <a href={resolve('/admin')}>Open the admin portal</a>
		</p>
	</div>
</div>

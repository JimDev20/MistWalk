<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import type { MemberRecord, MemberStatus } from '#lib/types.ts';
	import {
		cloudConfigured,
		cloudSignOut,
		createInviteCode,
		fetchMembers,
		fetchMembership,
		getCloudUser,
		setMemberStatus
	} from '#lib/cloud.ts';

	type Phase = 'loading' | 'unconfigured' | 'checking' | 'admin' | 'denied' | 'error';

	let phase = $state<Phase>('loading');
	let email = $state('');
	let message = $state('');
	let me = $state<MemberRecord | null>(null);
	let members = $state<MemberRecord[]>([]);
	let membersBusy = $state(false);
	let busyMember = $state<string | null>(null);
	let lastRefresh = $state(0);
	let inviteCode = $state('');
	let inviteBusy = $state(false);
	let filter = $state<'pending' | 'all'>('pending');
	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	let pending = $derived(members.filter((member) => member.status === 'pending'));
	let approved = $derived(members.filter((member) => member.status === 'approved'));
	let rejected = $derived(members.filter((member) => member.status === 'rejected'));
	let visible = $derived(filter === 'pending' ? pending : members);

	function errorText(err: unknown): string {
		return err instanceof Error && err.message ? err.message : 'Something went wrong.';
	}

	function joined(value: string | null): string {
		return value ? new Date(value).toLocaleDateString() : '';
	}

	function timeLabel(value: number): string {
		return value ? new Date(value).toLocaleTimeString() : 'not yet';
	}

	async function boot(): Promise<void> {
		if (!cloudConfigured) {
			phase = 'unconfigured';
			return;
		}
		try {
			const user = await getCloudUser();
			if (!user) {
				await goto(resolve('/'));
				return;
			}
			await checkAdmin(user.email || '');
		} catch (err) {
			phase = 'error';
			message = errorText(err);
		}
	}

	async function checkAdmin(userEmail: string): Promise<void> {
		phase = 'checking';
		message = '';
		try {
			const row = await fetchMembership();
			me = row;
			email = userEmail || row?.email || '';
			if (!row || row.role !== 'admin') {
				await goto(resolve('/'));
				return;
			}
			if (row.status !== 'approved') {
				phase = 'denied';
				message = 'This owner account is not approved. Promote it from the SQL editor.';
				return;
			}
			phase = 'admin';
			await loadMembers();
			startRefresh();
		} catch (err) {
			phase = 'error';
			message = errorText(err);
		}
	}

	async function loadMembers(silent = false): Promise<void> {
		if (!silent) membersBusy = true;
		try {
			members = await fetchMembers();
			lastRefresh = Date.now();
			message = '';
		} catch (err) {
			message = errorText(err);
		} finally {
			if (!silent) membersBusy = false;
		}
	}

	async function decide(member: MemberRecord, status: MemberStatus): Promise<void> {
		if (
			status === 'rejected' &&
			!window.confirm(`Reject ${member.email || member.user_id}? They will be locked out.`)
		) {
			return;
		}
		busyMember = member.user_id;
		message = '';
		try {
			await setMemberStatus(member.user_id, status);
			await loadMembers(true);
		} catch (err) {
			message = errorText(err);
		} finally {
			busyMember = null;
		}
	}

	async function makeInvite(): Promise<void> {
		inviteBusy = true;
		message = '';
		try {
			inviteCode = await createInviteCode(7);
		} catch (err) {
			message = errorText(err);
		} finally {
			inviteBusy = false;
		}
	}

	async function copyInvite(): Promise<void> {
		if (!inviteCode) return;
		if (!navigator.clipboard?.writeText) {
			message = `Invite code: ${inviteCode}`;
			return;
		}
		try {
			await navigator.clipboard.writeText(inviteCode);
			message = 'Invite code copied.';
		} catch {
			message = `Invite code: ${inviteCode}`;
		}
	}

	async function signOut(): Promise<void> {
		try {
			await cloudSignOut();
		} catch (err) {
			message = errorText(err);
			return;
		}
		stopRefresh();
		me = null;
		members = [];
		await goto(resolve('/'));
	}

	function startRefresh(): void {
		stopRefresh();
		refreshTimer = setInterval(() => {
			if (phase === 'admin' && !membersBusy) void loadMembers(true);
		}, 30_000);
	}

	function stopRefresh(): void {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = null;
	}

	function filterLabel(count: number): string {
		return count === 1 ? '1 account' : `${count} accounts`;
	}

	onMount(() => {
		void boot();
		return () => stopRefresh();
	});
</script>

<svelte:head>
	<title>MistWalk · Owner Console</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="admin-page">
	<header class="admin-topbar">
		<a class="admin-brand" href={resolve('/')}>
			<span class="admin-brand-mark">M</span>
			<span>
				<strong>MistWalk</strong>
				<small>Owner console</small>
			</span>
		</a>
		<nav class="admin-top-actions" aria-label="Owner console actions">
			<a class="btn btn--ghost btn--small" href={resolve('/')}>Open map</a>
			{#if phase === 'admin'}
				<button class="btn btn--ghost btn--small" type="button" onclick={signOut}>Sign out</button>
			{/if}
		</nav>
	</header>

	<main class="admin-main">
		{#if phase === 'loading' || phase === 'checking'}
			<section class="admin-card admin-card--narrow">
				<p class="admin-kicker">Owner console</p>
				<h1>Checking your access…</h1>
				<p class="admin-copy">One moment while this device talks to the MistWalk cloud.</p>
			</section>
		{:else if phase === 'unconfigured'}
			<section class="admin-card admin-card--narrow">
				<p class="admin-kicker">Owner console</p>
				<h1>Supabase is not configured.</h1>
				<p class="admin-copy">
					Add <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> to the deployment, then reload
					this page.
				</p>
				<a class="btn btn--primary admin-link-button" href={resolve('/')}>Back to MistWalk</a>
			</section>
		{:else if phase === 'denied'}
			<section class="admin-card admin-card--narrow">
				<p class="admin-kicker">Owner console</p>
				<h1>Owner access paused.</h1>
				<p class="admin-copy">{message}</p>
				<p class="admin-note">
					Promote the owner once from the Supabase SQL editor:
					<code>select public.mistwalk_promote_admin('you@example.com');</code>
				</p>
				<div class="admin-inline-actions">
					<button class="btn btn--ghost" type="button" onclick={signOut}>Sign out</button>
					<a class="btn btn--ghost" href={resolve('/')}>Back to MistWalk</a>
				</div>
			</section>
		{:else if phase === 'error'}
			<section class="admin-card admin-card--narrow">
				<p class="admin-kicker">Owner console</p>
				<h1>Could not open the console.</h1>
				<p class="admin-message" aria-live="polite">{message}</p>
				<div class="admin-inline-actions">
					<button class="btn btn--primary" type="button" onclick={boot}>Try again</button>
					<a class="btn btn--ghost" href={resolve('/')}>Back to MistWalk</a>
				</div>
			</section>
		{:else}
			<section class="admin-heading">
				<div>
					<p class="admin-kicker">Owner console</p>
					<h1>Access requests</h1>
					<p class="admin-copy">
						Signed in as <strong>{me?.email || email}</strong>. Approving unlocks the map and
						simulator for that account.
					</p>
				</div>
				<div class="admin-heading-actions">
					<span class="admin-refresh">Refreshed {timeLabel(lastRefresh)}</span>
					<button
						class="btn btn--ghost btn--small"
						type="button"
						disabled={membersBusy}
						onclick={() => loadMembers()}>{membersBusy ? 'Refreshing…' : 'Refresh'}</button
					>
				</div>
			</section>

			<div class="admin-stats">
				<div class="admin-stat">
					<span>Waiting</span>
					<strong>{pending.length}</strong>
				</div>
				<div class="admin-stat">
					<span>Approved</span>
					<strong>{approved.length}</strong>
				</div>
				<div class="admin-stat">
					<span>Rejected</span>
					<strong>{rejected.length}</strong>
				</div>
			</div>

			{#if message}
				<p class="admin-message" aria-live="polite">{message}</p>
			{/if}

			<section class="admin-card">
				<div class="admin-toolbar">
					<div class="segmented" role="tablist" aria-label="Filter accounts">
						<button
							class:is-active={filter === 'pending'}
							type="button"
							role="tab"
							aria-selected={filter === 'pending'}
							onclick={() => (filter = 'pending')}>Waiting ({pending.length})</button
						>
						<button
							class:is-active={filter === 'all'}
							type="button"
							role="tab"
							aria-selected={filter === 'all'}
							onclick={() => (filter = 'all')}>All accounts</button
						>
					</div>
					<span class="admin-count">{filterLabel(visible.length)}</span>
				</div>

				{#if membersBusy && members.length === 0}
					<p class="admin-empty">Loading accounts…</p>
				{:else if visible.length === 0}
					<p class="admin-empty">
						{filter === 'pending'
							? 'No requests waiting. New sign-ins will appear here.'
							: 'No accounts yet.'}
					</p>
				{:else}
					<ul class="admin-member-list">
						{#each visible as account (account.user_id)}
							<li class="admin-member" class:admin-member--pending={account.status === 'pending'}>
								<div class="admin-member-main">
									<div class="admin-member-identity">
										<strong>{account.email || account.user_id}</strong>
										<span>
											{account.status}
											{#if account.role === 'admin'}· owner{/if}
											{#if joined(account.created_at)}· joined {joined(account.created_at)}{/if}
										</span>
									</div>
									<div class="admin-member-actions">
										{#if account.user_id === me?.user_id}
											<span class="admin-self">This is you</span>
										{:else if account.status === 'pending'}
											<button
												class="btn btn--primary btn--small"
												type="button"
												disabled={busyMember === account.user_id}
												onclick={() => decide(account, 'approved')}>Approve</button
											>
											<button
												class="btn btn--danger-ghost btn--small"
												type="button"
												disabled={busyMember === account.user_id}
												onclick={() => decide(account, 'rejected')}>Reject</button
											>
										{:else if account.status === 'approved'}
											<button
												class="btn btn--ghost btn--small"
												type="button"
												disabled={busyMember === account.user_id}
												onclick={() => decide(account, 'rejected')}>Revoke</button
											>
										{:else}
											<button
												class="btn btn--primary btn--small"
												type="button"
												disabled={busyMember === account.user_id}
												onclick={() => decide(account, 'approved')}>Approve</button
											>
										{/if}
									</div>
								</div>
								{#if account.decided_at}
									<p class="admin-member-meta">
										Last decision {joined(account.decided_at)}
									</p>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="admin-card admin-invites">
				<div>
					<p class="admin-kicker">Optional</p>
					<h2>Invite codes</h2>
					<p class="admin-copy">
						An invite code marks a request as invited, but it never grants access by itself. Every
						account still needs your approval.
					</p>
				</div>
				<div class="admin-invite-actions">
					<button
						class="btn btn--ghost btn--small"
						type="button"
						disabled={inviteBusy}
						onclick={makeInvite}>{inviteBusy ? 'Creating…' : 'Create invite'}</button
					>
					{#if inviteCode}
						<code class="invite-code">{inviteCode}</code>
						<button class="micro-link" type="button" onclick={copyInvite}>Copy</button>
					{/if}
				</div>
			</section>
		{/if}
	</main>
</div>

<style>
	.admin-page {
		min-height: 100dvh;
		padding: 22px clamp(16px, 4vw, 36px) 80px;
		background:
			radial-gradient(circle at 78% 8%, rgba(34, 211, 238, 0.08), transparent 34%),
			radial-gradient(circle at 8% 92%, rgba(56, 189, 248, 0.05), transparent 30%), var(--bg);
		color: var(--ink);
	}

	.admin-topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		width: min(1120px, 100%);
		margin: 0 auto;
		padding-bottom: 18px;
		border-bottom: 1px solid var(--line);
	}

	.admin-brand {
		display: inline-flex;
		align-items: center;
		gap: 11px;
		color: var(--ink);
		text-decoration: none;
	}

	.admin-brand-mark {
		display: grid;
		place-items: center;
		width: 38px;
		height: 38px;
		border: 1px solid rgba(103, 232, 249, 0.38);
		border-radius: 11px;
		background: rgba(8, 20, 31, 0.82);
		color: var(--accent);
		font-family: var(--display);
		font-size: 19px;
		font-weight: 600;
	}

	.admin-brand strong,
	.admin-brand small {
		display: block;
	}

	.admin-brand strong {
		font-family: var(--display);
		font-size: 17px;
		font-weight: 600;
		letter-spacing: 0.2em;
	}

	.admin-brand small {
		margin-top: 2px;
		color: var(--muted-2);
		font-family: var(--mono);
		font-size: 8px;
		letter-spacing: 0.16em;
		text-transform: uppercase;
	}

	.admin-top-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.admin-main {
		width: min(1120px, 100%);
		margin: 0 auto;
		padding-top: 30px;
	}

	.admin-card {
		padding: clamp(18px, 3vw, 28px);
		border: 1px solid var(--line-strong);
		border-radius: 13px;
		background: var(--panel);
		box-shadow: 0 16px 46px rgba(0, 0, 0, 0.28);
	}

	.admin-card--narrow {
		width: min(560px, 100%);
		margin: 7vh auto 0;
		padding: clamp(24px, 4vw, 38px);
	}

	.admin-kicker {
		margin: 0 0 10px;
		color: var(--accent);
		font-family: var(--mono);
		font-size: 9px;
		letter-spacing: 0.2em;
		text-transform: uppercase;
	}

	.admin-card h1,
	.admin-heading h1,
	.admin-invites h2 {
		margin: 0;
		color: var(--ink);
		font-family: var(--display);
		font-weight: 500;
		line-height: 1.08;
		letter-spacing: -0.02em;
	}

	.admin-card h1,
	.admin-heading h1 {
		font-size: clamp(28px, 4vw, 40px);
	}

	.admin-invites h2 {
		font-size: 22px;
	}

	.admin-copy {
		margin: 13px 0 0;
		color: var(--muted);
		font-size: 13px;
		line-height: 1.65;
	}

	.admin-copy strong {
		color: var(--ink-2);
		font-weight: 500;
		overflow-wrap: anywhere;
	}

	.admin-copy code,
	.admin-note code {
		color: var(--accent);
		font-family: var(--mono);
		font-size: 0.94em;
	}

	.admin-inline-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 14px;
		margin-top: 14px;
	}

	.admin-message {
		margin: 16px 0 0;
		padding: 10px 12px;
		border-left: 2px solid var(--line-strong);
		background: var(--bg-2);
		color: var(--muted);
		font-size: 11px;
		line-height: 1.6;
		overflow-wrap: anywhere;
	}

	.admin-message:empty {
		display: none;
	}

	.admin-note {
		margin: 14px 0 0;
		padding-top: 14px;
		border-top: 1px solid var(--line);
		color: var(--muted-2);
		font-size: 10px;
		line-height: 1.6;
	}

	.admin-link-button {
		margin-top: 18px;
	}

	.admin-heading {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 18px;
	}

	.admin-heading-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
	}

	.admin-refresh {
		color: var(--muted-2);
		font-family: var(--mono);
		font-size: 9px;
		letter-spacing: 0.06em;
	}

	.admin-stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
		margin-bottom: 18px;
	}

	.admin-stat {
		padding: 14px 16px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--panel-2);
	}

	.admin-stat span,
	.admin-stat strong {
		display: block;
	}

	.admin-stat span {
		color: var(--muted-2);
		font-family: var(--mono);
		font-size: 8px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	.admin-stat strong {
		margin-top: 4px;
		color: var(--ink);
		font-family: var(--display);
		font-size: 28px;
		font-weight: 500;
	}

	.admin-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding-bottom: 16px;
		border-bottom: 1px solid var(--line);
	}

	.admin-count {
		color: var(--muted-2);
		font-family: var(--mono);
		font-size: 9px;
		letter-spacing: 0.06em;
	}

	.admin-empty {
		margin: 18px 0 0;
		color: var(--muted-2);
		font-size: 12px;
	}

	.admin-member-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 16px 0 0;
		padding: 0;
		list-style: none;
	}

	.admin-member {
		padding: 12px 13px;
		border: 1px solid var(--line);
		border-radius: 9px;
		background: var(--bg-2);
	}

	.admin-member--pending {
		border-color: rgba(251, 191, 36, 0.24);
	}

	.admin-member-main {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.admin-member-identity {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.admin-member-identity strong {
		overflow: hidden;
		color: var(--ink-2);
		font-size: 12px;
		font-weight: 500;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.admin-member-identity span {
		color: var(--muted-2);
		font-size: 10px;
	}

	.admin-member-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.admin-self {
		color: var(--muted-2);
		font-family: var(--mono);
		font-size: 9px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.admin-member-meta {
		margin: 9px 0 0;
		padding-top: 8px;
		border-top: 1px solid var(--line);
		color: var(--muted-2);
		font-size: 9px;
	}

	.admin-invites {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 18px;
		margin-top: 18px;
	}

	.admin-invites > div:first-child {
		flex: 1 1 360px;
	}

	.admin-invite-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	@media (max-width: 640px) {
		.admin-page {
			padding: 14px 12px 60px;
		}

		.admin-topbar {
			align-items: flex-start;
		}

		.admin-card--narrow {
			margin-top: 3vh;
			padding: 24px 18px;
		}

		.admin-stats {
			grid-template-columns: 1fr;
		}

		.admin-member-main {
			align-items: flex-start;
			flex-direction: column;
		}

		.admin-member-actions {
			width: 100%;
		}

		.admin-member-actions .btn {
			flex: 1;
		}
	}

	@media (max-width: 640px) {
		.admin-page {
			padding: calc(14px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right))
				calc(60px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left));
		}

		.admin-topbar {
			flex-wrap: wrap;
			gap: 10px;
		}

		.admin-top-actions {
			width: 100%;
		}

		.admin-top-actions .btn {
			min-height: 44px;
			flex: 1 1 auto;
		}

		.admin-brand strong {
			font-size: 15px;
			letter-spacing: 0.14em;
		}

		.admin-main {
			padding-top: 20px;
		}

		.admin-card {
			padding: 18px 14px;
		}

		.admin-card h1 {
			font-size: clamp(26px, 8vw, 34px);
			line-height: 1.05;
		}

		.admin-toolbar {
			flex-direction: column;
			align-items: flex-start;
			gap: 10px;
		}

		.admin-toolbar .segmented {
			width: 100%;
		}

		.admin-toolbar .segmented button {
			min-height: 44px;
			flex: 1;
		}

		.admin-invites {
			gap: 12px;
		}

		.admin-invites > div:first-child {
			flex-basis: 100%;
		}

		.admin-invite-actions {
			width: 100%;
		}

		.admin-invite-actions .btn {
			min-height: 44px;
			flex: 1 1 140px;
		}

		.admin-member-main {
			gap: 10px;
		}

		.admin-member-actions .btn {
			min-height: 44px;
		}
	}

	@media (max-width: 380px) {
		.admin-page {
			padding-right: calc(10px + env(safe-area-inset-right));
			padding-left: calc(10px + env(safe-area-inset-left));
		}

		.admin-brand strong {
			font-size: 14px;
		}

		.admin-card {
			padding: 16px 12px;
		}
	}
</style>

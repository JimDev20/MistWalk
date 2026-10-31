<script lang="ts">
	import { onMount } from 'svelte';
	import { app } from '#lib/mistwalk.svelte.ts';
	import type { MemberRecord } from '#lib/types.ts';

	onMount(() => {
		void app.loadMembers();
	});

	let pending = $derived(
		app.state.cloud.members.filter((member: MemberRecord) => member.status === 'pending')
	);
	let approved = $derived(
		app.state.cloud.members.filter((member: MemberRecord) => member.status === 'approved')
	);
	let rejected = $derived(
		app.state.cloud.members.filter((member: MemberRecord) => member.status === 'rejected')
	);

	function joined(member: MemberRecord): string {
		return member.created_at ? new Date(member.created_at).toLocaleDateString() : '';
	}
</script>

<div class="cloud-admin">
	<div class="settings-header">
		<h3>Explorer access</h3>
		<button class="micro-link" type="button" onclick={() => app.loadMembers()}>Refresh</button>
	</div>
	<p class="field-note">
		Only the owner sees this panel. Approve people you trust; everyone else can use the sample
		simulator.
	</p>

	{#if app.state.cloud.membersBusy}
		<p class="cloud-status">Loading explorers…</p>
	{/if}

	<section class="member-group">
		<h4>Waiting for approval <span class="member-count">{pending.length}</span></h4>
		{#if pending.length === 0}
			<p class="member-empty">No requests waiting.</p>
		{:else}
			<ul class="member-list">
				{#each pending as member (member.user_id)}
					<li class="member-card">
						<div class="member-identity">
							<strong>{member.email || member.user_id}</strong>
							<span>Requested {joined(member)}</span>
						</div>
						<div class="member-actions">
							<button
								class="btn btn--small btn--primary"
								type="button"
								disabled={app.state.cloud.membersBusy}
								onclick={() => app.decideMember(member.user_id, 'approved')}>Approve</button
							>
							<button
								class="btn btn--small btn--ghost"
								type="button"
								disabled={app.state.cloud.membersBusy}
								onclick={() => app.decideMember(member.user_id, 'rejected')}>Reject</button
							>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="member-group">
		<h4>Approved <span class="member-count">{approved.length}</span></h4>
		{#if approved.length === 0}
			<p class="member-empty">No approved explorers yet.</p>
		{:else}
			<ul class="member-list">
				{#each approved as member (member.user_id)}
					<li class="member-card">
						<div class="member-identity">
							<strong>{member.email || member.user_id}</strong>
							<span>
								{member.role === 'admin' ? 'Owner' : 'Explorer'}
								{#if joined(member)}
									· joined {joined(member)}{/if}
							</span>
						</div>
						{#if member.role !== 'admin'}
							<div class="member-actions">
								<button
									class="btn btn--small btn--ghost"
									type="button"
									disabled={app.state.cloud.membersBusy}
									onclick={() => app.decideMember(member.user_id, 'rejected')}>Revoke</button
								>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if rejected.length > 0}
		<section class="member-group">
			<h4>Closed <span class="member-count">{rejected.length}</span></h4>
			<ul class="member-list">
				{#each rejected as member (member.user_id)}
					<li class="member-card">
						<div class="member-identity">
							<strong>{member.email || member.user_id}</strong>
							<span>Access revoked</span>
						</div>
						<div class="member-actions">
							<button
								class="btn btn--small btn--ghost"
								type="button"
								disabled={app.state.cloud.membersBusy}
								onclick={() => app.decideMember(member.user_id, 'approved')}>Approve</button
							>
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<section class="member-group">
		<h4>Invite codes</h4>
		<p class="field-note">An invite skips the approval queue. Codes expire after 7 days.</p>
		<div class="invite-row">
			<button
				class="btn btn--small btn--ghost"
				type="button"
				disabled={app.state.cloud.inviteBusy}
				onclick={() => app.makeInvite()}
				>{app.state.cloud.inviteBusy ? 'Creating…' : 'Create invite'}</button
			>
			{#if app.state.cloud.inviteCode}
				<code class="invite-code">{app.state.cloud.inviteCode}</code>
				<button class="micro-link" type="button" onclick={() => app.copyInvite()}>Copy</button>
			{/if}
		</div>
	</section>
</div>

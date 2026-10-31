<script lang="ts">
	import { app } from '#lib/mistwalk.svelte.ts';
	import type { SearchResult } from '#lib/types.ts';

	let query = $state('');

	function submit(event: SubmitEvent) {
		event.preventDefault();
		void app.runSearch(query);
	}

	function title(result: SearchResult) {
		return result.display_name?.split(',')[0] || result.name || 'Place';
	}
</script>

{#if app.state.modal === 'search-modal'}
	<div
		class="modal"
		id="search-modal"
		role="dialog"
		aria-modal="true"
		aria-labelledby="search-title"
	>
		<div class="modal-card modal-card--search">
			<header class="modal-head">
				<div><h2 id="search-title">Find a place</h2></div>
				<button
					class="icon-btn modal-close"
					type="button"
					aria-label="Close search"
					onclick={() => app.closeModal('search-modal')}
					><svg><use href="#i-close"></use></svg></button
				>
			</header>
			<div class="modal-body">
				<form class="search-form" onsubmit={submit}>
					<svg><use href="#i-search"></use></svg>
					<input
						bind:value={query}
						type="search"
						placeholder="City, street, landmark…"
						autocomplete="off"
						enterkeyhint="search"
					/>
					<button class="btn btn--primary" type="submit" disabled={app.state.search.loading}
						>Search</button
					>
				</form>
				<p class="field-note search-note">
					Search moves the view only. It never unlocks tiles. Results © OpenStreetMap contributors.
				</p>
				<div class="search-results">
					{#if app.state.search.loading}
						<div class="search-loading">SEARCHING THE FREE MAP…</div>
					{:else if app.state.search.error}
						<div class="search-empty"><p>{app.state.search.error}</p></div>
					{:else if app.state.search.results.length}
						{#each app.state.search.results as result, index (result.place_id || `${result.lat}-${result.lon}`)}
							<button
								class="search-result"
								type="button"
								onclick={() => app.goToSearchResult(result)}
							>
								<span class="search-result-icon">{String(index + 1).padStart(2, '0')}</span>
								<span class="search-result-copy">
									<strong>{title(result)}</strong>
									<small>{result.display_name}</small>
								</span>
							</button>
						{/each}
					{:else}
						<div class="search-empty">
							<p>Search your neighbourhood, then walk it in the simulator.</p>
						</div>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}

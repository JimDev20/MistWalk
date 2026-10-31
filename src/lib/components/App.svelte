<script lang="ts">
	import { app } from '#lib/mistwalk.svelte.ts';
	import AccessGate from './AccessGate.svelte';
	import BootScreen from './BootScreen.svelte';
	import GpsModal from './GpsModal.svelte';
	import HelpModal from './HelpModal.svelte';
	import Hud from './Hud.svelte';
	import JourneyModal from './JourneyModal.svelte';
	import MapControls from './MapControls.svelte';
	import MapView from './MapView.svelte';
	import Onboarding from './Onboarding.svelte';
	import PositionCard from './PositionCard.svelte';
	import ReplayPanel from './ReplayPanel.svelte';
	import SampleBanner from './SampleBanner.svelte';
	import SearchModal from './SearchModal.svelte';
	import SettingsModal from './SettingsModal.svelte';
	import SimPanel from './SimPanel.svelte';
	import SvgDefs from './SvgDefs.svelte';
	import Toasts from './Toasts.svelte';
	import TopBar from './TopBar.svelte';
	import UnlockFlash from './UnlockFlash.svelte';
</script>

<SvgDefs />

<div class="app">
	<MapView />
	<TopBar />
	<Hud />
	<PositionCard />
	<MapControls />
	<SimPanel />
	<ReplayPanel />
	<Toasts />
	<UnlockFlash />

	{#if app.state.cloud.sample}
		<SampleBanner />
	{/if}

	{#if app.state.onboarding}
		<Onboarding />
	{/if}

	{#if app.state.modal}
		<button
			class="scrim"
			type="button"
			aria-label="Close dialog"
			onclick={() => app.closeAllModals()}
		></button>
	{/if}

	<SettingsModal />
	<HelpModal />
	<SearchModal />
	<GpsModal />
	<JourneyModal />

	{#if app.accessGateVisible()}
		<AccessGate />
	{/if}
</div>

<BootScreen />

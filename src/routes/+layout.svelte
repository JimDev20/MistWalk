<script lang="ts">
	import 'leaflet/dist/leaflet.css';
	import '../app.css';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

{@render children()}

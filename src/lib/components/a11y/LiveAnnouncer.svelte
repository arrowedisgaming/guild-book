<script lang="ts">
	import { announcement } from '$lib/stores/announcer';
</script>

<div class="sr-only" aria-live="polite" aria-atomic="true">{$announcement}</div>

<style>
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>

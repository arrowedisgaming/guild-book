import adapterAuto from '@sveltejs/adapter-auto';
import adapterNode from '@sveltejs/adapter-node';
import adapterCloudflare from '@sveltejs/adapter-cloudflare';

const adapterName = process.env.ADAPTER;

function getAdapter() {
	if (adapterName === 'node') return adapterNode({ out: 'build' });
	if (adapterName === 'cloudflare') return adapterCloudflare();
	return adapterAuto();
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: getAdapter(),
		alias: {
			$components: 'src/lib/components'
		}
	}
};

export default config;

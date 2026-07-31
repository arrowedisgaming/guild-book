import { createWriteStream, mkdirSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { spawn } from 'node:child_process';

mkdirSync('test-results', { recursive: true });
const output = createWriteStream('test-results/playwright-output.log', { flags: 'w' });
const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(executable, ['playwright', 'test', ...process.argv.slice(2)], {
	stdio: ['inherit', 'pipe', 'pipe'],
	env: process.env
});

child.stdout.on('data', (chunk) => {
	process.stdout.write(chunk);
	output.write(chunk);
});
child.stderr.on('data', (chunk) => {
	process.stderr.write(chunk);
	output.write(chunk);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => child.kill(signal));
}

const exitCode = await new Promise((resolve) => {
	child.once('error', (cause) => {
		const message = `${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`;
		process.stderr.write(message);
		output.write(message);
		resolve(1);
	});
	child.once('close', (code) => resolve(code ?? 1));
});

output.end();
await finished(output);
process.exitCode = exitCode;

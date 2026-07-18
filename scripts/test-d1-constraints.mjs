import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const suffix = randomUUID();
const ids = {
	owner: `owner-${suffix}`,
	playerA: `player-a-${suffix}`,
	playerB: `player-b-${suffix}`,
	campaign: `campaign-${suffix}`,
	membershipA: `membership-a-${suffix}`,
	membershipB: `membership-b-${suffix}`,
	characterA: `character-a-${suffix}`,
	characterB: `character-b-${suffix}`,
	tenure: `tenure-${suffix}`
};

execute(
	[
		`INSERT INTO users (id) VALUES ('${ids.owner}'), ('${ids.playerA}'), ('${ids.playerB}');`,
		`INSERT INTO campaigns (id, owner_user_id, name, description, created_at, updated_at) VALUES ('${ids.campaign}', '${ids.owner}', 'D1 Constraint Smoke', '', 100, 100);`,
		`INSERT INTO characters (id, user_id, data, created_at, updated_at) VALUES ('${ids.characterA}', '${ids.playerA}', '{}', 100, 100), ('${ids.characterB}', '${ids.playerA}', '{}', 100, 100);`,
		`INSERT INTO campaign_members (id, campaign_id, user_id, joined_at) VALUES ('${ids.membershipA}', '${ids.campaign}', '${ids.playerA}', 100), ('${ids.membershipB}', '${ids.campaign}', '${ids.playerB}', 100);`,
		`INSERT INTO campaign_adventurer_tenures (id, campaign_id, membership_id, character_id, started_at, started_by_user_id) VALUES ('${ids.tenure}', '${ids.campaign}', '${ids.membershipA}', '${ids.characterA}', 100, '${ids.owner}');`
	].join('\n')
);

expectConstraintFailure(
	`INSERT INTO campaign_members (id, campaign_id, user_id, joined_at) VALUES ('membership-duplicate-${suffix}', '${ids.campaign}', '${ids.playerA}', 100);`,
	'active campaign membership'
);
expectConstraintFailure(
	`INSERT INTO campaign_adventurer_tenures (id, campaign_id, membership_id, character_id, started_at, started_by_user_id) VALUES ('tenure-character-duplicate-${suffix}', '${ids.campaign}', '${ids.membershipB}', '${ids.characterA}', 100, '${ids.owner}');`,
	'active character tenure'
);
expectConstraintFailure(
	`INSERT INTO campaign_adventurer_tenures (id, campaign_id, membership_id, character_id, started_at, started_by_user_id) VALUES ('tenure-membership-duplicate-${suffix}', '${ids.campaign}', '${ids.membershipA}', '${ids.characterB}', 100, '${ids.owner}');`,
	'active membership tenure'
);

cleanup();
console.log('Local D1 campaign constraint smoke passed.');

function expectConstraintFailure(sql, label) {
	const result = runWrangler(sql);
	if (result.status === 0) {
		throw new Error(`Expected ${label} insert to fail, but it succeeded.`);
	}
	if (!`${result.stdout}\n${result.stderr}`.toLowerCase().includes('unique')) {
		throw new Error(`Expected ${label} to fail with a unique constraint.\n${result.stderr}`);
	}
}

function execute(sql) {
	const result = runWrangler(sql);
	if (result.status !== 0) {
		throw new Error(`Could not seed local D1 constraint fixture.\n${result.stdout}\n${result.stderr}`);
	}
}

function cleanup() {
	execute(
		[
			`DELETE FROM campaigns WHERE id = '${ids.campaign}';`,
			`DELETE FROM characters WHERE id IN ('${ids.characterA}', '${ids.characterB}');`,
			`DELETE FROM users WHERE id IN ('${ids.owner}', '${ids.playerA}', '${ids.playerB}');`
		].join('\n')
	);
}

function runWrangler(sql) {
	return spawnSync(
		process.platform === 'win32' ? 'npx.cmd' : 'npx',
		['wrangler', 'd1', 'execute', 'guild-book-db', '--local', '--command', sql],
		{ encoding: 'utf8' }
	);
}

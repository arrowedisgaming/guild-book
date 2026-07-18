import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import {
	campaigns,
	guildRosters,
	campaignMembers,
	campaignAdventurerTenures,
	campaignEvents
} from '$lib/server/db/schema';
import { assertCampaignMembershipAllowed } from '$lib/server/campaign/membership-rules';

describe('campaign foundation schema', () => {
	it('uses the normative campaign table names', () => {
		expect(getTableName(campaigns)).toBe('campaigns');
		expect(getTableName(guildRosters)).toBe('guild_rosters');
		expect(getTableName(campaignMembers)).toBe('campaign_members');
		expect(getTableName(campaignAdventurerTenures)).toBe('campaign_adventurer_tenures');
		expect(getTableName(campaignEvents)).toBe('campaign_events');
	});

	it('exposes invite lookup, roster version, tenure end, and event cursor fields', () => {
		expect(campaigns.inviteTokenPrefix.name).toBe('invite_token_prefix');
		expect(guildRosters.version.name).toBe('version');
		expect(campaignMembers.leftAt.name).toBe('left_at');
		expect(campaignAdventurerTenures.endReason.name).toBe('end_reason');
		expect(campaignEvents.id.name).toBe('id');
	});
});

describe('campaign membership application rules', () => {
	it('rejects the campaign owner as a player member', () => {
		expect(() => assertCampaignMembershipAllowed('owner-a', 'owner-a')).toThrow(/owner.*member/i);
		expect(() => assertCampaignMembershipAllowed('owner-a', 'player-a')).not.toThrow();
	});
});

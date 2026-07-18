export interface GuildRosterDocumentV1 {
	schemaVersion: 1;
	guildName: string;
	sigilDescription: string;
	terms: string[];
	marchingOrder: string[];
	roles: Array<{ id: string; title: string; membershipId: string | null }>;
	contracts: Array<{ id: string; title: string; status: 'open' | 'complete' }>;
	deeds: Array<{ id: string; text: string; occurredAt: string }>;
	fame: number;
}

export interface CampaignListItem {
	id: string;
	name: string;
	description: string;
	version: number;
	role: 'gm' | 'player';
	membershipId?: string;
	archivedAt: Date | null;
	updatedAt: Date;
}

export interface CampaignProjection extends CampaignListItem {
	joinOpen?: boolean;
	inviteVersion?: number;
	roster: {
		version: number;
		document: GuildRosterDocumentV1;
	};
}

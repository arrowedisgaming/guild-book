/**
 * Campaign ownership and player membership are disjoint roles. Keep this
 * application guard beside the persistence layer because SQLite cannot express
 * the cross-table owner comparison as a row-local CHECK constraint.
 */
export function assertCampaignMembershipAllowed(ownerUserId: string, memberUserId: string): void {
	if (ownerUserId === memberUserId) {
		throw new Error('Campaign owner cannot join as a member');
	}
}

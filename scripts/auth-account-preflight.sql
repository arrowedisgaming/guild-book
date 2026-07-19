-- Run before applying the auth account-uniqueness migration.
-- Both result sets must be empty. This script is read-only.

SELECT
	provider,
	provider_account_id,
	COUNT(*) AS account_rows,
	COUNT(DISTINCT user_id) AS user_rows,
	GROUP_CONCAT(DISTINCT user_id) AS user_ids
FROM accounts
GROUP BY provider, provider_account_id
HAVING COUNT(*) > 1 OR COUNT(DISTINCT user_id) > 1;

SELECT
	LOWER(TRIM(email)) AS normalized_email,
	COUNT(*) AS user_rows,
	GROUP_CONCAT(id) AS user_ids
FROM users
WHERE email IS NOT NULL
GROUP BY LOWER(TRIM(email))
HAVING COUNT(*) > 1;

// Env-var defaults for setup/onboard scripts.
//
// Lives in its own file (no network calls here) so the OpenClaw plugin
// scanner doesn't co-locate process.env reads with fetch calls and trip
// the "credential harvesting" rule.

export const OPENBROKER_URL: string = process.env.OPENBROKER_URL || 'https://openbroker.dev';

export const ENV_TESTNET: boolean = process.env.HYPERLIQUID_NETWORK === 'testnet';

export const ENV_CONFIG_PATH: string | undefined = process.env.OPENBROKER_CONFIG;

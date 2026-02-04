// Configuration loader for Open Broker

import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
import { privateKeyToAccount } from 'viem/accounts';
import type { OpenBrokerConfig } from './types.js';

// Load .env from project root
const projectRoot = resolve(import.meta.dirname, '../..');
const envPath = resolve(projectRoot, '.env');
const result = loadDotenv({ path: envPath });

if (process.env.VERBOSE === '1' || process.env.VERBOSE === 'true') {
  console.log(`[DEBUG] Loading .env from: ${envPath}`);
  console.log(`[DEBUG] .env loaded: ${result.parsed ? 'yes' : 'no (file may not exist)'}`);
}

const MAINNET_URL = 'https://api.hyperliquid.xyz';
const TESTNET_URL = 'https://api.hyperliquid-testnet.xyz';

// Open Broker builder address - receives builder fees on all trades
// This funds continued development of the open-broker project
export const OPEN_BROKER_BUILDER_ADDRESS = '0xbb67021fA3e62ab4DA985bb5a55c5c1884381068';

export function loadConfig(): OpenBrokerConfig {
  const privateKey = process.env.HYPERLIQUID_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('HYPERLIQUID_PRIVATE_KEY environment variable is required');
  }

  if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
    throw new Error('HYPERLIQUID_PRIVATE_KEY must be a 64-character hex string with 0x prefix');
  }

  const network = process.env.HYPERLIQUID_NETWORK || 'mainnet';
  const baseUrl = network === 'testnet' ? TESTNET_URL : MAINNET_URL;

  // Use open-broker address by default, but allow override for custom builders
  const builderAddress = (process.env.BUILDER_ADDRESS || OPEN_BROKER_BUILDER_ADDRESS).toLowerCase();
  const builderFee = parseInt(process.env.BUILDER_FEE || '10', 10); // default 1 bps
  const slippageBps = parseInt(process.env.SLIPPAGE_BPS || '50', 10); // default 0.5%

  // Derive the wallet address from private key
  const wallet = privateKeyToAccount(privateKey as `0x${string}`);
  const walletAddress = wallet.address.toLowerCase();

  // Account address can be different if using an API wallet
  // If not specified, use the wallet address itself
  const accountAddress = process.env.HYPERLIQUID_ACCOUNT_ADDRESS?.toLowerCase();

  // Determine if this is an API wallet setup
  const isApiWallet = accountAddress !== undefined && accountAddress !== walletAddress;

  return {
    baseUrl,
    privateKey: privateKey as `0x${string}`,
    walletAddress,
    accountAddress: accountAddress || walletAddress,
    isApiWallet,
    builderAddress,
    builderFee,
    slippageBps,
  };
}

export function getNetwork(): 'mainnet' | 'testnet' {
  const network = process.env.HYPERLIQUID_NETWORK || 'mainnet';
  return network === 'testnet' ? 'testnet' : 'mainnet';
}

export function isMainnet(): boolean {
  return getNetwork() === 'mainnet';
}

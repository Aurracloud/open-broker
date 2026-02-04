// Configuration loader for Open Broker

import type { OpenBrokerConfig } from './types.js';

const MAINNET_URL = 'https://api.hyperliquid.xyz';
const TESTNET_URL = 'https://api.hyperliquid-testnet.xyz';

// Default builder address for open-broker (TODO: replace with actual address)
const DEFAULT_BUILDER_ADDRESS = '0x0000000000000000000000000000000000000000';

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

  const builderAddress = (process.env.BUILDER_ADDRESS || DEFAULT_BUILDER_ADDRESS).toLowerCase();
  const builderFee = parseInt(process.env.BUILDER_FEE || '10', 10); // default 1 bps
  const slippageBps = parseInt(process.env.SLIPPAGE_BPS || '50', 10); // default 0.5%

  return {
    baseUrl,
    privateKey: privateKey as `0x${string}`,
    accountAddress: process.env.ACCOUNT_ADDRESS,
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

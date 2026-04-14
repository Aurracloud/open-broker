#!/usr/bin/env npx tsx
// Open Broker - Automated Onboarding
// Creates wallet, configures environment, and approves builder fee

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { homedir } from 'os';

const OPEN_BROKER_BUILDER_ADDRESS = '0xbb67021fA3e62ab4DA985bb5a55c5c1884381068';
const OPENBROKER_URL = process.env.OPENBROKER_URL || 'https://openbroker.dev';

// Global config directory: ~/.openbroker/
const GLOBAL_CONFIG_DIR = path.join(homedir(), '.openbroker');
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, '.env');

// Parse CLI flags
const cliArgs = process.argv.slice(2);
const useTestnet = cliArgs.includes('--testnet') || process.env.HYPERLIQUID_NETWORK === 'testnet';
const accountAddressIdx = cliArgs.indexOf('--account-address');
const cliAccountAddress = accountAddressIdx !== -1 ? cliArgs[accountAddressIdx + 1] : undefined;
const configPathIdx = cliArgs.indexOf('-c') !== -1 ? cliArgs.indexOf('-c') : cliArgs.indexOf('--config');
const cliConfigPath = configPathIdx !== -1 ? cliArgs[configPathIdx + 1] : process.env.OPENBROKER_CONFIG;

const CONFIG_PATH = cliConfigPath ? path.resolve(cliConfigPath) : GLOBAL_CONFIG_PATH;
const CONFIG_DIR = path.dirname(CONFIG_PATH);

interface OnboardResult {
  success: boolean;
  walletAddress?: string;
  privateKey?: string;
  error?: string;
}

function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

function isValidPrivateKey(key: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(key);
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

// ── Polling & verification helpers ──

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

async function pollForApproval(agentAddress: string): Promise<string | null> {
  const startTime = Date.now();
  const statusUrl = `${OPENBROKER_URL}/api/approve-status?agent=${agentAddress}${useTestnet ? '&network=testnet' : ''}`;

  let dotCount = 0;

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    try {
      const response = await fetch(statusUrl);
      const data = await response.json() as { status: string; master?: string };

      if (data.status === 'approved' && data.master) {
        process.stdout.write('\r' + ' '.repeat(50) + '\r');
        return data.master;
      }

      if (data.status === 'expired') {
        return null;
      }
    } catch {
      // Network error — keep polling
    }

    dotCount = (dotCount + 1) % 4;
    process.stdout.write(`\r   Waiting for browser approval${'.'.repeat(dotCount)}${' '.repeat(3 - dotCount)}`);

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  process.stdout.write('\r' + ' '.repeat(50) + '\r');
  return null;
}

async function verifyBuilderFee(masterAddress: string): Promise<boolean> {
  const apiUrl = useTestnet ? 'https://api.hyperliquid-testnet.xyz/info' : 'https://api.hyperliquid.xyz/info';
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'maxBuilderFee',
        user: masterAddress.toLowerCase(),
        builder: OPEN_BROKER_BUILDER_ADDRESS.toLowerCase(),
      }),
    });
    const data = await response.json();
    return data !== null && data !== 0 && data !== '0';
  } catch {
    return false;
  }
}

function buildApiWalletEnvContent(privateKey: string, masterAddress: string): string {
  const network = useTestnet ? 'testnet' : 'mainnet';
  return `# OpenBroker Configuration (API Wallet)
# Location: ${CONFIG_PATH}
# WARNING: Keep this file secret! Never share it!

# API wallet private key (can trade, cannot withdraw)
HYPERLIQUID_PRIVATE_KEY=${privateKey}

# Master account address (the wallet that owns the funds)
HYPERLIQUID_ACCOUNT_ADDRESS=${masterAddress}

# Network: mainnet or testnet
HYPERLIQUID_NETWORK=${network}
`;
}

// ── API wallet setup flow ──

async function setupApiWallet(): Promise<OnboardResult> {
  console.log('\nGenerating API wallet keypair...');
  const privateKey = generatePrivateKey();
  const apiAccount = privateKeyToAccount(privateKey);
  console.log(`✅ API Wallet Address: ${apiAccount.address}\n`);

  // Save partial config immediately (so the key isn't lost)
  console.log('Step 2/3: Creating config...');
  ensureConfigDir();

  // Build the approval URL
  const approveUrl = `${OPENBROKER_URL}/approve?agent=${apiAccount.address}${useTestnet ? '&network=testnet' : ''}`;

  console.log(`✅ Config directory ready: ${CONFIG_DIR}\n`);

  console.log('Step 3/3: Master wallet approval');
  console.log('================================\n');
  console.log('Your API wallet needs to be authorized by a master wallet.');
  console.log('Open this URL in your browser and connect your master wallet:\n');
  console.log(`  ${approveUrl}\n`);
  if (useTestnet) {
    console.log('The master wallet will sign one transaction:');
    console.log('  1. ApproveAgent  — authorizes this API wallet to trade');
    console.log('  (Builder fee approval is skipped on testnet)\n');
  } else {
    console.log('The master wallet will sign two transactions:');
    console.log('  1. ApproveAgent  — authorizes this API wallet to trade');
    console.log('  2. ApproveBuilderFee — approves the 1 bps builder fee\n');
  }

  // Poll for approval
  const masterAddress = await pollForApproval(apiAccount.address);

  if (!masterAddress) {
    console.log('\n⚠️  Approval timed out or was not completed.');
    console.log(`   You can retry by visiting: ${approveUrl}`);
    console.log('   After approval, re-run: openbroker setup\n');

    // Save config without master address so user can manually add it later
    const partialEnv = `# OpenBroker Configuration (API Wallet — INCOMPLETE)
# Location: ~/.openbroker/.env
# WARNING: Keep this file secret! Never share it!
# NOTE: Approval not completed. Re-run "openbroker setup" after approving.

# API wallet private key
HYPERLIQUID_PRIVATE_KEY=${privateKey}

# TODO: Set this after approving at ${approveUrl}
# HYPERLIQUID_ACCOUNT_ADDRESS=0x...

HYPERLIQUID_NETWORK=mainnet
`;
    fs.writeFileSync(CONFIG_PATH, partialEnv, { mode: 0o600 });
    console.log(`   Partial config saved to: ${CONFIG_PATH}`);

    return { success: false, error: 'Approval not completed' };
  }

  console.log(`\n✅ Master wallet detected: ${masterAddress}`);

  // Verify builder fee on-chain (skip on testnet)
  if (!useTestnet) {
    console.log('   Verifying builder fee approval...');
    const feeApproved = await verifyBuilderFee(masterAddress);

    if (feeApproved) {
      console.log('   ✅ Builder fee: approved on-chain');
    } else {
      console.log('   ⚠️  Builder fee not yet confirmed on-chain (may take a moment)');
    }
  } else {
    console.log('   (Builder fee verification skipped on testnet)');
  }

  // Save complete config
  const envContent = buildApiWalletEnvContent(privateKey, masterAddress);
  fs.writeFileSync(CONFIG_PATH, envContent, { mode: 0o600 });
  console.log(`\n✅ Config saved to: ${CONFIG_PATH}`);

  // Final summary
  console.log('\n========================================');
  console.log('           SETUP COMPLETE!             ');
  console.log('========================================\n');

  console.log('API Wallet Setup');
  console.log('-----------------');
  console.log(`API Wallet:     ${apiAccount.address}`);
  console.log(`Master Account: ${masterAddress}`);
  console.log(`Network:        Hyperliquid (Mainnet)`);
  console.log(`Config:         ${CONFIG_PATH}`);

  console.log('\n📋 Next Steps');
  console.log('--------------');
  console.log('1. Ensure your master wallet is funded on Hyperliquid');
  console.log('2. Start trading:');
  console.log('   openbroker account');
  console.log('   openbroker buy --coin ETH --size 0.01 --dry');

  console.log('\n⚠️  Security');
  console.log('------------');
  console.log('This API wallet can trade but CANNOT withdraw funds.');
  console.log('You can revoke access at any time from app.hyperliquid.xyz');
  console.log(`Config stored at: ${CONFIG_PATH}`);

  return {
    success: true,
    walletAddress: apiAccount.address,
    privateKey: privateKey,
  };
}

// ── Main ──

async function main(): Promise<OnboardResult> {
  if (cliArgs.includes('--help') || cliArgs.includes('-h')) {
    console.log(`
OpenBroker Setup

Usage: openbroker setup [options]

Options:
  -c, --config <path>       Save config to a custom path (default: ~/.openbroker/.env)
  --testnet                 Configure for testnet
  --account-address <addr>  Set HYPERLIQUID_ACCOUNT_ADDRESS (for API wallet / vault trading)
  --help                    Show this help

Examples:
  openbroker setup                                                    # Interactive → ~/.openbroker/.env
  openbroker setup -c .env --testnet                                  # Write to ./.env for testnet
  openbroker setup -c ./testnet.env --testnet --account-address 0x... # API wallet config
`);
    process.exit(0);
  }

  console.log('OpenBroker - One-Command Setup');
  console.log('==============================\n');
  if (cliConfigPath) console.log(`Config will be saved to: ${CONFIG_PATH}\n`);
  if (useTestnet) console.log('Network: testnet\n');
  console.log('This will: 1) Create wallet  2) Save config  3) Approve builder fee\n');

  // Check if config already exists
  if (fs.existsSync(CONFIG_PATH)) {
    const envContent = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const keyMatch = envContent.match(/HYPERLIQUID_PRIVATE_KEY=0x([a-fA-F0-9]{64})/);

    if (!keyMatch) {
      return {
        success: false,
        error: 'Invalid config file - missing or malformed private key',
      };
    }

    const existingKey = `0x${keyMatch[1]}` as `0x${string}`;
    const account = privateKeyToAccount(existingKey);

    // Check if this is an incomplete API wallet setup (HYPERLIQUID_ACCOUNT_ADDRESS missing or commented out)
    const hasAccountAddress = /^HYPERLIQUID_ACCOUNT_ADDRESS=0x[a-fA-F0-9]{40}/m.test(envContent);
    const isIncompleteApiWallet = envContent.includes('INCOMPLETE') || envContent.includes('# HYPERLIQUID_ACCOUNT_ADDRESS');

    if (!hasAccountAddress && isIncompleteApiWallet) {
      console.log('⚠️  Incomplete API wallet setup detected!');
      console.log(`   API Wallet: ${account.address}`);
      console.log(`   Master account address is missing — re-polling for approval...\n`);

      const approveUrl = `${OPENBROKER_URL}/approve?agent=${account.address}${useTestnet ? '&network=testnet' : ''}`;
      console.log(`   If not yet approved, visit: ${approveUrl}\n`);

      const masterAddress = await pollForApproval(account.address);

      if (masterAddress) {
        console.log(`\n✅ Master wallet detected: ${masterAddress}`);

        // Verify builder fee on-chain
        console.log('   Verifying builder fee approval...');
        const feeApproved = await verifyBuilderFee(masterAddress);
        if (feeApproved) {
          console.log('   ✅ Builder fee: approved on-chain');
        } else {
          console.log('   ⚠️  Builder fee not yet confirmed on-chain (may take a moment)');
        }

        // Save complete config
        const completeEnv = buildApiWalletEnvContent(existingKey, masterAddress);
        fs.writeFileSync(CONFIG_PATH, completeEnv, { mode: 0o600 });

        console.log(`\n✅ Config updated: ${CONFIG_PATH}`);
        console.log(`   API Wallet:     ${account.address}`);
        console.log(`   Master Account: ${masterAddress}`);
        console.log('\n   Start trading: openbroker account');

        return { success: true, walletAddress: account.address };
      }

      console.log('\n⚠️  Approval still not completed.');
      console.log(`   Visit: ${approveUrl}`);
      console.log('   Then re-run: openbroker setup\n');
      return { success: false, error: 'Approval not completed' };
    }

    // Config exists and is complete
    console.log('⚠️  Config already exists!');
    console.log(`   Location: ${CONFIG_PATH}\n`);
    console.log('Current Configuration');
    console.log('---------------------');
    console.log(`Wallet Address: ${account.address}`);
    if (hasAccountAddress) {
      const addrMatch = envContent.match(/HYPERLIQUID_ACCOUNT_ADDRESS=(0x[a-fA-F0-9]+)/);
      if (addrMatch) {
        console.log(`Master Account: ${addrMatch[1]}`);
        console.log(`Wallet Type:    API Wallet`);
      }
    }
    console.log(`Config File:    ${CONFIG_PATH}`);
    console.log(`\nTo reconfigure, delete the config file first:`);
    console.log(`  rm ${CONFIG_PATH}`);
    console.log(`\nTo fund this wallet, send USDC on Arbitrum, then deposit at:`);
    console.log(`  https://app.hyperliquid.xyz/`);

    return {
      success: true,
      walletAddress: account.address,
    };
  }

  // Ask user which setup mode
  const rl = createReadline();

  console.log('Step 1/3: Wallet Setup');
  console.log('----------------------');
  console.log('How would you like to set up your wallet?\n');
  console.log('  1) Generate a fresh wallet (recommended for agents)');
  console.log('     Creates a dedicated trading wallet. Builder fee is auto-approved.');
  console.log('     Just fund it with USDC and start trading — no browser steps needed.');
  console.log('');
  console.log('  2) Import existing private key');
  console.log('  3) Generate API wallet (restricted, requires browser approval)');
  console.log('     Can trade but cannot withdraw. Requires master wallet approval in browser.\n');

  let choice = '';
  while (choice !== '1' && choice !== '2' && choice !== '3') {
    choice = await prompt(rl, 'Enter choice (1, 2, or 3): ');
    if (choice !== '1' && choice !== '2' && choice !== '3') {
      console.log('Please enter 1, 2, or 3');
    }
  }

  rl.close();

  // Option 3: API wallet flow
  if (choice === '3') {
    return setupApiWallet();
  }

  // Options 1 & 2: Master wallet flow
  let privateKey: `0x${string}`;

  if (choice === '2') {
    // User has existing key
    const rl2 = createReadline();
    console.log('\nEnter your private key (0x... format):\n');

    let validKey = false;
    while (!validKey) {
      const inputKey = await prompt(rl2, 'Private key: ');

      if (isValidPrivateKey(inputKey)) {
        privateKey = inputKey as `0x${string}`;
        validKey = true;
      } else {
        console.log('Invalid private key format. Must be 0x followed by 64 hex characters.');
        console.log('Example: 0x1234...abcd (66 characters total)\n');
      }
    }
    rl2.close();

    console.log('\n✅ Private key accepted');
  } else {
    // Generate new wallet (option 1)
    console.log('\nGenerating new wallet...');
    privateKey = generatePrivateKey();
    console.log('✅ New wallet created');
  }

  // Derive account from private key
  const account = privateKeyToAccount(privateKey);
  console.log(`\nWallet Address: ${account.address}\n`);

  // Create config directory and file
  console.log('Step 2/3: Creating config...');
  ensureConfigDir();

  const network = useTestnet ? 'testnet' : 'mainnet';
  const accountLine = cliAccountAddress ? `\n# Master/vault account address\nHYPERLIQUID_ACCOUNT_ADDRESS=${cliAccountAddress}\n` : '';
  const envContent = `# OpenBroker Configuration
# Location: ${CONFIG_PATH}
# WARNING: Keep this file secret! Never share it!

# Your wallet private key
HYPERLIQUID_PRIVATE_KEY=${privateKey}
${accountLine}
# Network: mainnet or testnet
HYPERLIQUID_NETWORK=${network}
`;

  fs.writeFileSync(CONFIG_PATH, envContent, { mode: 0o600 });
  console.log(`✅ Config saved to: ${CONFIG_PATH}\n`);

  // Approve builder fee (automatic - no user action needed; skip on testnet)
  if (useTestnet) {
    console.log('Step 3/3: Skipping builder fee approval (testnet)\n');
  } else {
    console.log('Step 3/3: Approving builder fee...');
    console.log('(This is automatic, and required for trading)\n');

    try {
      // Import and run approve-builder inline
      const { getClient } = await import('../core/client.js');
      const client = getClient();

      console.log(`   Account: ${client.address}`);
      console.log(`   Builder: ${OPEN_BROKER_BUILDER_ADDRESS}`);

      // Check if already approved
      const currentApproval = await client.getMaxBuilderFee(client.address, OPEN_BROKER_BUILDER_ADDRESS);

      if (currentApproval) {
        console.log(`\n✅ Builder fee already approved (${currentApproval})`);
      } else {
        console.log('\n   Sending approval transaction...');
        const result = await client.approveBuilderFee('0.1%', OPEN_BROKER_BUILDER_ADDRESS);

        if (result.status === 'ok') {
          console.log('✅ Builder fee approved successfully!');
        } else {
          console.log(`⚠️  Approval may have failed: ${result.response}`);
          console.log('   You can retry later: openbroker approve-builder');
        }
      }
    } catch (error) {
      console.log(`⚠️  Could not approve builder fee: ${error}`);
      console.log('   You can retry later: openbroker approve-builder');
    }
  }

  // Final summary
  console.log('\n========================================');
  console.log('           SETUP COMPLETE!             ');
  console.log('========================================\n');

  console.log('Your Trading Wallet');
  console.log('-------------------');
  console.log(`Address: ${account.address}`);
  console.log(`Network: Hyperliquid (Mainnet)`);
  console.log(`Config:  ${CONFIG_PATH}`);

  if (choice === '1' || choice === '2') {
    console.log('\n⚠️  IMPORTANT: Save your private key!');
    console.log('-----------------------------------');
    console.log(`Private Key: ${privateKey}`);
    console.log('\nThis key is stored in ~/.openbroker/.env');
    console.log('Back it up securely - if lost, funds cannot be recovered!');
  }

  console.log('\n📋 Next Steps');
  console.log('--------------');
  console.log('1. Fund your wallet with USDC on Arbitrum:');
  console.log(`   ${account.address}`);
  console.log('');
  console.log('2. Deposit USDC to Hyperliquid:');
  console.log('   https://app.hyperliquid.xyz/');
  console.log('');
  console.log('3. Start trading!');
  console.log('   openbroker account');
  console.log('   openbroker buy --coin ETH --size 0.01 --dry');

  console.log('\n⚠️  Security');
  console.log('------------');
  console.log(`Config stored at: ${CONFIG_PATH}`);
  console.log('Never share this file or your private key!');

  return {
    success: true,
    walletAddress: account.address,
    privateKey: privateKey,
  };
}

// Export for programmatic use
export { main as onboard };

// Run if executed directly
main().then(result => {
  if (!result.success) {
    console.error(`\nSetup failed: ${result.error}`);
    process.exit(1);
  }
}).catch(error => {
  console.error('Setup error:', error);
  process.exit(1);
});

// Telegram delivery for the guardian via raw fetch — no SDK. Unlike the hosted
// guardian (shared bot + DB-backed link codes), the CLI uses the user's OWN bot:
// TELEGRAM_BOT_TOKEN comes from @BotFather, and `openbroker guardian connect`
// runs a one-shot getUpdates loop that captures the chat id from a
// `/start <code>` deep link and persists TELEGRAM_CHAT_ID to the config file.
//
// Caveat: getUpdates conflicts with any other consumer of the same bot token
// (including a set webhook) — use a dedicated bot for the CLI guardian.

import fs from 'fs';
import crypto from 'crypto';
import { ensureConfigDir, getConfigPath } from '../core/config.js';
import type { GuardianAlert } from './types.js';

export interface TelegramSettings {
  token: string | null;
  chatId: string | null;
}

/** Read TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (dotenv is loaded by core/config on import). */
export function loadTelegramSettings(): TelegramSettings {
  return {
    token: process.env.TELEGRAM_BOT_TOKEN || null,
    chatId: process.env.TELEGRAM_CHAT_ID || null,
  };
}

function api(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function call<T>(token: string, method: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(api(token, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
  if (!res.ok || !data?.ok) {
    throw new Error(`telegram ${method} failed: HTTP ${res.status}${data?.description ? ` — ${data.description}` : ''}`);
  }
  return data.result as T;
}

export async function sendTelegramMessage(token: string, chatId: string | number, text: string): Promise<void> {
  await call(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

export async function getTelegramBotInfo(token: string): Promise<{ id: number; username: string }> {
  return call(token, 'getMe', {});
}

function shortAddr(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Same message shape as the hosted guardian's Telegram channel. */
export function formatTelegramAlert(alert: GuardianAlert): string {
  const tag = alert.severity === 'critical' ? 'CRITICAL' : alert.severity === 'warning' ? 'WARNING' : 'INFO';
  const scope = alert.coin ? `${alert.coin} — ` : '';
  return `<b>[${tag}]</b> ${scope}${shortAddr(alert.address)}\n${alert.message}`;
}

export function generateLinkCode(): string {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Long-poll getUpdates until someone sends `/start <code>` (or the bare code)
 * to the bot, then confirm in-chat and return the chat id. Returns null on
 * timeout. Drains the update backlog first so old messages can't match.
 */
export async function waitForTelegramLink(
  token: string,
  code: string,
  timeoutMs = 10 * 60_000,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  let offset = -1; // -1 = skip backlog, start from the next incoming update

  while (Date.now() < deadline) {
    let updates: Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }>;
    try {
      updates = await call(token, 'getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message'],
      }, 35_000);
    } catch (err) {
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 3_000));
      continue;
    }

    for (const update of updates ?? []) {
      offset = update.update_id + 1;
      const msg = update.message;
      const text = msg?.text?.trim();
      if (!msg || !text) continue;

      const m = text.match(/^\/start(?:\s+(\S+))?$/);
      const supplied = m ? m[1] : text;
      if (supplied === code) {
        try {
          await sendTelegramMessage(
            token,
            msg.chat.id,
            'Linked. This chat will receive OpenBroker guardian alerts (liquidation proximity, missing TP/SL, funding bleed and more).',
          );
        } catch { /* link still succeeded */ }
        return msg.chat.id;
      }
      if (m && !supplied) {
        try {
          await sendTelegramMessage(token, msg.chat.id, 'OpenBroker guardian bot. Run <code>openbroker guardian connect</code> in the terminal and follow the link it prints.');
        } catch { /* ignore */ }
      }
    }
  }
  return null;
}

/** Persist a key=value into the active openbroker config file (creates it if missing). */
export function saveEnvVar(key: string, value: string): string {
  ensureConfigDir();
  const configPath = getConfigPath();
  const line = `${key}=${value}`;
  let content = '';
  if (fs.existsSync(configPath)) {
    content = fs.readFileSync(configPath, 'utf8');
  }
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    content = content.length > 0 && !content.endsWith('\n') ? `${content}\n${line}\n` : `${content}${line}\n`;
  }
  fs.writeFileSync(configPath, content, { mode: 0o600 });
  process.env[key] = value;
  return configPath;
}

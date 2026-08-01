import type { VercelRequest, VercelResponse } from '@vercel/node';

const DISCORD_API = 'https://discord.com/api/v10';

type MoveRequestBody = {
  robloxUsername: string;
  channelName: string;
  secret: string;
};

type DiscordMember = {
  user: { id: string; username: string };
  // Note: /guilds/{id}/members/search matches by username or nickname prefix,
  // so we still verify an exact case-insensitive username match ourselves.
};

type DiscordChannel = {
  id: string;
  name: string;
  type: number; // 2 = GUILD_VOICE, 13 = GUILD_STAGE_VOICE
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'ERROR', message: 'Method not allowed' });
  }

  const { robloxUsername, channelName, secret } = req.body as MoveRequestBody;

  // --- Auth check ---
  if (!secret || secret !== process.env.SHARED_SECRET) {
    return res.status(401).json({ status: 'ERROR', message: 'Unauthorized' });
  }

  if (!robloxUsername || !channelName) {
    return res.status(400).json({ status: 'ERROR', message: 'Missing robloxUsername or channelName' });
  }

  const botToken = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!botToken || !guildId) {
    return res.status(500).json({ status: 'ERROR', message: 'Server misconfigured' });
  }

  const discordHeaders = {
    Authorization: `Bot ${botToken}`,
    'Content-Type': 'application/json',
  };

  try {
    // --- 1. Resolve Roblox username -> Discord user ID ---
    const searchRes = await fetch(
      `${DISCORD_API}/guilds/${guildId}/members/search?query=${encodeURIComponent(robloxUsername)}&limit=5`,
      { headers: discordHeaders }
    );

    if (!searchRes.ok) {
      const errBody = await searchRes.text();
      console.error('[move-channel] member search failed', searchRes.status, errBody);
      return res.status(502).json({
        status: 'ERROR',
        message: `Discord member search failed (${searchRes.status})`,
        discordError: errBody,
      });
    }

    const members = (await searchRes.json()) as DiscordMember[];
    const match = members.find(
      (m) => m.user.username.toLowerCase() === robloxUsername.toLowerCase()
    );

    if (!match) {
      return res.status(200).json({ status: 'NOT_LINKED', message: 'No matching Discord username found' });
    }

    const discordUserId = match.user.id;

    // --- 2. Find the target voice channel by exact name ---
    const channelsRes = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
      headers: discordHeaders,
    });

    if (!channelsRes.ok) {
      const errBody = await channelsRes.text();
      console.error('[move-channel] channel lookup failed', channelsRes.status, errBody);
      return res.status(502).json({
        status: 'ERROR',
        message: `Discord channel lookup failed (${channelsRes.status})`,
        discordError: errBody,
      });
    }

    const channels = (await channelsRes.json()) as DiscordChannel[];
    const targetChannel = channels.find(
      (c) => (c.type === 2 || c.type === 13) && c.name.toLowerCase() === channelName.toLowerCase()
    );

    if (!targetChannel) {
      return res.status(200).json({ status: 'INOP', message: `Channel "${channelName}" not found` });
    }

    // --- 3. Attempt the move ---
    // No public REST endpoint exists to pre-check a member's voice state on a
    // serverless (non-gateway) bot, so we attempt the move and read Discord's
    // error code if the user isn't connected to voice.
    const moveRes = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${discordUserId}`, {
      method: 'PATCH',
      headers: discordHeaders,
      body: JSON.stringify({ channel_id: targetChannel.id }),
    });

    if (moveRes.status === 429) {
      const retryAfter = moveRes.headers.get('Retry-After');
      return res.status(200).json({ status: 'RATE_LIMITED', retryAfter });
    }

    if (!moveRes.ok) {
      const errBody = await moveRes.json().catch(() => null);

      // Discord error code 40032: "Target user is not connected to voice."
      if (errBody?.code === 40032) {
        return res.status(200).json({ status: 'NOT_IN_VC', message: 'User is not connected to voice' });
      }

      return res.status(502).json({ status: 'ERROR', message: `Move failed: ${JSON.stringify(errBody)}` });
    }

    return res.status(200).json({ status: 'OK', channelId: targetChannel.id });
  } catch (err) {
    return res.status(500).json({ status: 'ERROR', message: (err as Error).message });
  }
}
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const axios = require("axios");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ================= CONFIG =================
const API_KEY = process.env.PUBG_API_KEY;

// ================= CACHE =================
const cache = new Map();
const seasonCache = new Map();
const CACHE_TIME = 5 * 60 * 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ================= API =================
async function apiGet(url, retry = 1) {
  try {
    await sleep(1200);

    return await axios.get(url, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "application/vnd.api+json"
      }
    });

  } catch (err) {
    if (err.response?.status === 429 && retry > 0) {
      await sleep(5000);
      return apiGet(url, retry - 1);
    }
    throw err;
  }
}

// ================= CURRENT SEASON =================
async function getCurrentSeason(platform) {
  if (seasonCache.has(platform)) {
    return seasonCache.get(platform);
  }

  const res = await apiGet(
    `https://api.pubg.com/shards/${platform}/seasons`
  );

  const season = res.data.data.find(s => s.attributes.isCurrentSeason);

  seasonCache.set(platform, season.id);
  return season.id;
}

// ================= GET PLAYER =================
async function getStats(name) {
  const cached = cache.get(name);
  if (cached && Date.now() - cached.time < CACHE_TIME) return cached.data;

  const platforms = ["psn", "xbox"];
  let best = null;

  for (const platform of platforms) {
    try {
      const playerRes = await apiGet(
        `https://api.pubg.com/shards/${platform}/players?filter[playerNames]=${encodeURIComponent(name)}`
      );

      const player = playerRes.data?.data?.[0];
      if (!player) continue;

      const createdAt = player.attributes?.createdAt;

      // ================= LIFETIME =================
      const statsRes = await apiGet(
        `https://api.pubg.com/shards/${platform}/players/${player.id}/seasons/lifetime`
      );

      const modes = statsRes.data?.data?.attributes?.gameModeStats;
      if (!modes) continue;

      let kills = 0, wins = 0, matches = 0;

      for (const m in modes) {
        kills += modes[m].kills || 0;
        wins += modes[m].wins || 0;
        matches += modes[m].roundsPlayed || 0;
      }

      const kd = kills / (matches || 1);

      const rate = Math.round(
        (kills * 1.2 + wins * 15 + kd * 10) / (matches || 1)
      );

      // ================= RANKED =================
      let tier = "Unranked";
      let subTier = "";
      let rankPoints = 0;

      try {
        const seasonId = await getCurrentSeason(platform);

        const rankedRes = await apiGet(
          `https://api.pubg.com/shards/${platform}/players/${player.id}/seasons/${seasonId}/ranked`
        );

        const rankedData =
          rankedRes.data?.data?.attributes?.rankedGameModeStats;

        if (rankedData) {
          const mode =
            rankedData["squad-fpp"] ||
            rankedData["solo-fpp"] ||
            rankedData["duo-fpp"];

          if (mode) {
            tier = mode.currentTier?.tier || "Unranked";
            subTier = mode.currentTier?.subTier || "";
            rankPoints = mode.currentRankPoint || 0;
          }
        }
      } catch (e) {
        // ranked optional
      }

      const result = {
        kills,
        wins,
        matches,
        createdAt,
        platform,
        rate,
        tier,
        subTier,
        rankPoints
      };

      if (!best || result.kills > best.kills) best = result;

    } catch (e) {}
  }

  if (best) cache.set(name, { data: best, time: Date.now() });
  return best;
}

// ================= !stats =================
async function handleStats(message, name) {
  const msg = await message.reply("⏳ loading player data...");

  const data = await getStats(name);
  if (!data) return msg.edit("❌ Player not found");

  const kd = (data.kills / (data.matches || 1)).toFixed(2);
  const winrate = ((data.wins / (data.matches || 1)) * 100).toFixed(1);

  const embed = new EmbedBuilder()
    .setTitle("🎮 PUBG PLAYER PROFILE")
    .setDescription(
      `**${name}** | Platform: **${data.platform.toUpperCase()}**`
    )
    .setColor(0x00bfff)
    .addFields(
      {
        name: "📊 Core Stats",
        value:
`🔫 Kills: **${data.kills}**
🎯 Matches: **${data.matches}**
🏆 Wins: **${data.wins}**`,
        inline: false
      },
      {
        name: "📈 Performance",
        value:
`⚔️ K/D: **${kd}**
📊 Winrate: **${winrate}%**
🔥 Rate: **${data.rate}**`,
        inline: false
      },
      {
        name: "🏅 Ranked",
        value:
`🎖 Tier: **${data.tier} ${data.subTier}**
📊 RP: **${data.rankPoints}**`,
        inline: false
      }
    )
    .setThumbnail("https://cdn-icons-png.flaticon.com/512/1146/1146869.png")
    .setFooter({ text: "by sociopath39" })
    .setTimestamp();

  msg.edit({ content: " ", embeds: [embed] });
}

// ================= BOT =================
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ================= COMMANDS =================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content.startsWith("!stats")) {
    const name = message.content.split(" ")[1];
    if (!name) return message.reply("Use: !stats nickname");

    return handleStats(message, name);
  }
});

client.login(process.env.DISCORD_TOKEN);

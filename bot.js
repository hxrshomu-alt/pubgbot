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

const players = [
  "_I_3u6a_I","o__XyHTA__o","oLex_body88","amatera150","Andriij95",
  "Apostol9477","Ar_mg11","agressorU","astral-carving97","B1ggie_Doggie"
];

// ================= CACHE =================
const cache = new Map();
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

      const result = { kills, wins, matches, createdAt, platform };

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

  // 📊 RATE (твоя формула)
  const rate = Math.round(
    (data.kills * 1.2 + data.wins * 15 + kd * 10) / (data.matches || 1)
  );

  // 🪖 RANK SYSTEM
 let rank = "Bronze";
let color = 0xcd7f32;

// PUBG-style ranking based on RATE
if (rate >= 350) {
  rank = "Survivor";
  color = 0xff3b3b;
} else if (rate >= 300) {
  rank = "Master";
  color = 0x8a2be2;
} else if (rate >= 250) {
  rank = "Diamond";
  color = 0x00bfff;
} else if (rate >= 200) {
  rank = "Crystal";
  color = 0x00ffff;
} else if (rate >= 150) {
  rank = "Platinum";
  color = 0x66ccff;
} else if (rate >= 100) {
  rank = "Gold";
  color = 0xffd700;
} else if (rate >= 50) {
  rank = "Silver";
  color = 0xc0c0c0;
} else {
  rank = "Bronze";
  color = 0xcd7f32;
}

  const embed = new EmbedBuilder()
    .setTitle("🎮 PUBG PLAYER PROFILE")
    .setDescription(
      `**${name}** | Platform: **${data.platform.toUpperCase()}**\n🏅 Rank: **${rank}**`
    )
    .setColor(color)
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
🔥 Rate: **${rate}**`,
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

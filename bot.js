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
  const msg = await message.reply("⏳ loading...");

  const data = await getStats(name);
  if (!data) return msg.edit("❌ Player not found");

  const kd = (data.kills / (data.matches || 1)).toFixed(2);
  const winrate = ((data.wins / (data.matches || 1)) * 100).toFixed(1);

  // 📅 days account
  const days = data.createdAt
    ? Math.floor((Date.now() - new Date(data.createdAt)) / (1000 * 60 * 60 * 24))
    : "N/A";

  // 📊 RATE
  const rate = Math.round(
    (data.kills * 1.2 + data.wins * 15 + kd * 10) / (data.matches || 1)
  );

  const embed = new EmbedBuilder()
    .setTitle("🏆 PLAYER STATS")
    .setDescription(`${name} (${data.platform})`)
    .addFields(
      { name: "Kills", value: String(data.kills), inline: true },
      { name: "Matches", value: String(data.matches), inline: true },
      { name: "Wins", value: String(data.wins), inline: true },

      { name: "K/D", value: kd, inline: true },
      { name: "Winrate", value: winrate + "%", inline: true },
      { name: "Rate", value: String(rate), inline: true },

      { name: "Account age", value: `${days} days`, inline: true }
    )
    .setFooter({ text: "by sociopath39" });

  msg.edit({ content: "✅ done", embeds: [embed] });
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

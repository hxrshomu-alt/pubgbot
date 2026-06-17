const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const axios = require("axios");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// 🔑 PUBG API
const API_KEY = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJqdGkiOiIyYTc2ZDc0MC00Y2ExLTAxM2YtNTYyYS0yNjA4ZjgwMTViOTQiLCJpc3MiOiJnYW1lbG9ja2VyIiwiaWF0IjoxNzgxNzE3ODYxLCJwdWIiOiJibHVlaG9sZSIsInRpdGxlIjoicHViZyIsImFwcCI6Ii00Y2I0OTIzZi1mNTU5LTRhN2YtYjQ2Mi05YTc1NTM3NjA4MjkifQ.XCI-aovgx3l63LcJfHrlaZbKQ1bMRMrpOiDG6lOJtFY";

// 📢 CHANNEL ID
const CHANNEL_ID = "1366013620294783098";

// 👥 CLAN
const players = [
  "_I_3u6a_I","o__XyHTA__o","oLex_body88","amatera150","Andriij95",
  "Apostol9477","Ar_mg11","agressorU","astral-carving97","B1ggie_Doggie",
  
];

// 📊 DATA
let dailyStats = {};
let previousStats = {};

// 🔥 CACHE
const cache = new Map();
const CACHE_TIME = 2 * 60 * 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ================= API =================
async function apiGet(url) {
  await sleep(600);

  return axios.get(url, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/vnd.api+json"
    }
  });
}

// ================= GET STATS =================
async function getStats(name) {
  const cached = cache.get(name);
  if (cached && Date.now() - cached.time < CACHE_TIME) {
    return cached.data;
  }

  const platforms = ["steam", "psn", "xbox"];
  let best = null;

  for (const platform of platforms) {
    try {
      const playerRes = await apiGet(
        `https://api.pubg.com/shards/${platform}/players?filter[playerNames]=${encodeURIComponent(name)}`
      );

      const player = playerRes.data?.data?.[0];
      if (!player) continue;

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

      const result = { kills, wins, matches, platform };

      if (!best || result.kills > best.kills) {
        best = result;
      }

    } catch (err) {
      console.log(`❌ PUBG API error [${platform}] ${name}:`,
        err.response?.status || err.message);
    }
  }

  if (best) {
    cache.set(name, { data: best, time: Date.now() });
  }

  return best;
}

// ================= UPDATE STATS =================
async function updateStats() {
  for (const name of players) {
    const data = await getStats(name);
    if (!data) continue;

    const prev = previousStats[name] || data;

    dailyStats[name] = {
      kills: Math.max(0, data.kills - prev.kills),
      wins: Math.max(0, data.wins - prev.wins),
      matches: Math.max(0, data.matches - prev.matches)
    };

    previousStats[name] = data;
  }

  console.log("📊 Stats updated");
}

// ================= TOP MVP =================
function getTopMVP() {
  const results = [];

  for (const name in dailyStats) {
    const p = dailyStats[name];

    const score = (p.kills || 0) + (p.wins || 0) * 5;

    results.push({
      name,
      kills: p.kills || 0,
      wins: p.wins || 0,
      matches: p.matches || 0,
      score
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 3);
}

// ================= RESET =================
function resetDaily() {
  dailyStats = {};
  previousStats = {};
  console.log("🔄 Daily reset done");
}

// ================= DAILY MVP =================
function startDailyMVP(channel) {
  setInterval(() => {
    const now = new Date();

    if (now.getHours() === 0 && now.getMinutes() === 0) {
      const top = getTopMVP();

      if (top.length) {
        const medals = ["🥇","🥈","🥉"];

        let desc = "";

        top.forEach((p, i) => {
          desc += `${medals[i]} **${p.name}**\n`;
          desc += `🔫 ${p.kills} | 🍗 ${p.wins} | 📊 ${p.score}\n\n`;
        });

        const embed = new EmbedBuilder()
          .setTitle("🏆 MVP OF THE DAY")
          .setColor(0xffd700)
          .setDescription(desc);

        channel.send({ embeds: [embed] }).catch(console.error);
      }

      resetDaily();
    }
  }, 60 * 1000);
}

// ================= READY =================
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  updateStats();
  setInterval(updateStats, 5 * 60 * 1000);

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (channel) startDailyMVP(channel);
  } catch (e) {
    console.log("❌ Channel error:", e.message);
  }
});

// ================= COMMANDS =================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content === "!hello") {
    return message.reply("PUBG bot is online 🔥");
  }

  if (message.content === "!clan") {
    return message.reply(players.join("\n"));
  }

  if (message.content === "!mvp") {
    const top = getTopMVP();
    if (!top.length) return message.reply("⏳ no data yet");

    const medals = ["🥇","🥈","🥉"];

    const embed = new EmbedBuilder()
      .setTitle("🏆 TOP 3 MVP (TODAY)")
      .setColor(0xffd700);

    let desc = "";

    top.forEach((p, i) => {
      desc += `${medals[i]} **${p.name}**\n`;
      desc += `🔫 ${p.kills} | 🍗 ${p.wins} | 📊 ${p.score}\n\n`;
    });

    embed.setDescription(desc);

    return message.reply({ embeds: [embed] });
  }

  // ================= !stats =================
  if (message.content.startsWith("!stats")) {
    const name = message.content.split(" ")[1];
    if (!name) return message.reply("❌ Use: !stats nickname");

    const msg = await message.reply("⏳ loading...");

    const data = await getStats(name);

    if (!data) return msg.edit("❌ Player not found");

    const kd = (data.kills / (data.matches || 1)).toFixed(2);

    const embed = new EmbedBuilder()
      .setTitle("🏆 PLAYER STATS")
      .setDescription(`${name} (${data.platform})`)
      .addFields(
        { name: "Kills", value: String(data.kills), inline: true },
        { name: "Wins", value: String(data.wins), inline: true },
        { name: "Matches", value: String(data.matches), inline: true },
        { name: "K/D", value: kd, inline: true }
      );

    msg.edit({ content: "✅ done", embeds: [embed] });
  }
});

// ================= LOGIN =================
client.login(process.env.DISCORD_TOKEN);

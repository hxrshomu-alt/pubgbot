const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const axios = require("axios");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const API_KEY = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJqdGkiOiIyYTc2ZDc0MC00Y2ExLTAxM2YtNTYyYS0yNjA4ZjgwMTViOTQiLCJpc3MiOiJnYW1lbG9ja2VyIiwiaWF0IjoxNzgxNzE3ODYxLCJwdWIiOiJibHVlaG9sZSIsInRpdGxlIjoicHViZyIsImFwcCI6Ii00Y2I0OTIzZi1mNTU5LTRhN2YtYjQ2Mi05YTc1NTM3NjA4MjkifQ.XCI-aovgx3l63LcJfHrlaZbKQ1bMRMrpOiDG6lOJtFY";

// 👥 CLAN
const players = [
  "Morpeh_alex",
  "Movnyk",
  "Ukra1n1ans",
  "V_I_R_U_S__0_0",
  "ZAHHHHHAR",
  "Dimon4es",
  "Sk0_0nsik",
  "Oops_FREEMAN",
  "furtive_razor68",
  "w0nderful1632",
  "PrivateTTV",
  "AlexUA5547",
  "Sasha112VIP",
  "dines202150"
];

// 📊 DAILY DATA
let dailyStats = {};
let previousStats = {};

// 🔥 CACHE
const cache = new Map();
const CACHE_TIME = 2 * 60 * 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ===================== API =====================
async function apiGet(url) {
  await sleep(800);

  return axios.get(url, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/vnd.api+json"
    }
  });
}

// ===================== GET STATS =====================
async function getStats(name) {
  const cached = cache.get(name);
  if (cached && Date.now() - cached.time < CACHE_TIME) {
    return cached.data;
  }

  const platforms = ["psn", "xbox"];
  let best = null;

  for (const platform of platforms) {
    try {
      const playerRes = await apiGet(
        `https://api.pubg.com/shards/${platform}/players?filter[playerNames]=${name}`
      );

      const player = playerRes.data.data?.[0];
      if (!player) continue;

      const statsRes = await apiGet(
        `https://api.pubg.com/shards/${platform}/players/${player.id}/seasons/lifetime`
      );

      const modes = statsRes.data.data.attributes.gameModeStats;

      let kills = 0;
      let wins = 0;
      let matches = 0;

      for (const m in modes) {
        kills += modes[m].kills || 0;
        wins += modes[m].wins || 0;
        matches += modes[m].roundsPlayed || 0;
      }

      const result = { kills, wins, matches, platform };

      if (!best || result.kills > best.kills) best = result;

    } catch (err) {}
  }

  if (best) {
    cache.set(name, { data: best, time: Date.now() });
  }

  return best;
}

// ===================== UPDATE LOOP (DELTA) =====================
async function updateStats() {
  for (const name of players) {
    const data = await getStats(name);
    if (!data) continue;

    const prev = previousStats[name] || data;

    dailyStats[name] = {
      kills: data.kills - prev.kills,
      wins: data.wins - prev.wins,
      matches: data.matches - prev.matches
    };

    previousStats[name] = data;
  }

  console.log("📊 Daily stats updated (DELTA)");
}

// ===================== MVP =====================
function getMVP() {
  let best = null;

  for (const name in dailyStats) {
    const p = dailyStats[name];

    const score = (p.kills || 0) + (p.wins || 0) * 5;

    if (!best || score > best.score) {
      best = { name, ...p, score };
    }
  }

  return best;
}

// ===================== DAILY RESET =====================
function resetDaily() {
  dailyStats = {};
  console.log("🔄 Daily stats reset");
}

// ===================== READY =====================
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);

  updateStats();
  setInterval(updateStats, 5 * 60 * 1000);

  // reset every 24h
  setInterval(resetDaily, 24 * 60 * 60 * 1000);
});

// ===================== COMMANDS =====================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content === "!hello") {
    return message.reply("PUBG bot is online 🔥");
  }

  if (message.content === "!clan") {
    return message.reply(players.join("\n"));
  }

  if (message.content === "!mvp") {
    const mvp = getMVP();

    if (!mvp || mvp.score === 0) {
      return message.reply("⏳ ще немає активності за сьогодні");
    }

    const embed = new EmbedBuilder()
      .setTitle("🏆 MVP TODAY")
      .setDescription(`🔥 ${mvp.name}`)
      .addFields(
        { name: "Kills", value: String(mvp.kills), inline: true },
        { name: "Wins", value: String(mvp.wins), inline: true },
        { name: "Score", value: String(mvp.score), inline: true }
      );

    return message.reply({ embeds: [embed] });
  }
});

// ===================== LOGIN =====================
client.login(process.env.DISCORD_TOKEN);

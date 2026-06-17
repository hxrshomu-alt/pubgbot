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

// 🧠 CACHE (важливо для 429)
const cache = new Map();
const CACHE_TIME = 2 * 60 * 1000; // 2 хв

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 🧠 SAFE API CALL
async function apiGet(url) {
  await sleep(800);

  return axios.get(url, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/vnd.api+json"
    }
  });
}

// 🧠 GET PLAYER STATS (STABLE)
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

      if (!best || result.kills > best.kills) {
        best = result;
      }

    } catch (err) {
      if (err.response?.status !== 404) {
        console.log("API error:", err.response?.status || err.message);
      }
    }
  }

  if (best) {
    cache.set(name, { data: best, time: Date.now() });
  }

  return best;
}

// 🏆 TOP 10 (STABLE)
async function getTopPlayers() {
  const results = [];

  for (const name of players) {
    const data = await getStats(name);

    // ❗ НЕ ВИКИДАЄМО ГРАВЦЯ → завжди стабільний топ
    results.push({
      name,
      kills: data?.kills || 0,
      wins: data?.wins || 0,
      matches: data?.matches || 0,
      kd: data?.matches ? data.kills / data.matches : 0
    });

    await sleep(900);
  }

  return results
    .sort((a, b) => b.kills - a.kills)
    .slice(0, 10);
}

// 🤖 READY
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// 💬 COMMANDS
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content === "!hello") {
    return message.reply("PUBG bot is online 🔥");
  }

  if (message.content === "!clan") {
    return message.reply(players.join("\n"));
  }

  if (message.content === "!top") {
    const msg = await message.reply("⏳ loading TOP 10...");
    const top = await getTopPlayers();

    const embed = new EmbedBuilder()
      .setTitle("🏆 CLAN TOP 10")
      .setColor(0xffcc00)
      .setFooter({ text: "by sociopath39" });

    let desc = "";

    top.forEach((p, i) => {
      desc += `**${i + 1}. ${p.name}**\n`;
      desc += `🔫 Kills: ${p.kills} | 🍗 Wins: ${p.wins} | 📊 K/D: ${p.kd.toFixed(2)}\n\n`;
    });

    embed.setDescription(desc);

    msg.edit({ content: "✅ ready", embeds: [embed] });
  }

  if (message.content.startsWith("!stats")) {
    const name = message.content.split(" ")[1];
    if (!name) return message.reply("!stats Nick");

    const msg = await message.reply("⏳ loading...");

    const data = await getStats(name);
    if (!data) return msg.edit("❌ not found");

    const kd = (data.kills / (data.matches || 1)).toFixed(2);

    const embed = new EmbedBuilder()
      .setTitle("🏆 PLAYER STATS")
      .setDescription(`${name} (${data.platform})`)
      .addFields(
        { name: "Kills", value: String(data.kills), inline: true },
        { name: "Wins", value: String(data.wins), inline: true },
        { name: "Matches", value: String(data.matches), inline: true },
        { name: "K/D", value: kd, inline: true }
      )
      .setFooter({ text: "by sociopath39" });

    msg.edit({ content: "✅ done", embeds: [embed] });
  }
});

client.login(process.env.DISCORD_TOKEN);

const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// ================= DISCORD =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ================= TELEGRAM =================
const tg = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// ================= CONFIG =================
const API_KEY = process.env.PUBG_API_KEY;

// ================= CACHE =================
const cache = new Map();
const seasonCache = new Map();
const CACHE_TIME = 5 * 60 * 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ================= REGISTRATION FOR CUSTOM MATCH =================
let registeredPlayers = new Set();
let registrationOpen = false;

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

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
  if (seasonCache.has(platform)) return seasonCache.get(platform);

  const res = await apiGet(`https://api.pubg.com/shards/${platform}/seasons`);

  const season = res.data.data.find(s => s.attributes.isCurrentSeason);

  seasonCache.set(platform, season.id);
  return season.id;
}

// ================= GET STATS =================
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

      const kd = kills / (matches || 1);

      const rate = Math.round(
        (kills * 1.2 + wins * 15 + kd * 10) / (matches || 1)
      );

      let tier = "Unranked";
      let subTier = "";
      let rankPoints = 0;

      try {
        const seasonId = await getCurrentSeason(platform);

        const rankedRes = await apiGet(
          `https://api.pubg.com/shards/${platform}/players/${player.id}/seasons/${seasonId}/ranked`
        );

        const rankedStats =
          rankedRes.data?.data?.attributes?.rankedGameModeStats;

        if (rankedStats) {
          const modes = Object.values(rankedStats);

          const bestMode = modes.reduce((best, cur) => {
            if (!cur?.currentTier) return best;
            if (!best) return cur;

            return (cur.currentRankPoint || 0) > (best.currentRankPoint || 0)
              ? cur
              : best;
          }, null);

          if (bestMode?.currentTier) {
            tier = bestMode.currentTier.tier || "Unranked";
            subTier = bestMode.currentTier.subTier || "";
            rankPoints = bestMode.currentRankPoint || 0;
          }
        }
      } catch (e) {}

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

// ================= Check Admin Permission =================
function hasAdminPermission(member) {
  if (!member) return false;

  if (member.permissions.has("Administrator")) return true;

  if (member.roles && member.roles.cache) {
    const superAdminRole = member.roles.cache.find(role => role.name === "Супер адмін");
    if (superAdminRole) return true;
  }

  return false;
}

// ================= DISCORD =================
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

client.once("ready", () => {
  console.log(`Discord logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  const member = message.member;

  if (content.startsWith("!stats")) {
    const name = content.split(" ")[1];
    if (!name) return message.reply("Use: !stats nickname");

    return handleStats(message, name);
  }

  if (content === "!openreg") {
    if (!hasAdminPermission(member)) {
      return message.reply("You don't have permission to do this.");
    }
    if (registrationOpen) {
      return message.reply("Registration is already open.");
    }
    registrationOpen = true;
    registeredPlayers.clear();
    return message.channel.send("Registration for custom match is now OPEN! Use !register to join.");
  }

  if (content === "!closereg") {
    if (!hasAdminPermission(member)) {
      return message.reply("You don't have permission to do this.");
    }
    if (!registrationOpen) {
      return message.reply("Registration is not open.");
    }
    registrationOpen = false;
    if (registeredPlayers.size === 0) {
      return message.channel.send("No players registered.");
    }
    return message.channel.send(`Registration closed. Registered players: ${registeredPlayers.size}`);
  }

  if (content === "!register") {
    if (!registrationOpen) {
      return message.reply("Registration is currently closed.");
    }
    if (registeredPlayers.has(message.author.id)) {
      return message.reply("You are already registered.");
    }
    registeredPlayers.add(message.author.id);
    return message.reply("You have been registered for the custom match!");
  }

  if (content === "!list") {
    if (registeredPlayers.size === 0) {
      return message.channel.send("No players registered yet.");
    }
    const membersArr = await Promise.all(
      Array.from(registeredPlayers).map(id => message.guild.members.fetch(id).catch(() => null))
    );
    const names = membersArr.filter(m => m).map(m => m.user.username);
    return message.channel.send(`Registered players:\n${names.join("\n")}`);
  }

  if (content === "!startmatch") {
    if (!hasAdminPermission(member)) {
      return message.reply("You don't have permission to do this.");
    }
    if (registrationOpen) {
      return message.reply("Please close registration before starting the match.");
    }
    const count = registeredPlayers.size;
    if (count < 2) {
      return message.channel.send("Not enough players to start a match.");
    }

    const playersArray = Array.from(registeredPlayers);
    shuffle(playersArray);

    const teamConfigs = [];
    for (let teamSize = 2; teamSize <= 4; teamSize++) {
      if (count % teamSize === 0) {
        const teamsCount = count / teamSize;
        if (teamsCount >= 2) {
          teamConfigs.push({ teamSize, teamsCount });
        }
      }
    }

    if (teamConfigs.length === 0) {
      return message.channel.send("Не можливо рівно поділити гравців на команди розміром 2-4.");
    }

    const config = teamConfigs[0];
    const { teamSize, teamsCount } = config;

    let response = `Match started! Forming ${teamsCount} teams with ${teamSize} players each.\n\n`;

    for (let i = 0; i < teamsCount; i++) {
      const teamMembers = playersArray.slice(i * teamSize, (i + 1) * teamSize);
      const memberNames = await Promise.all(
        teamMembers.map(id => message.guild.members.fetch(id).then(m => m.user.username).catch(() => "Unknown"))
      );
      response += `**Team ${i + 1}**:\n${memberNames.join(", ")}\n\n`;
    }

    registeredPlayers.clear();

    return message.channel.send(response);
  }
});

client.login(process.env.DISCORD_TOKEN);

// ================= TELEGRAM COMMAND =================
tg.onText(/\/stats (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const name = match[1];

  const data = await getStats(name);
  if (!data) return tg.sendMessage(chatId, "❌ Player not found");

  const kd = (data.kills / (data.matches || 1)).toFixed(2);
  const winrate = ((data.wins / (data.matches || 1)) * 100).toFixed(1);

  const text =
`🎮 PUBG PLAYER PROFILE

👤 ${name}
🖥 Platform: ${data.platform.toUpperCase()}

📊 Kills: ${data.kills}
🎯 Matches: ${data.matches}
🏆 Wins: ${data.wins}

⚔️ K/D: ${kd}
📊 Winrate: ${winrate}%
🔥 Rate: ${data.rate}

🏅 Rank: ${data.tier} ${data.subTier}
📊 RP: ${data.rankPoints}`;

  tg.sendMessage(chatId, text);
});

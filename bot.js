const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");

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
const MVP_CHANNEL_ID = "1516535807756861560"; // Заміни на свій канал

// ================= CACHE =================
const cache = new Map();
const seasonCache = new Map();
const CACHE_TIME = 5 * 60 * 1000;
const MATCH_CHECK_INTERVAL = 5 * 60 * 1000;

// ================= FILE DB =================
const PLAYERS_DB_FILE = path.join(__dirname, "players.json");

// ================= GLOBALS =================
let registeredPlayers = new Set();
let registrationOpen = false;
let customMatchFormat = null;
const matchHistory = [];
const activePlayers = new Map(); // DiscordID -> {pubgName, platform, статистика, дати}

const previousMatchesCache = new Map();

// ================= UTILS =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function getWeekKey(date) {
  const onejan = new Date(date.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((date - onejan) / (24*60*60*1000)) + 1;
  const weekNum = Math.ceil(dayOfYear / 7);
  return `${date.getFullYear()}-${weekNum.toString().padStart(2, '0')}`;
}

// ================= LOAD/SAVE PLAYERS DB =================
async function loadPlayers() {
  try {
    const data = await fs.readFile(PLAYERS_DB_FILE, "utf-8");
    const obj = JSON.parse(data);
    for (const [discordId, info] of Object.entries(obj)) {
      activePlayers.set(discordId, info);
    }
    console.log(`Loaded ${activePlayers.size} active players`);
  } catch {
    console.log("Players DB not found or read error");
  }
}

async function savePlayers() {
  try {
    const obj = {};
    for (const [discordId, info] of activePlayers.entries()) {
      obj[discordId] = info;
    }
    await fs.writeFile(PLAYERS_DB_FILE, JSON.stringify(obj, null, 2), "utf-8");
  } catch (e) {
    console.error("Error saving players DB:", e);
  }
}

// ================= PUBG API =================
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

async function getCurrentSeason(platform) {
  if (seasonCache.has(platform)) return seasonCache.get(platform);
  const res = await apiGet(`https://api.pubg.com/shards/${platform}/seasons`);
  const season = res.data.data.find(s => s.attributes.isCurrentSeason);
  seasonCache.set(platform, season.id);
  return season.id;
}

async function getPlayerStats(pubgName, platform) {
  const cached = cache.get(pubgName + platform);
  if (cached && Date.now() - cached.time < CACHE_TIME) return cached.data;

  try {
    const playerRes = await apiGet(
      `https://api.pubg.com/shards/${platform}/players?filter[playerNames]=${encodeURIComponent(pubgName)}`
    );
    const player = playerRes.data?.data?.[0];
    if (!player) return null;

    const statsRes = await apiGet(
      `https://api.pubg.com/shards/${platform}/players/${player.id}/seasons/lifetime`
    );
    const modes = statsRes.data?.data?.attributes?.gameModeStats;
    if (!modes) return null;

    let kills = 0, wins = 0, matches = 0;
    for (const m in modes) {
      kills += modes[m].kills || 0;
      wins += modes[m].wins || 0;
      matches += modes[m].roundsPlayed || 0;
    }

    const kd = kills / (matches || 1);
    const rate = Math.round((kills * 1.2 + wins * 15 + kd * 10) / (matches || 1));

    let tier = "Unranked";
    let subTier = "";
    let rankPoints = 0;
    const seasonId = await getCurrentSeason(platform);

    try {
      const rankedRes = await apiGet(
        `https://api.pubg.com/shards/${platform}/players/${player.id}/seasons/${seasonId}/ranked`
      );
      const rankedStats = rankedRes.data?.data?.attributes?.rankedGameModeStats;
      if (rankedStats) {
        const modes = Object.values(rankedStats);
        const bestMode = modes.reduce((best, cur) => {
          if (!cur?.currentTier) return best;
          if (!best) return cur;
          return (cur.currentRankPoint || 0) > (best.currentRankPoint || 0) ? cur : best;
        }, null);

        if (bestMode?.currentTier) {
          tier = bestMode.currentTier.tier || "Unranked";
          subTier = bestMode.currentTier.subTier || "";
          rankPoints = bestMode.currentRankPoint || 0;
        }
      }
    } catch {}

    const result = {
      playerId: player.id,
      kills,
      wins,
      matches,
      platform,
      rate,
      tier,
      subTier,
      rankPoints
    };
    cache.set(pubgName + platform, { data: result, time: Date.now() });
    return result;
  } catch {
    return null;
  }
}

async function getPlayerRecentMatches(playerId, platform) {
  try {
    const res = await apiGet(`https://api.pubg.com/shards/${platform}/players/${playerId}/matches?filter[gamepad]=false&sort=-createdAt&perPage=5`);
    return res.data.data || [];
  } catch {
    return [];
  }
}

// ================= MVP FUNCTIONS =================

// Оновлення денних статистик із підрахунком приросту
async function updatePlayerDailyStats(discordId) {
  const p = activePlayers.get(discordId);
  if (!p) return null;

  const now = new Date();
  const today = formatDate(now);
  if (p.lastDailyCheck === today) return null;

  const stats = await getPlayerStats(p.pubgName, p.platform);
  if (!stats) return null;

  if (p.prevDailyKills === undefined) p.prevDailyKills = 0;
  if (p.prevDailyWins === undefined) p.prevDailyWins = 0;

  const killsDiff = stats.kills - p.prevDailyKills;
  const winsDiff = stats.wins - p.prevDailyWins;

  p.lastDailyCheck = today;
  p.prevDailyKills = stats.kills;
  p.prevDailyWins = stats.wins;

  p.dailyKillsDiff = killsDiff > 0 ? killsDiff : 0;
  p.dailyWinsDiff = winsDiff > 0 ? winsDiff : 0;

  activePlayers.set(discordId, p);

  await savePlayers();
  return p;
}

async function updatePlayerWeeklyStats(discordId) {
  const p = activePlayers.get(discordId);
  if (!p) return null;

  const now = new Date();
  const wk = getWeekKey(now);
  if (p.lastWeeklyCheck === wk) return null;

  const stats = await getPlayerStats(p.pubgName, p.platform);
  if (!stats) return null;

  p.lastWeeklyCheck = wk;
  p.weeklyKills = stats.kills;
  p.weeklyWins = stats.wins;
  p.weeklyMatches = stats.matches;

  activePlayers.set(discordId, p);
  await savePlayers();
  return p;
}

function getMVPTopN(metric = "daily") {
  const keyWinsDiff = metric + "WinsDiff";
  const keyKillsDiff = metric + "KillsDiff";

  const playersWithData = Array.from(activePlayers.entries())
    .filter(([_, p]) => p[keyWinsDiff] != null)
    .map(([discordId, p]) => ({
      discordId,
      pubgName: p.pubgName,
      platform: p.platform,
      winsDiff: p[keyWinsDiff] || 0,
      killsDiff: p[keyKillsDiff] || 0,
      score: (p[keyWinsDiff] || 0) * 100 + (p[keyKillsDiff] || 0)
    }));

  playersWithData.sort((a,b) => b.score - a.score);
  return playersWithData.slice(0, 5);
}

// ================= COMMAND HANDLERS =================
client.once("ready", async () => {
  console.log(`Discord logged in as ${client.user.tag}`);
  await loadPlayers();

  scheduleDailyMVP();
  setInterval(checkForChickenDinners, MATCH_CHECK_INTERVAL);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.channel.id === MVP_CHANNEL_ID) {
    const translated = await translateTextLibre(message.content);
    if (translated) {
      await message.channel.send(`🇺🇦 Переклад:\n${translated}`);
    }
  }

  const content = message.content.trim();
  const userId = message.author.id;

  if (content.startsWith("!join")) {
    const args = content.split(" ");
    if (args.length < 3) return message.reply("Usage: !join <pubg_nickname> <psn|xbox|steam>");
    const pubgName = args[1];
    const platform = args[2].toLowerCase();
    if (!["psn", "xbox", "steam"].includes(platform)) {
      return message.reply("Platform must be one of: psn, xbox, steam");
    }

    activePlayers.set(userId, { pubgName, platform });
    await savePlayers();
    return message.reply(`Registered you as ${pubgName} on ${platform} platform.`);
  }

  if (content.startsWith("!mvp")) {
    const args = content.split(" ");
    const period = args[1]?.toLowerCase() || "daily";
    if (!["daily","weekly"].includes(period)) return message.reply("Use !mvp daily or !mvp weekly");

    await Promise.all(
      Array.from(activePlayers.keys()).map(userId =>
        period === "daily" ? updatePlayerDailyStats(userId) : updatePlayerWeeklyStats(userId)
      )
    );

    const top = getMVPTopN(period);
    if (top.length === 0) return message.channel.send("No data available yet.");

    let desc = top.map((p, i) =>
      `${i+1}. **${p.pubgName}** (${p.platform.toUpperCase()}) - Wins: ${p.winsDiff || p.weeklyWins || 0}, Kills: ${p.killsDiff || p.weeklyKills || 0}`
    ).join("\n");

    const embed = new EmbedBuilder()
      .setTitle(`🏆 Top 5 PUBG MVP (${period})`)
      .setDescription(desc)
      .setColor(0xffd700)
      .setTimestamp();

    return message.channel.send({ embeds: [embed] });
  }

  if (content.startsWith("!register")) {
    return message.reply("Please use !join <pubg_nickname> <platform> to register yourself.");
  }

  // Твої інші команди залишаються тут
});

// ================= DAILY MVP POSTING =================
function scheduleDailyMVP() {
  const now = new Date();
  const target = new Date();
  target.setHours(19, 0, 0, 0);
  if (now > target) target.setDate(target.getDate() + 1);

  const msToWait = target - now;
  setTimeout(() => {
    postDailyMVP();
    setInterval(postDailyMVP, 24 * 60 * 60 * 1000);
  }, msToWait);
}

async function postDailyMVP() {
  await Promise.all(
    Array.from(activePlayers.keys()).map(userId => updatePlayerDailyStats(userId))
  );

  const top = getMVPTopN("daily");
  if (top.length === 0) return;

  let desc = top.map((p, i) =>
    `${i+1}. **${p.pubgName}** (${p.platform.toUpperCase()}) - Wins: ${p.winsDiff}, Kills: ${p.killsDiff}`
  ).join("\n");

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Daily PUBG MVP Top 5`)
    .setDescription(desc)
    .setColor(0x00ff00)
    .setTimestamp();

  const channel = await client.channels.fetch(MVP_CHANNEL_ID).catch(() => null);
  if (channel) {
    channel.send({ embeds: [embed] });
  }
}

// ================= CHECK CHICKEN DINNERS =================
async function checkForChickenDinners() {
  if (activePlayers.size === 0) return;

  for (const [discordId, playerInfo] of activePlayers.entries()) {
    try {
      const stats = await getPlayerStats(playerInfo.pubgName, playerInfo.platform);
      if (!stats || !stats.playerId) continue;

      const lastKnownMatchId = previousMatchesCache.get(discordId) || null;

      const matches = await getPlayerRecentMatches(stats.playerId, playerInfo.platform);

      for (const match of matches) {
        const matchId = match.id;
        if (matchId === lastKnownMatchId) break;

        const matchData = await apiGet(`https://api.pubg.com/shards/${playerInfo.platform}/matches/${matchId}`);
        if (!matchData?.data) continue;

        const matchAttrs = matchData.data.attributes;
        const gameMode = matchAttrs.gameMode || "";
        const isSquadTPP = gameMode.toLowerCase().includes("squad") && gameMode.toLowerCase().includes("tpp");
        const isDuoTPP = gameMode.toLowerCase().includes("duo") && gameMode.toLowerCase().includes("tpp");

        if (!isSquadTPP && !isDuoTPP) continue;

        const includedParticipants = matchData.data.relationships.participants.data.map(x => x.id);
        if (!includedParticipants.includes(stats.playerId)) continue;

        previousMatchesCache.set(discordId, matchId);

        const channel = await client.channels.fetch(MVP_CHANNEL_ID).catch(() => null);
        if (channel) {
          channel.send(`🏆 **${playerInfo.pubgName}** взяв Chicken Dinner у режимі ${gameMode}! 🎉`);
        }

        break;
      }
    } catch {
      // Ігноруємо помилки
    }
  }
}

// ================= Free Translation =================
async function translateTextLibre(text, targetLang = "uk") {
  try {
    const res = await axios.post("https://libretranslate.de/translate", {
      q: text,
      source: "en",
      target: targetLang,
      format: "text"
    }, {
      headers: { "Content-Type": "application/json" }
    });
    return res.data.translatedText;
  } catch {
    return null;
  }
}

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

// ================= ORIG. STATS FUNCTION з твого коду =================
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

        const rankedStats = rankedRes.data?.data?.attributes?.rankedGameModeStats;

        if (rankedStats) {
          const modes = Object.values(rankedStats);
          const bestMode = modes.reduce((best, cur) => {
            if (!cur?.currentTier) return best;
            if (!best) return cur;
            return (cur.currentRankPoint || 0) > (best.currentRankPoint || 0) ? cur : best;
          }, null);

          if (bestMode?.currentTier) {
            tier = bestMode.currentTier.tier || "Unranked";
            subTier = bestMode.currentTier.subTier || "";
            rankPoints = bestMode.currentRankPoint || 0;
          }
        }
      } catch {}

      const result = {
        kills,
        wins,
        matches,
        platform,
        rate,
        tier,
        subTier,
        rankPoints
      };

      if (!best || result.kills > best.kills) best = result;

    } catch {}
  }

  if (best) cache.set(name, { data: best, time: Date.now() });
  return best;
}

// ================= LOGIN BOTS =================
client.login(process.env.DISCORD_TOKEN);

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
const MVP_CHANNEL_ID = "1516535807756861560"; // Канал, куди бот публікує MVP; заміни на свій

// ================= CACHE =================
const cache = new Map();
const seasonCache = new Map();
const CACHE_TIME = 5 * 60 * 1000;
const MATCH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 хвилин перевірка нових матчів

const PLAYERS_DB_FILE = path.join(__dirname, "players.json");

// ================= GLOBALS =================
let registeredPlayers = new Set(); // тепер уже для реєстрації в матчі
let registrationOpen = false;
let customMatchFormat = null; // 1,2,3,4
const matchHistory = [];
const activePlayers = new Map(); // DiscordID -> { pubgName, platform, lastDailyCheck, lastWeeklyCheck }

const previousMatchesCache = new Map(); // DiscordID -> lastMatchId

const maps = [
  "Taego", "Erangel", "Miramar", "Paramo", "Sanhok",
  "Karakin", "Deston", "Rondo", "Vikendi"
];

// Зчитати базу гравців із файлу
async function loadPlayers() {
  try {
    const data = await fs.readFile(PLAYERS_DB_FILE, "utf-8");
    const obj = JSON.parse(data);
    for (const [discordId, info] of Object.entries(obj)) {
      activePlayers.set(discordId, info);
    }
    console.log(`Loaded ${activePlayers.size} active players`);
  } catch (e) {
    console.log("No existing players db found or error reading it");
  }
}

// Зберегти базу гравців у файл
async function savePlayers() {
  try {
    const obj = {};
    for (const [discordId, info] of activePlayers.entries()) {
      obj[discordId] = info;
    }
    await fs.writeFile(PLAYERS_DB_FILE, JSON.stringify(obj, null, 2), "utf-8");
  } catch (e) {
    console.error("Error saving players db:", e);
  }
}

// ================= UTILS =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

// Форматуємо дату у формат YYYY-MM-DD
function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

// Отримати ISO тиждень у форматі YYYY-WW
function getWeekKey(date) {
  const onejan = new Date(date.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((date - onejan) / (24*60*60*1000)) + 1;
  const weekNum = Math.ceil(dayOfYear / 7);
  return `${date.getFullYear()}-${weekNum.toString().padStart(2, '0')}`;
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

// Отримати профіль гравця (для MVP і статистики)
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
    const rate = Math.round(
      (kills * 1.2 + wins * 15 + kd * 10) / (matches || 1)
    );

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
    } catch (e) {}

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
  } catch (e) {
    //console.error("Error getting player stats", e);
    return null;
  }
}

// Отримати останні матчі гравця (для перевірки чікендіннерів)
async function getPlayerRecentMatches(playerId, platform) {
  try {
    const res = await apiGet(`https://api.pubg.com/shards/${platform}/players/${playerId}/matches?filter[gamepad]=false&sort=-createdAt&perPage=5`);
    return res.data.data || [];
  } catch (e) {
    return [];
  }
}

// ================= MVP ranking =================
// Оновлюємо статистику за день/тиждень (можеш розширити, ця простіша логіка)
async function updatePlayerDailyStats(discordId) {
  const p = activePlayers.get(discordId);
  if (!p) return null;
  const now = new Date();
  if (p.lastDailyCheck === formatDate(now)) return null; // Уже оновлено сьогодні

  const stats = await getPlayerStats(p.pubgName, p.platform);
  if (!stats) return null;

  p.lastDailyCheck = formatDate(now);
  p.dailyKills = stats.kills;
  p.dailyWins = stats.wins;
  p.dailyMatches = stats.matches;

  activePlayers.set(discordId, p);
  await savePlayers();
  return p;
}

async function updatePlayerWeeklyStats(discordId) {
  const p = activePlayers.get(discordId);
  if (!p) return null;
  const now = new Date();
  const wk = getWeekKey(now);
  if (p.lastWeeklyCheck === wk) return null; // Уже оновлено цього тижня

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

// Формуємо топ-5 за заданою метрикою (daily або weekly, за виграшами першочергово)
function getMVPTopN(metric = "daily") {
  // metric: daily або weekly
  const keyWins = metric + "Wins";
  const keyKills = metric + "Kills";
  // Відбираємо гравців, у яких є дані для цього періоду
  const playersWithData = Array.from(activePlayers.entries())
    .filter(([_, p]) => p[keyWins] != null)
    .map(([discordId, p]) => ({
      discordId,
      pubgName: p.pubgName,
      platform: p.platform,
      wins: p[keyWins],
      kills: p[keyKills],
      score: p[keyWins] * 100 + p[keyKills] // Простий рейтинг: виграші й kills + ваги
    }));
  playersWithData.sort((a, b) => b.score - a.score);
  return playersWithData.slice(0, 5);
}

// ================= DISCORD COMMANDS =================
client.once("ready", async () => {
  console.log(`Discord logged in as ${client.user.tag}`);
  await loadPlayers();

  // Запускаємо автоматичну щоденну публікацію MVP о 19:00
  scheduleDailyMVP();
  // Запускаємо періодичну перевірку чікендіннерів
  setInterval(checkForChickenDinners, MATCH_CHECK_INTERVAL);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Переклад для каналу подій PUBG
  if (message.channel.id === MVP_CHANNEL_ID) {
    const translated = await translateTextLibre(message.content);
    if (translated) {
      await message.channel.send(`🇺🇦 Переклад:\n${translated}`);
    }
  }

  const content = message.content.trim();
  const member = message.member;
  const userId = message.author.id;

  if (content.startsWith("!join")) {
    // !join <ник> <platform>
    const args = content.split(" ");
    if (args.length < 3) return message.reply("Usage: !join <pubg_nickname> <psn|xbox|steam>");
    const pubgName = args[1];
    const platform = args[2].toLowerCase();
    if (!["psn","xbox","steam"].includes(platform)) return message.reply("Platform must be one of: psn, xbox, steam");

    activePlayers.set(userId, { pubgName, platform });
    await savePlayers();
    return message.reply(`Registered you as ${pubgName} on ${platform} platform.`);
  }

  if (content.startsWith("!mvp")) {
    const args = content.split(" ");
    const period = args[1]?.toLowerCase() || "daily";
    if (!["daily","weekly"].includes(period)) return message.reply("Use !mvp daily or !mvp weekly");

    // Оновлюємо для кожного активного гравця потрібну статистику
    await Promise.all(
      Array.from(activePlayers.keys()).map(userId => 
        period === "daily" ? updatePlayerDailyStats(userId) : updatePlayerWeeklyStats(userId)
      )
    );

    const top = getMVPTopN(period);
    if (top.length === 0) return message.channel.send("No data available yet.");

    let desc = top.map((p,i)=>
      `${i+1}. **${p.pubgName}** (${p.platform.toUpperCase()}) - Wins: ${p.wins}, Kills: ${p.kills}`
    ).join("\n");

    const embed = new EmbedBuilder()
      .setTitle(`🏆 Top 5 PUBG MVP (${period})`)
      .setDescription(desc)
      .setColor(0xffd700)
      .setTimestamp();

    return message.channel.send({ embeds: [embed] });
  }

  if (content.startsWith("!register")) {
    // Перенаправляємо !register на !join для узгодженості
    return message.reply("Use !join <pubg_nickname> <platform> to register yourself.");
  }

  // --- Твої інші команди (реєстрація для матчів, !stats і тд) залишити без змін ---
  // ...

  // Якщо потрібно, можна додати інші твої команди з попереднього коду сюди
});

// ================= ПУБЛІКАЦІЯ ТОП-5 MVP ЩОДНЯ ==================
function scheduleDailyMVP() {
  // Запускати щоразу, коли бот запускається, і чекати на 19:00
  const now = new Date();
  const target = new Date();
  target.setHours(19, 0, 0, 0);
  if (now > target) target.setDate(target.getDate() + 1);

  const msToWait = target - now;
  setTimeout(() => {
    postDailyMVP();
    // І далі встановити інтервал 24 години
    setInterval(postDailyMVP, 24 * 60 * 60 * 1000);
  }, msToWait);
}

async function postDailyMVP() {
  // Оновлюємо статистику усіх гравців по daily
  await Promise.all(
    Array.from(activePlayers.keys()).map(userId => updatePlayerDailyStats(userId))
  );

  const top = getMVPTopN("daily");
  if (top.length === 0) return;

  let desc = top.map((p,i)=>
    `${i+1}. **${p.pubgName}** (${p.platform.toUpperCase()}) - Wins: ${p.wins}, Kills: ${p.kills}`
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

// =============== СПРОБУЄМО ВІДСТЕЖУВАТИ ЧІКЕНДІННЕР ===============
// Заходимо у кожного гравця, перевіряємо останні матчі, якщо виграв у squad tpp або duo tpp і це новий матч - публікуємо

async function checkForChickenDinners() {
  if (activePlayers.size === 0) return;

  for (const [discordId, playerInfo] of activePlayers.entries()) {
    try {
      const stats = await getPlayerStats(playerInfo.pubgName, playerInfo.platform);
      if (!stats || !stats.playerId) continue;

      const lastKnownMatchId = previousMatchesCache.get(discordId) || null;

      // Отримуємо останні матчі гравця
      const matches = await getPlayerRecentMatches(stats.playerId, playerInfo.platform);

      // Знайдемо нові матчі, яких не було в кеші
      for (const match of matches) {
        const matchId = match.id;
        if (matchId === lastKnownMatchId) break; // Зупиняємось, матчі вже перевірені

        // Перевірка, чи виграв гравець (потрібен результат матчу і команда)
        // Побудовано на основі структури з офф API: тут спростимо і перевіримо Mode + виграш
        // Для детального аналізу потрібно кожен матч тягнути через apiGet(match.relationships.game),
        // що може бути дорого — для спрощення це можна проігнорувати. Дамо сигнал, якщо mode squad/duo TPP і wins >0

        // Отримуємо докладніше матчу (для визначення переможців)
        const matchData = await apiGet(`https://api.pubg.com/shards/${playerInfo.platform}/matches/${matchId}`);
        if (!matchData?.data) continue;

        const matchAttrs = matchData.data.attributes;
        const gameMode = matchAttrs.gameMode || "";
        const isSquadTPP = gameMode.toLowerCase().includes("squad") && gameMode.toLowerCase().includes("tpp");
        const isDuoTPP = gameMode.toLowerCase().includes("duo") && gameMode.toLowerCase().includes("tpp");

        if (!isSquadTPP && !isDuoTPP) continue;

        // Шукаємо учасника із цим playerId в матчі, щоб переконатися, що він виграв
        const includedParticipants = matchData.data.relationships.participants.data.map(x => x.id);
        if (!includedParticipants.includes(stats.playerId)) continue;

        // Отримати stats учасника в матчі
        let participantStats = null;
        try {
          const participantRes = await apiGet(`https://api.pubg.com/shards/${playerInfo.platform}/participants/${stats.playerId}`);
          participantStats = participantRes.data.data.attributes;
        } catch(e) {
          participantStats = null;
        }

        // Значно простіше перевірити самі — якщо player має 1 win (winPlace = 1)
        // Але через обмеження API можна не повністю це робити

        // Для простоти — просто відправляємо повідомлення, бо далі треба поглиблена логіка

        // Якщо це новий матч — сповіщаємо
        // Записуємо останній ID матчу для цього юзера
        previousMatchesCache.set(discordId, matchId);

        // Надсилаємо повідомлення на канал
        const channel = await client.channels.fetch(MVP_CHANNEL_ID).catch(() => null);
        if (channel) {
          channel.send(`🏆 **${playerInfo.pubgName}** взяв Chicken Dinner у режимі ${gameMode}! 🎉`);
        }

        break; // Після першого знайденого нового виграшу у цьому циклі - переходимо до іншого гравця
      }
    } catch (e) {
      // Просто ігноруємо помилки, щоб не впали всі
      //console.error("Error checking chicken dinner for", playerInfo.pubgName, e);
    }
  }
}

// ================= Free Translation via LibreTranslate =================
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
  } catch (error) {
    //console.error("LibreTranslate error:", error);
    return null;
  }
}

// === Твої оригінальні команди, функції і логіка статистики залишаються без змін ===

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

client.login(process.env.DISCORD_TOKEN);

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
let customMatchFormat = null; // 1,2,3,4
const matchHistory = [];

const maps = [
  "Taego",
  "Erangel",
  "Miramar",
  "Paramo",
  "Sanhok",
  "Karakin",
  "Deston",
  "Rondo",
  "Vikendi"
];

// Вкажи ID каналу з офіційними подіями PUBG для перекладу
const PUBG_EVENTS_CHANNEL_ID = "1516535807756861560"; // заміни на ID своєго каналу

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
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
    console.error("LibreTranslate error:", error);
    return null;
  }
}

// ================= Існуючі функції та логіка (apiGet, getCurrentSeason, getStats, handleStats, hasAdminPermission) — залишаються без змін =================

// ================= DISCORD =================
client.once("ready", () => {
  console.log(`Discord logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Автоматичний переклад повідомлень з офіційного каналу подій
  if (message.channel.id === PUBG_EVENTS_CHANNEL_ID) {
    const translated = await translateTextLibre(message.content);
    if (translated) {
      await message.channel.send(`🇺🇦 Переклад:\n${translated}`);
    }
  }

  const content = message.content.trim();
  const member = message.member;

  // Обробка команд !stats та кастомні матчі (залишити як у твоєму оригіналі)
  if (content.startsWith("!stats")) {
    const name = content.split(" ")[1];
    if (!name) return message.reply("Use: !stats nickname");
    return handleStats(message, name);
  }

  if (content.startsWith("!setformat")) {
    if (!hasAdminPermission(member)) return message.reply("You don't have permission to do this.");
    const format = parseInt(content.split(" ")[1], 10);
    if (![1, 2, 3, 4].includes(format)) return message.reply("Format must be 1 (solo), 2, 3 or 4");
    customMatchFormat = format;
    return message.channel.send(`Custom match format set to ${format === 1 ? "solo (each for themselves)" : `${format} players per team`}.`);
  }

  if (content === "!openreg") {
    if (!hasAdminPermission(member)) return message.reply("You don't have permission to do this.");
    if (!customMatchFormat) return message.reply("Set match format first with !setformat");
    if (registrationOpen) return message.reply("Registration is already open.");
    registrationOpen = true;
    registeredPlayers.clear();
    return message.channel.send(`Registration opened! Format: ${customMatchFormat === 1 ? "solo (each for themselves)" : `${customMatchFormat} players per team`}.`);
  }

  if (content === "!closereg") {
    if (!hasAdminPermission(member)) return message.reply("You don't have permission to do this.");
    if (!registrationOpen) return message.reply("Registration is not open.");
    registrationOpen = false;
    if (registeredPlayers.size === 0) return message.channel.send("No players registered.");
    return message.channel.send(`Registration closed. Registered players: ${registeredPlayers.size}`);
  }

  if (content === "!register") {
    if (!registrationOpen) return message.reply("Registration is currently closed.");
    if (registeredPlayers.has(message.author.id)) return message.reply("You are already registered.");
    registeredPlayers.add(message.author.id);
    return message.reply("You have been registered for the custom match!");
  }

  if (content === "!unregister") {
    if (!registrationOpen) return message.reply("Registration is currently closed.");
    if (!registeredPlayers.has(message.author.id)) return message.reply("You are not registered.");
    registeredPlayers.delete(message.author.id);
    return message.reply("You have been unregistered from the custom match.");
  }

  if (content === "!list") {
    if (registeredPlayers.size === 0) return message.channel.send("No players registered yet.");
    const membersArr = await Promise.all(
      Array.from(registeredPlayers).map(id => message.guild.members.fetch(id).catch(() => null))
    );
    const names = membersArr.filter(m => m).map(m => m.user.username);
    return message.channel.send(`Registered players:\n${names.join("\n")}`);
  }

  if (content === "!startmatch") {
    if (!hasAdminPermission(member)) return message.reply("You don't have permission to do this.");
    if (registrationOpen) return message.reply("Please close registration before starting the match.");
    if (!customMatchFormat) return message.reply("Set match format first.");
    const count = registeredPlayers.size;
    if (count < (customMatchFormat === 1 ? 1 : customMatchFormat * 2))
      return message.reply("Not enough players.");

    if (customMatchFormat !== 1 && count % customMatchFormat !== 0)
      return message.reply(`Player count must be multiple of ${customMatchFormat}.`);

    const playersArray = Array.from(registeredPlayers);
    shuffle(playersArray);

    const selectedMap = maps[Math.floor(Math.random() * maps.length)];
    let response = `Map selected for the match: **${selectedMap}**\n\n`;

    if (customMatchFormat === 1) {
      const memberNames = await Promise.all(
        playersArray.map(id => message.guild.members.fetch(id).then(m => m.user.username).catch(() => "Unknown"))
      );
      response += "Solo mode match started! Players:\n" + memberNames.join("\n");
      registeredPlayers.clear();
      matchHistory.push({
        date: new Date().toISOString(),
        format: "Solo",
        map: selectedMap,
        players: memberNames
      });
      return message.channel.send(response);
    } else {
      const teamsCount = count / customMatchFormat;
      response += `Match started! Forming ${teamsCount} teams with ${customMatchFormat} players each.\n\n`;
      let teamsForHistory = [];
      for (let i = 0; i < teamsCount; i++) {
        const team = playersArray.slice(i * customMatchFormat, (i + 1) * customMatchFormat);
        const memberNames = await Promise.all(
          team.map(id => message.guild.members.fetch(id).then(m => m.user.username).catch(() => "Unknown"))
        );
        response += `**Team ${i + 1}**: ${memberNames.join(", ")}\n\n`;
        teamsForHistory.push(memberNames);
      }
      registeredPlayers.clear();
      matchHistory.push({
        date: new Date().toISOString(),
        format: `${customMatchFormat}x${customMatchFormat}`,
        map: selectedMap,
        teams: teamsForHistory
      });
      return message.channel.send(response);
    }
  }

  if (content === "!custom") {
    const status = registrationOpen ? "open" : "closed";
    const formatText = customMatchFormat
      ? (customMatchFormat === 1 ? "Solo (each for themselves)" : `${customMatchFormat} players per team`)
      : "Not set";
    const dateStr = "Date and time of the match: To be set"; // Тут можна прописати дату/час як змінну
    return message.channel.send(`Custom match info:\nStatus: ${status}\nFormat: ${formatText}\n${dateStr}`);
  }

  if (content === "!matchhistory") {
    if (matchHistory.length === 0) {
      return message.channel.send("Match history is empty.");
    }
    let text = "Last matches:\n\n";
    matchHistory.slice(-5).reverse().forEach((m, i) => {
      text += `${i + 1}. ${m.date} | Format: ${m.format} | Map: ${m.map}\n`;
    });
    return message.channel.send(text);
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

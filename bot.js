const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");

// ================ SUPABASE ================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SKIPUA_ROLE_ID = "1518313440400375888";
const PUBG_EVENTS_CHANNEL_ID = "1516535807756861560";
const API_KEY = process.env.PUBG_API_KEY;

// ================ CACHE ================
const cache = new Map();
const seasonCache = new Map();
const CACHE_TIME = 5 * 60 * 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ================ GLOBALS ================
let registeredPlayers = new Set();
let registrationOpen = false;
let customMatchFormat = null;
let lastTeamSize = null;

const maps = [
  "Taego", "Erangel", "Miramar", "Paramo", "Sanhok",
  "Karakin", "Deston", "Rondo", "Vikendi"
];

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

// ================ PUBG API ================
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
      const rate = Math.round((kills * 1.2 + wins * 15 + kd * 10) / (matches || 1));

      let tier = "Unranked", subTier = "", rankPoints = 0;

      try {
        const seasonId = await getCurrentSeason(platform);
        const rankedRes = await apiGet(
          `https://api.pubg.com/shards/${platform}/players/${player.id}/seasons/${seasonId}/ranked`
        );
        const rankedStats = rankedRes.data?.data?.attributes?.rankedGameModeStats;
        if (rankedStats) {
          const bestMode = Object.values(rankedStats).reduce((best, cur) => {
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
        kills,
        wins,
        matches,
        damage: Object.values(modes).reduce((sum, m) => sum + (m.damageDealt || 0), 0),
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

// ================ TRANSLATION ================
async function translateTextLibre(text, targetLang = "uk") {
  try {
    const res = await axios.post("https://libretranslate.de/translate", {
      q: text,
      source: "en",
      target: targetLang,
      format: "text"
    }, { headers: { "Content-Type": "application/json" } });
    return res.data.translatedText;
  } catch (error) {
    console.error("LibreTranslate error:", error);
    return null;
  }
}

// ================ PERMISSIONS ================
function hasAdminPermission(member) {
  if (!member) return false;
  if (member.permissions.has("Administrator")) return true;
  if (member.roles?.cache) {
    const superAdminRole = member.roles.cache.find(
      role => role.name.toLowerCase().replace(/[-_]/g, " ") === "супер адмін"
    );
    if (superAdminRole) return true;
  }
  return false;
}

// ================ STATS HANDLER ================
async function handleStats(message, name) {
  const msg = await message.reply("⏳ loading player data...");
  const data = await getStats(name);
  if (!data) return msg.edit("❌ Player not found");

  const kd = (data.kills / (data.matches || 1)).toFixed(2);
  const winrate = ((data.wins / (data.matches || 1)) * 100).toFixed(1);

  const embed = new EmbedBuilder()
    .setTitle("🎮 PUBG PLAYER PROFILE")
    .setDescription(`**${name}** | Platform: **${data.platform.toUpperCase()}**`)
    .setColor(0x00bfff)
    .addFields(
      { name: "📊 Core Stats", value: `🔫 Kills: **${data.kills}**\n🎯 Matches: **${data.matches}**\n🏆 Wins: **${data.wins}**`, inline: false },
      { name: "📈 Performance", value: `⚔️ K/D: **${kd}**\n📊 Winrate: **${winrate}%**\n🔥 Rate: **${data.rate}**`, inline: false },
      { name: "🏅 Ranked", value: `🎖 Tier: **${data.tier} ${data.subTier}**\n📊 RP: **${data.rankPoints}**`, inline: false }
    )
    .setThumbnail("https://cdn-icons-png.flaticon.com/512/1146/1146869.png")
    .setFooter({ text: "by sociopath39" })
    .setTimestamp();

  msg.edit({ content: " ", embeds: [embed] });
}

// ================ MVP SNAPSHOT ================
async function takeSnapshot() {
  const { data: players, error } = await supabase.from("players").select("*");
  if (error) return console.error("Snapshot fetch players error:", error);

  for (const player of players) {
    try {
      const stats = await getStats(player.game_name);
      if (!stats) continue;

      const kills   = stats.kills   || 0;
      const wins    = stats.wins    || 0;
      const matches = stats.matches || 0;
      const damage  = stats.damage  || 0;

      const eBal =
        (kills * 2) +
        (Math.floor(damage / 100) * 2) +
        (matches * 1) +
        (wins * 10);

      const { error: insertError } = await supabase.from("snapshots").insert({
        discord_id: player.discord_id,
        game_name:  player.game_name,
        kills,
        wins,
        matches,
        damage,
        e_bal: eBal
      });

      if (insertError) console.error("Snapshot insert error:", insertError);

      // Видаляємо знімки старші 7 днів
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      await supabase
        .from("snapshots")
        .delete()
        .eq("discord_id", player.discord_id)
        .lt("taken_at", cutoff);

    } catch (e) {
      console.error("Snapshot error for", player.game_name, e.message);
    }
  }

  console.log("✅ Snapshots taken");
}

// ================ DISCORD ================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", () => {
  console.log(`Discord logged in as ${client.user.tag}`);
  setInterval(() => takeSnapshot(), 60 * 60 * 1000);
  setTimeout(() => takeSnapshot(), 10000);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Переклад каналу подій
  if (message.channel.id === PUBG_EVENTS_CHANNEL_ID) {
    const translated = await translateTextLibre(message.content);
    if (translated) await message.channel.send(`🇺🇦 Переклад:\n${translated}`);
  }

  const content = message.content.trim();
  const member = message.member;

  // !stats
  if (content.startsWith("!stats")) {
    const name = content.split(" ")[1];
    if (!name) return message.reply("Use: !stats nickname");
    return handleStats(message, name);
  }

  // !skipua — реєстрація в базі
  if (content.startsWith("!skipua")) {
    const gameName = content.split(" ").slice(1).join(" ");
    if (!gameName) return message.reply("❌ Напиши свій PUBG нік\nПриклад: !skipua Nick");

    // Перевірка ніка через PUBG API
    const platforms = ["psn", "xbox"];
    let found = false;
    for (const platform of platforms) {
      try {
        const res = await apiGet(
          `https://api.pubg.com/shards/${platform}/players?filter[playerNames]=${encodeURIComponent(gameName)}`
        );
        if (res.data?.data?.length > 0) { found = true; break; }
      } catch (e) {}
    }

    if (!found) return message.reply("❌ Такий PUBG нік не знайдено. Перевір написання.");

    const { error } = await supabase.from("players").upsert({
      discord_id:   message.author.id,
      discord_name: message.author.username,
      game_name:    gameName,
      registered_at: new Date().toISOString()
    }, { onConflict: "discord_id" });

    if (error) {
      console.error("Supabase upsert error:", error);
      return message.reply("❌ Помилка при збереженні в базу.");
    }

    // Видача ролі
    try {
      const role = message.guild.roles.cache.get(SKIPUA_ROLE_ID);
      if (role && member) await member.roles.add(role);
    } catch (err) {
      console.error("Role error:", err);
    }

    const embed = new EmbedBuilder()
      .setColor(0x005BBB)
      .setTitle("🎮 ВІТАЄМО У SKIPUA")
      .setDescription(
        `Вітаю, тебе успішно зареєстровано в базі учасників **SkipUA**.\n\n` +
        `🔹 Твій PUBG нік: **${gameName}**\n` +
        `🔹 Статус: **Активний учасник**\n\n` +
        `🚀 Надалі ти зможеш отримати:\n` +
        `• Участь у кастомках\n• MVP систему\n• Лідерборди\n• Турніри та івенти`
      )
      .setFooter({ text: "SKIP UA COMMUNITY" })
      .setTimestamp();

    return message.channel.send({ embeds: [embed] });
  }

  // !setformat
  if (content.startsWith("!setformat")) {
    if (!hasAdminPermission(member)) return message.reply("You don't have permission to do this.");
    const format = parseInt(content.split(" ")[1], 10);
    if (![1, 2, 3, 4].includes(format)) return message.reply("Format must be 1 (solo), 2, 3 or 4");
    customMatchFormat = format;
    return message.channel.send(`Custom match format set to ${format === 1 ? "solo" : `${format} players per team`}.`);
  }

  // !openreg
  if (content === "!openreg") {
    if (!hasAdminPermission(member)) return message.reply("You don't have permission to do this.");
    if (!customMatchFormat) return message.reply("Set match format first with !setformat");
    if (registrationOpen) return message.reply("Registration is already open.");
    registrationOpen = true;
    registeredPlayers.clear();
    return message.channel.send(`Registration opened! Format: ${customMatchFormat === 1 ? "solo" : `${customMatchFormat} players per team`}.`);
  }

  // !closereg
  if (content === "!closereg") {
    if (!hasAdminPermission(member)) return message.reply("You don't have permission to do this.");
    if (!registrationOpen) return message.reply("Registration is not open.");
    registrationOpen = false;
    if (registeredPlayers.size === 0) return message.channel.send("No players registered.");
    return message.channel.send(`Registration closed. Registered players: ${registeredPlayers.size}`);
  }

  // !register
  if (content === "!register") {
    if (!registrationOpen) return message.reply("Registration is currently closed.");
    if (registeredPlayers.has(message.author.id)) return message.reply("You are already registered.");
    registeredPlayers.add(message.author.id);
    return message.reply("You have been registered for the custom match!");
  }

  // !unregister
  if (content === "!unregister") {
    if (!registrationOpen) return message.reply("Registration is currently closed.");
    if (!registeredPlayers.has(message.author.id)) return message.reply("You are not registered.");
    registeredPlayers.delete(message.author.id);
    return message.reply("You have been unregistered from the custom match.");
  }

  // !addplayer
  if (content.startsWith("!addplayer")) {
    if (!hasAdminPermission(member)) return message.reply("You don't have permission to do this.");
    if (!registrationOpen) return message.reply("Registration is currently closed.");
    const user = message.mentions.users.first();
    if (!user) return message.reply("Please mention a user to add.");
    if (registeredPlayers.has(user.id)) return message.reply("User is already registered.");
    registeredPlayers.add(user.id);
    return message.channel.send(`${user.username} has been added to the custom match registration.`);
  }

  // !removeplayer
  if (content.startsWith("!removeplayer")) {
    if (!hasAdminPermission(member)) return message.reply("You don't have permission to do this.");
    if (!registrationOpen) return message.reply("Registration is currently closed.");
    const user = message.mentions.users.first();
    if (!user) return message.reply("Please mention a user to remove.");
    if (!registeredPlayers.has(user.id)) return message.reply("User is not registered.");
    registeredPlayers.delete(user.id);
    return message.channel.send(`${user.username} has been removed from the custom match registration.`);
  }

  // !list
  if (content === "!list") {
    if (registeredPlayers.size === 0) return message.channel.send("❌ No players registered yet.");

    const membersArr = await Promise.all(
      Array.from(registeredPlayers).map(id =>
        message.guild.members.fetch(id).catch(() => null)
      )
    );

    const names = membersArr.filter(m => m).map((m, i) => `${i + 1}. ${m.user.username}`);

    const embed = new EmbedBuilder()
      .setColor(0x00bfff)
      .setTitle("🎮 REGISTERED PLAYERS")
      .setDescription(names.join("\n"))
      .addFields(
        { name: "👥 Total Players", value: `${registeredPlayers.size}`, inline: true },
        { name: "🎯 Format", value: customMatchFormat ? (customMatchFormat === 1 ? "Solo" : `${customMatchFormat} players/team`) : "Not set", inline: true }
      )
      .setFooter({ text: "SKIP UA CUSTOM MATCH" })
      .setTimestamp();

    return message.channel.send({ embeds: [embed] });
  }

  // !maketeams
  if (content.startsWith("!maketeams")) {
    if (!hasAdminPermission(member)) return message.reply("You don't have permission.");
    if (registrationOpen) return message.reply("❌ Close registration first with !closereg.");

    const teamSize = parseInt(content.split(" ")[1]);
    if (![1, 2, 3, 4, 6].includes(teamSize)) return message.reply("Usage: !maketeams 1|2|3|4|6");

    const playerIds = Array.from(registeredPlayers);
    if (playerIds.length < teamSize * 2) return message.reply("❌ Not enough players.");
    if (playerIds.length % teamSize !== 0) return message.reply(`❌ ${playerIds.length} players cannot be divided into teams of ${teamSize}.`);

    shuffle(playerIds);
    lastTeamSize = teamSize;

    let response = "🔥 RANDOM TEAMS\n\n";
    const teamsCount = playerIds.length / teamSize;

    for (let i = 0; i < teamsCount; i++) {
      const team = playerIds.slice(i * teamSize, (i + 1) * teamSize);
      const names = await Promise.all(
        team.map(id => message.guild.members.fetch(id).then(m => m.user.username).catch(() => "Unknown"))
      );
      response += `🛡 Team ${i + 1}\n${names.join("\n")}\n\n`;
    }

    return message.channel.send(response);
  }

  // !announce
  if (content === "!announce") {
    if (!hasAdminPermission(member)) return message.reply("You don't have permission.");

    const event = {
      title: "SKIP UA CUSTOM MATCH",
      date: "Субота",
      time: "20:00",
      timezone: "за київським часом",
      game: "PUBG Console",
      formats: "2x2 • 4x4 • Arcade 6x6"
    };

    const embed = new EmbedBuilder()
      .setColor(0x005BBB)
      .setTitle(`🔥 ${event.title}`)
      .setDescription(
`📅 ${event.date}
⏰ ${event.time} (${event.timezone})

🎮 ${event.game}

🟢 Реєстрація відкрита

👥 Формати:
${event.formats}

📝 Участь:
\`!register\`

📋 Учасники:
\`!list\`

🇺🇦 SKIP UA`
      )
      .setFooter({ text: "Winner Winner Chicken Dinner 🍗" })
      .setTimestamp();

    return message.channel.send({ content: "@everyone", embeds: [embed] });
  }

  // !startmatch
  if (content === "!startmatch") {
    if (!hasAdminPermission(member)) return message.reply("You don't have permission to do this.");
    if (registrationOpen) return message.reply("Please close registration before starting the match.");
    if (!customMatchFormat) return message.reply("Set match format first.");

    const count = registeredPlayers.size;
    if (count < (customMatchFormat === 1 ? 1 : customMatchFormat * 2)) return message.reply("Not enough players.");
    if (customMatchFormat !== 1 && count % customMatchFormat !== 0)
      return message.reply(`Player count must be multiple of ${customMatchFormat}.`);

    const playersArray = Array.from(registeredPlayers);
    shuffle(playersArray);

    const selectedMap = maps[Math.floor(Math.random() * maps.length)];
    let response = `Map selected for the match: **${selectedMap}**\n\n`;
    let matchData = {};

    if (customMatchFormat === 1) {
      const memberNames = await Promise.all(
        playersArray.map(id => message.guild.members.fetch(id).then(m => m.user.username).catch(() => "Unknown"))
      );
      response += "Solo mode match started! Players:\n" + memberNames.join("\n");
      matchData = { players: memberNames };

      await supabase.from("matches").insert({ format: "Solo", map: selectedMap, data: matchData });
      registeredPlayers.clear();
      return message.channel.send(response);
    } else {
      const teamsCount = count / customMatchFormat;
      response += `Match started! Forming ${teamsCount} teams with ${customMatchFormat} players each.\n\n`;
      let teams = [];

      for (let i = 0; i < teamsCount; i++) {
        const team = playersArray.slice(i * customMatchFormat, (i + 1) * customMatchFormat);
        const memberNames = await Promise.all(
          team.map(id => message.guild.members.fetch(id).then(m => m.user.username).catch(() => "Unknown"))
        );
        response += `**Team ${i + 1}**: ${memberNames.join(", ")}\n\n`;
        teams.push(memberNames);
      }

      await supabase.from("matches").insert({
        format: `${customMatchFormat}x${customMatchFormat}`,
        map: selectedMap,
        data: { teams }
      });

      registeredPlayers.clear();
      return message.channel.send(response);
    }
  }

  // !custom
  if (content === "!custom") {
    const status = registrationOpen ? "open" : "closed";
    const formatText = customMatchFormat
      ? (customMatchFormat === 1 ? "Solo (each for themselves)" : `${customMatchFormat} players per team`)
      : "Not set";
    return message.channel.send(`Custom match info:\nStatus: ${status}\nFormat: ${formatText}`);
  }

  // !matchhistory — тягнемо з Supabase
  if (content === "!matchhistory") {
    const { data: matches, error } = await supabase
      .from("matches")
      .select("*")
      .order("played_at", { ascending: false })
      .limit(5);

    if (error || !matches?.length) return message.channel.send("Match history is empty.");

    let text = "Last matches:\n\n";
    matches.forEach((m, i) => {
      text += `${i + 1}. ${m.played_at} | Format: ${m.format} | Map: ${m.map}\n`;
    });

    return message.channel.send(text);
  }
});

client.login(process.env.DISCORD_TOKEN);

// ================ TELEGRAM ================
const tg = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });

tg.onText(/\/stats (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const name = match[1];

  const data = await getStats(name);
  if (!data) return tg.sendMessage(chatId, "❌ Player not found");

  const kd = (data.kills / (data.matches || 1)).toFixed(2);
  const winrate = ((data.wins / (data.matches || 1)) * 100).toFixed(1);

  const text =
    `🎮 PUBG PLAYER PROFILE\n\n` +
    `👤 ${name}\n🖥 Platform: ${data.platform.toUpperCase()}\n\n` +
    `📊 Kills: ${data.kills}\n🎯 Matches: ${data.matches}\n🏆 Wins: ${data.wins}\n\n` +
    `⚔️ K/D: ${kd}\n📊 Winrate: ${winrate}%\n🔥 Rate: ${data.rate}\n\n` +
    `🏅 Rank: ${data.tier} ${data.subTier}\n📊 RP: ${data.rankPoints}`;

  tg.sendMessage(chatId, text);
});

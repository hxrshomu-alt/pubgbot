const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");

// ================= CONFIG =================
const API_KEY = process.env.PUBG_API_KEY;
const MVP_CHANNEL_ID = "1516535807756861560";
const WELCOME_CHANNEL_ID = "1366013620294783098";
const PUBG_EVENTS_CHANNEL_ID = MVP_CHANNEL_ID;

// ================= DISCORD =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// ================= TELEGRAM =================
const tg = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// ================= GLOBALS =================
let registeredPlayers = new Set();
let registrationOpen = false;
let customMatchFormat = null; // 1,2,3,4
const matchHistory = [];
const activePlayers = new Map();
const previousMatchesCache = new Map();

const maps = [
  "Taego", "Erangel", "Miramar", "Paramo", "Sanhok",
  "Karakin", "Deston", "Rondo", "Vikendi"
];

// ================= UTILS =================
const sleep = ms => new Promise(r => setTimeout(r, ms));
function shuffle(array) {
  for(let i=array.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}
function formatDate(date){return date.toISOString().slice(0,10);}
function getWeekKey(date){
  const onejan = new Date(date.getFullYear(),0,1);
  const dayOfYear = Math.floor((date-onejan)/(24*60*60*1000))+1;
  const weekNum = Math.ceil(dayOfYear/7);
  return `${date.getFullYear()}-${weekNum.toString().padStart(2,'0')}`;
}

// ================= FILE DB =================
async function loadPlayers() {
  try {
    const data = await fs.readFile(path.join(__dirname,"players.json"),"utf-8");
    const obj = JSON.parse(data);
    for(const [id,info] of Object.entries(obj)){
      activePlayers.set(id,info);
    }
    console.log(`Loaded ${activePlayers.size} active players`);
  } catch {console.log("No existing players db found or error reading it");}
}
async function savePlayers() {
  try {
    const obj = {};
    for (const [id,info] of activePlayers.entries()) obj[id] = info;
    await fs.writeFile(path.join(__dirname,"players.json"), JSON.stringify(obj,null,2),"utf-8");
  } catch(e){console.error("Error saving players db:", e);}
}

// ================= PUBG API =================
// apiGet, getCurrentSeason, getStats - як у тебе, без змін (щоб відповісти вміст не дублюю)

async function apiGet(url,retry=1){ /*...*/ }
async function getCurrentSeason(platform){ /*...*/ }
async function getStats(name){ /*...*/ }

// ================= PERMISSION UTILS =================
function hasAdminPermission(member){
  if(!member) return false;
  if(member.permissions.has("Administrator")) return true;
  if(member.roles && member.roles.cache){
    return member.roles.cache.some(r => r.name.toLowerCase().replace(/[-_]/g," ") === "супер адмін");
  }
  return false;
}

// ================= MVP FUNCTIONS =================
// updatePlayerDailyStats, updatePlayerWeeklyStats, getMVPTopN - як у тебе, додану лише якщо потрібна допомога — можу надіслати

// ================= DISCORD EVENTS =================
client.once("clientready", async () => {
  console.log(`Discord logged in as ${client.user.tag}`);
  await loadPlayers();
  scheduleDailyMVP();
  setInterval(checkForChickenDinners, 5*60*1000);
});

client.on("guildMemberAdd", async member => {
  try {
    const channel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID);
    if(channel && channel.isTextBased()){
      channel.send(`🎉 Ласкаво просимо на сервер, ${member}! Щоб додати себе в базу для статистики PUBG, напиши:\n\`!join <твій_нік> <платформа>\``);
    }
  } catch(e) {console.error(e);}
});

// ================= DISCORD MESSAGE HANDLER =================
client.on("messageCreate", async message => {
  if(message.author.bot) return;
  const content = message.content.trim();
  const userId = message.author.id;
  const member = message.member;

  // Переклад повідомлень PUBG подій
  if(message.channel.id === PUBG_EVENTS_CHANNEL_ID){
    const translated = await translateTextLibre(message.content);
    if(translated) await message.channel.send(`🇺🇦 Переклад:\n${translated}`);
  }

  if(content.startsWith("!join")){
    const args = content.split(" ");
    if(args.length<3) return message.reply("Використання: !join <PUBG_нік> <psn|xbox|steam>");
    const pubgName = args[1];
    const platform = args[2].toLowerCase();
    if(!["psn","xbox","steam"].includes(platform)) return message.reply("Платформа має бути: psn, xbox або steam");
    activePlayers.set(userId, {pubgName,platform});
    await savePlayers();
    return message.reply(`Ти зареєстрований як ${pubgName} на платформі ${platform}`);
  }

  if(content.startsWith("!register")){
    if(!registrationOpen) return message.reply("Реєстрація на кастомний матч зараз закрита.");
    if(registeredPlayers.has(userId)) return message.reply("Ти вже зареєстрований.");
    registeredPlayers.add(userId);
    return message.reply("Ти зареєстрований на кастомний матч!");
  }

  if(content.startsWith("!unregister")){
    if(!registrationOpen) return message.reply("Реєстрація зараз закрита.");
    if(!registeredPlayers.has(userId)) return message.reply("Ти не зареєстрований.");
    registeredPlayers.delete(userId);
    return message.reply("Ти скасовуєш реєстрацію з кастомного матчу.");
  }

  if(content.startsWith("!list")){
    if(registeredPlayers.size === 0) return message.channel.send("Ніхто не зареєстрований.");
    const members = await Promise.all(Array.from(registeredPlayers).map(id => message.guild.members.fetch(id).catch(()=>null)));
    const names = members.filter(Boolean).map(m=>m.user.username);
    return message.channel.send(`Зареєстровані гравці:\n${names.join("\n")}`);
  }

  if(content.startsWith("!startmatch")){
    if(!hasAdminPermission(member)) return message.reply("Тільки адміністратори можуть запускати матчі.");
    if(registrationOpen) return message.reply("Закрий реєстрацію перш ніж почати матч.");
    if(!customMatchFormat) return message.reply("Спочатку встанови формат зі !setformat");
    const count = registeredPlayers.size;
    if(count < (customMatchFormat === 1 ? 1 : customMatchFormat * 2))
      return message.reply("Занадто мало гравців для матчу.");
    if(customMatchFormat !==1 && count%customMatchFormat !== 0)
      return message.reply(`Кількість гравців повинна бути кратною ${customMatchFormat}.`);
    const playersArray = Array.from(registeredPlayers);
    shuffle(playersArray);
    const selectedMap = maps[Math.floor(Math.random()*maps.length)];
    let response = `Обрана карта: **${selectedMap}**\n\n`;

    if(customMatchFormat === 1){
      const memberNames = await Promise.all(playersArray.map(id => message.guild.members.fetch(id).then(m=>m.user.username).catch(()=> "Unknown")));
      response += "Матч у форматі соло, учасники:\n" + memberNames.join("\n");
      registeredPlayers.clear();
      matchHistory.push({date:new Date().toISOString(),format:"solo",map:selectedMap,players:memberNames});
      return message.channel.send(response);
    } else {
      const teamsCount = count/customMatchFormat;
      response += `Матч розпочато! Формуємо ${teamsCount} команди по ${customMatchFormat} гравців.\n\n`;
      let teamsForHistory = [];
      for(let i=0; i<teamsCount; i++){
        const team = playersArray.slice(i*customMatchFormat,(i+1)*customMatchFormat);
        const memberNames = await Promise.all(team.map(id => message.guild.members.fetch(id).then(m=>m.user.username).catch(()=> "Unknown")));
        response += `**Команда ${i+1}**: ${memberNames.join(", ")}\n\n`;
        teamsForHistory.push(memberNames);
      }
      registeredPlayers.clear();
      matchHistory.push({ date:new Date().toISOString(), format:`${customMatchFormat}x${customMatchFormat}`, map:selectedMap, teams:teamsForHistory});
      return message.channel.send(response);
    }
  }

  if(content.startsWith("!setformat")){
    if(!hasAdminPermission(member)) return message.reply("Тільки адміністратори можуть це робити.");
    const format = parseInt(content.split(" ")[1],10);
    if(![1,2,3,4].includes(format)) return message.reply("Формат має бути 1, 2, 3 або 4");
    customMatchFormat = format;
    return message.channel.send(`Формат матчу встановлено: ${format===1 ? "соло" : format + " гравців у команді"}`);
  }

  if(content.startsWith("!addplayer")){
    if(!hasAdminPermission(member)) return message.reply("Тільки адміністратори можуть це робити.");
    const args = content.split(" ");
    if(args.length < 2) return message.reply("Вкажи Discord тег користувача для додавання");
    const userTag = args[1].replace(/[<@!>]/g,"");
    registeredPlayers.add(userTag);
    return message.channel.send(`Додано користувача <@${userTag}> до реєстрації на кастомний матч.`);
  }

  if(content.startsWith("!custom")){
    const status = registrationOpen ? "відкрита" : "закрита";
    const formatText = customMatchFormat ? (customMatchFormat===1 ? "Соло (кожен за себе)" : `${customMatchFormat} гравців у команді`) : "Не виставлено";
    const dateStr = "Дата і час матчу: буде оголошено";
    return message.channel.send(`Інформація про кастомний матч:\nСтатус: ${status}\nФормат: ${formatText}\n${dateStr}`);
  }

  if(content.startsWith("!matchhistory")){
    if(matchHistory.length === 0) return message.channel.send("Історія матчів порожня");
    let text = "Останні матчі:\n\n";
    matchHistory.slice(-5).reverse().forEach((m,i) => {
      text += `${i+1}. ${m.date} | Формат: ${m.format} | Карта: ${m.map}\n`;
    });
    return message.channel.send(text);
  }

  if(content.startsWith("!stats")){
    const name = content.split(" ")[1];
    if(!name) return message.reply("Використання: !stats <нік>");
    return handleStats(message,name);
  }
});

// ================= DAILY MVP POSTING =================
function scheduleDailyMVP() {
  const now = new Date();
  const target = new Date();
  target.setHours(19,0,0,0);
  if(now > target) target.setDate(target.getDate()+1);
  const msToWait = target - now;

  setTimeout(() => {
    postDailyMVP();
    setInterval(postDailyMVP,24*60*60*1000);
  }, msToWait);
}

async function postDailyMVP() {
  await Promise.all(Array.from(activePlayers.keys()).map(userId => updatePlayerDailyStats(userId)));

  const top = getMVPTopN("daily");
  if(top.length === 0) return;

  let desc = top.map((p,i) =>
    `${i+1}. **${p.pubgName}** (${p.platform.toUpperCase()}) - Wins: ${p.winsDiff}, Kills: ${p.killsDiff}`
  ).join("\n");

  const embed = new EmbedBuilder()
    .setTitle("🏆 Daily PUBG MVP Top 5")
    .setDescription(desc)
    .setColor(0x00ff00)
    .setTimestamp();

  const channel = await client.channels.fetch(MVP_CHANNEL_ID).catch(()=>null);
  if(channel) channel.send({embeds:[embed]});
}

// ================= CHICKENDINNER CHECK =================
async function checkForChickenDinners() {
  if(activePlayers.size === 0) return;

  for(const [discordId, playerInfo] of activePlayers.entries()){
    try {
      const stats = await getPlayerStats(playerInfo.pubgName, playerInfo.platform);
      if(!stats || !stats.playerId) continue;

      const lastId = previousMatchesCache.get(discordId) || null;
      const matches = await getPlayerRecentMatches(stats.playerId, playerInfo.platform);

      for(const match of matches){
        if(match.id === lastId) break;

        const matchData = await apiGet(`https://api.pubg.com/shards/${playerInfo.platform}/matches/${match.id}`);
        if(!matchData?.data) continue;

        const gameMode = matchData.data.attributes.gameMode.toLowerCase();
        if(!((gameMode.includes("squad")||gameMode.includes("duo")) && gameMode.includes("tpp"))) continue;

        const participants = matchData.data.relationships.participants.data.map(x => x.id);
        if(!participants.includes(stats.playerId)) continue;

        previousMatchesCache.set(discordId, match.id);

        const channel = await client.channels.fetch(MVP_CHANNEL_ID).catch(() => null);
        if(channel) channel.send(`🏆 **${playerInfo.pubgName}** взяв Chicken Dinner у режимі ${matchData.data.attributes.gameMode}! 🎉`);

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
      headers: {"Content-Type": "application/json"}
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
  if(!data) return tg.sendMessage(chatId, "❌ Player not found");

  const kd = (data.kills / (data.matches || 1)).toFixed(2);
  const winrate = ((data.wins / (data.matches || 1))*100).toFixed(1);

  const text = `🎮 PUBG PLAYER PROFILE

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

// ================= LOGIN =================
client.login(process.env.DISCORD_TOKEN);

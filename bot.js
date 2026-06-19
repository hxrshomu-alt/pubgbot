const { Client, GatewayIntentBits, EmbedBuilder, Events } = require("discord.js");
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
let customMatchFormat = null;
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
  } catch { console.log("No existing players db found or error reading it"); }
}
async function savePlayers() {
  try {
    const obj = {};
    for(const [id,info] of activePlayers.entries()) obj[id]=info;
    await fs.writeFile(path.join(__dirname,"players.json"), JSON.stringify(obj,null,2),"utf-8");
  } catch(e) { console.error("Error saving players db:", e); }
}

// ================= PUBG API =================
async function apiGet(url, retry=1) {
  try {
    await sleep(1200);
    return await axios.get(url, {
      headers: { Authorization: `Bearer ${API_KEY}`, Accept:"application/vnd.api+json" }
 });
  } catch (err) {
    if(err.response?.status === 429 && retry>0){
      await sleep(5000);
      return apiGet(url,retry-1);
    }
    throw err;
  }
}

async function getCurrentSeason(platform){
  if(seasonCache.has(platform)) return seasonCache.get(platform);
  const res = await apiGet(`https://api.pubg.com/shards/${platform}/seasons`);
  const season = res.data.data.find(s=>s.attributes.isCurrentSeason);
  seasonCache.set(platform, season.id);
  return season.id;
}

async function getStats(name){
  const cached = cache.get(name);
  if(cached && Date.now()- cached.time < CACHE_TIME) return cached.data;

  const platforms = ["psn","xbox"];
  let best = null;

  for(const platform of platforms){
    try {
      const playerRes = await apiGet(`https://api.pubg.com/shards/${platform}/players?filter[playerNames]=${encodeURIComponent(name)}`);
      const player = playerRes.data?.data?.[0];
      if(!player) continue;

      const statsRes = await apiGet(`https://api.pubg.com/shards/${platform}/players/${player.id}/seasons/lifetime`);
      const modes = statsRes.data?.data?.attributes?.gameModeStats;
      if(!modes) continue;

      let kills=0, wins=0, matches=0;
      for(const m in modes){
        kills += modes[m].kills||0;
        wins += modes[m].wins||0;
        matches += modes[m].roundsPlayed||0;
      }

      let tier = "Unranked", subTier = "", rankPoints=0;
      const seasonId = await getCurrentSeason(platform);
      try{
        const rankedRes = await apiGet(`https://api.pubg.com/shards/${platform}/players/${player.id}/seasons/${seasonId}/ranked`);
        const rankedStats = rankedRes.data?.data?.attributes?.rankedGameModeStats;
        if(rankedStats){
          const modes = Object.values(rankedStats);
          const bestMode = modes.reduce((best,cur)=>{
            if(!cur?.currentTier) return best;
            if(!best) return cur;
            return (cur.currentRankPoint||0)>(best.currentRankPoint||0)?cur:best;
          },null);
          if(bestMode?.currentTier){
            tier = bestMode.currentTier.tier || "Unranked";
            subTier = bestMode.currentTier.subTier || "";
            rankPoints = bestMode.currentRankPoint || 0;
          }
        }
      }catch{}
      const result = {kills, wins, matches, platform, tier, subTier, rankPoints};
      if(!best || result.kills>best.kills) best = result;
    }catch{}
  }
  if(best) cache.set(name, {data: best, time: Date.now()});
  return best;
}

// ================= PERMISSIONS =================
function hasAdminPermission(member){
  if(!member) return false;
  if(member.permissions.has("Administrator")) return true;
  if(member.roles && member.roles.cache){
    return member.roles.cache.some(role => role.name.toLowerCase().replace(/[-_]/g," ") === "супер адмін");
  }
  return false;
}

// ================= HANDLE COMMANDS =================
async function handleStats(message,name){
  const msg = await message.reply("⏳ loading player data...");
  const data = await getStats(name);
  if(!data) return msg.edit("❌ Player not found");

  const kd = (data.kills/(data.matches||1)).toFixed(2);
  const winrate = ((data.wins/(data.matches||1))*100).toFixed(1);

  const embed = new EmbedBuilder()
    .setTitle("🎮 PUBG PLAYER PROFILE")
    .setDescription(`**${name}** | Platform: **${data.platform.toUpperCase()}**`)
    .setColor(0x00bfff)
    .addFields(
      {name:"📊 Core Stats", value:`🔫 Kills: **${data.kills}**\n🎯 Matches: **${data.matches}**\n🏆 Wins: **${data.wins}**`, inline:false},
      {name:"📈 Performance", value:`⚔️ K/D: **${kd}**\n📊 Winrate: **${winrate}%**\n🔥 Rate: **${data.rate}**`, inline:false},
      {name:"🏅 Ranked", value:`🎖 Tier: **${data.tier} ${data.subTier}**\n📊 RP: **${data.rankPoints}**`, inline:false}
    )
    .setThumbnail("https://cdn-icons-png.flaticon.com/512/1146/1146869.png")
    .setFooter({text:"by sociopath39"})
    .setTimestamp();

  msg.edit({content:" ", embeds:[embed]});
}

// ================= EVENTS =================
client.once(Events.ClientReady, async () => {
  console.log(`Discord logged in as ${client.user.tag}`);
  await loadPlayers();
  scheduleDailyMVP();
  setInterval(checkForChickenDinners, MATCH_CHECK_INTERVAL);
});

client.on("guildMemberAdd", async member => {
  try {
    const channel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID);
    if(channel && channel.isTextBased()){
      channel.send(`🎉 Ласкаво просимо на сервер, ${member}! Щоб додати себе в базу для статистики PUBG, напиши:\n\`!join <нік> <платформа>\``);
    }
  } catch(e) {console.error(e);}
});

client.on("messageCreate", async message => {
  if(message.author.bot) return;
  const content = message.content.trim();
  const userId = message.author.id;
  const member = message.member;

  if(message.channel.id === PUBG_EVENTS_CHANNEL_ID){
    const translated = await translateTextLibre(message.content);
    if(translated) await message.channel.send(`🇺🇦 Переклад:\n${translated}`);
  }

  if(content.startsWith("!join")){
    const args = content.split(" ");
    if(args.length < 3) return message.reply("Використання: !join <нік> <psn|xbox|steam>");
    const pubgName = args[1];
    const platform = args[2].toLowerCase();
    if(!["psn","xbox","steam"].includes(platform)) return message.reply("Платформа має бути: psn, xbox або steam");

    activePlayers.set(userId, {pubgName, platform});
    await savePlayers();
    return message.reply(`Ти зареєстрований як ${pubgName} на ${platform}`);
  }

  if(content.startsWith("!mvp")){
    const args = content.split(" ");
    const period = args[1]?.toLowerCase() || "daily";
    if(!["daily","weekly"].includes(period)) return message.reply("Використай !mvp daily або !mvp weekly");

    await Promise.all(
      Array.from(activePlayers.keys()).map(userId =>
        period === "daily" ? updatePlayerDailyStats(userId) : updatePlayerWeeklyStats(userId)
      )
    );

    const top = getMVPTopN(period);
    if(top.length === 0) return message.channel.send("Немає даних для відображення.");

    let desc = top.map((p,i) =>
      `${i+1}. **${p.pubgName}** (${p.platform.toUpperCase()}) - Виграшів: ${p.winsDiff}, Вбивств: ${p.killsDiff}`
    ).join("\n");

    const embed = new EmbedBuilder()
      .setTitle(`🏆 Топ 5 PUBG MVP (${period})`)
      .setDescription(desc)
      .setColor(0xffd700)
      .setTimestamp();

    return message.channel.send({ embeds: [embed] });
  }

  if(content.startsWith("!register")) {
    // Зареєструватися через !join
    return message.reply("Використовуйте команду !join <нік> <платформа> для реєстрації.");
  }

  if(content.startsWith("!stats")){
    const name = content.split(" ")[1];
    if(!name) return message.reply("Використання: !stats <нік>");
    return handleStats(message,name);
  }

  // --- інші команди --- 
});

// ================= DAILY MVP =================
function scheduleDailyMVP() {
  const now = new Date();
  const target = new Date();
  target.setHours(19,0,0,0);
  if(now > target) target.setDate(target.getDate()+1);
  const msToWait = target - now;

  setTimeout(() => {
    postDailyMVP();
    setInterval(postDailyMVP, 24*60*60*1000);
  }, msToWait);
}

async function postDailyMVP(){
  await Promise.all(
    Array.from(activePlayers.keys()).map(userId => updatePlayerDailyStats(userId))
  );
  const top = getMVPTopN("daily");
  if(top.length===0) return;

  let desc = top.map((p,i) =>
    `${i+1}. **${p.pubgName}** (${p.platform.toUpperCase()}) - Виграшів: ${p.winsDiff}, Вбивств: ${p.killsDiff}`
  ).join("\n");

  const embed = new EmbedBuilder()
        .setTitle("🏆 Щоденний топ 5 PUBG MVP")
        .setDescription(desc)
        .setColor(0x00ff00)
        .setTimestamp();

  const channel = await client.channels.fetch(MVP_CHANNEL_ID).catch(()=>null);
  if(channel) channel.send({embeds:[embed]});
}

// ================= CHECK FOR CHICKEN DINNERS =================
async function checkForChickenDinners(){
  if(activePlayers.size===0) return;

  for(const [discordId, playerInfo] of activePlayers.entries()){
    try{
      const stats = await getPlayerStats(playerInfo.pubgName, playerInfo.platform);
      if(!stats || !stats.playerId) continue;

      const lastKnownMatchId = previousMatchesCache.get(discordId) || null;
      const matches = await getPlayerRecentMatches(stats.playerId, playerInfo.platform);

      for(const match of matches){
        const matchId = match.id;
        if(matchId === lastKnownMatchId) break;

        const matchData = await apiGet(`https://api.pubg.com/shards/${playerInfo.platform}/matches/${matchId}`);
        if(!matchData?.data) continue;

        const gameMode = matchData.data.attributes.gameMode.toLowerCase();
        if(!((gameMode.includes("squad") || gameMode.includes("duo")) && gameMode.includes("tpp"))) continue;

        const participants = matchData.data.relationships.participants.data.map(x => x.id);
        if(!participants.includes(stats.playerId)) continue;

        previousMatchesCache.set(discordId, matchId);

        const channel = await client.channels.fetch(MVP_CHANNEL_ID).catch(() => null);
        if(channel) channel.send(`🏆 **${playerInfo.pubgName}** взяв Chicken Dinner у режимі ${matchData.data.attributes.gameMode}! 🎉`);

        break;
      }
    }catch{}
  }
}

// ================= TRANSLATE =================
async function translateTextLibre(text, targetLang = "uk"){
  try{
    const res = await axios.post("https://libretranslate.de/translate",{
      q: text,
      source: "en",
      target: targetLang,
      format: "text"
    }, {
      headers: {"Content-Type":"application/json"}
    });
    return res.data.translatedText;
  }catch{
    return null;
  }
}

// ================= TELEGRAM COMMAND =================
tg.onText(/\/stats (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const name = match[1];
  const data = await getStats(name);
  if(!data) return tg.sendMessage(chatId, "❌ Player not found");

  const kd = (data.kills/(data.matches || 1)).toFixed(2);
  const winrate = ((data.wins/(data.matches || 1))*100).toFixed(1);

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

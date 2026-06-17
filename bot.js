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

// 📢 ВАЖЛИВО: встав реальний channel ID
const CHANNEL_ID = "1366013620294783096";

// 👥 CLAN
const players = [
  "_I_3u6a_I","o__XyHTA__o","oLex_body88","amatera150","Andriij95",
  "Apostol9477","Ar_mg11","agressorU","astral-carving97","B1ggie_Doggie",
  "Bigboss-monax","bo_vert","Bogoo30_top","byTop69","CalmKeyboard",
  "DBOZH777","dddennn007","De_Sher","Denny4308","Dimon4es",
  "DonovanEz","Dostojnij","Dreamer6965783","EbliVaya_suczara","EnderOrbi",
  "Ernesto_Mussolin","Forvard_365","Friz4954","furtive_razor68","gervontadavis669",
  "glue_nursing12","GN1DAGAMESOVER","Goldengames6458","graaatiis_","Il_FireGhost_Il",
  "Illau112VIP8775","IMMORTAL_CROW_","ImTayson556","k0l0bakich","Kevin781580",
  "KibRaffin","king_myk-","koromyslo_andrei","kot_7711","Kotyh0r0shk0",
  "kukin7567","leafless_rise4","Mania4eLo","Marazaro","MatematikX",
  "mely-glib","Morpeh_Alex97","Movnyk","Nik_vich","Oops_FREEMAN",
  "osadchyidaniil","OxyCont8529","pally_gaiter1","panjijko","Papu1ay8888",
  "PoolManUA","prim_progress2","pro100tak7","Private_TTV","Raddead2544",
  "RazorVoyage333","Roman1117906","RyRa3232","Sasha112VIP","Schokk_777",
  "SCHWARZENOLD","Shadow22UA","sk0_0nsik","sociopath39","sound-panicle58",
  "Stepion5732","StoneIsand-47","SuSPECT3880","Swat_UA27","Taras_mozil",
  "trendy-plunger38","Treendyy","Trudovyk","tToni4433","ufny-ognik",
  "Ukra1n1ans","V_I_R_U_S__0_0","Vaka-maka-fo","vano_vanchik","VladosKeks98",
  "VolotsiugaX","w0nderful1632","xxEGOISTxxUA","Zakarpartec"
];

// 📊 DATA
let dailyStats = {};
let previousStats = {};

// 🔥 CACHE
const cache = new Map();
const CACHE_TIME = 2 * 60 * 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));// ================= API =================
async function apiGet(url) {
  await sleep(700);

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

      let kills = 0, wins = 0, matches = 0;

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

// ================= TOP 3 MVP =================
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

// ================= DAILY CHECK =================
function startDailyMVP(channel) {
  setInterval(() => {
    try {
      const now = new Date();

      if (now.getHours() === 0 && now.getMinutes() === 0) {
        const top = getTopMVP();

        if (top.length) {
          const medals = ["🥇", "🥈", "🥉"];

          let desc = "";

          top.forEach((p, i) => {
            desc += `${medals[i]} **${p.name}**\n`;
            desc += `🔫 ${p.kills} | 🍗 ${p.wins} | 📊 ${p.score}\n\n`;
          });

          const embed = new EmbedBuilder()
            .setTitle("🏆 MVP OF THE DAY")
            .setColor(0xffd700)
            .setDescription(desc);

          channel.send({ embeds: [embed] }).catch(() => {});
        }

        resetDaily();
      }
    } catch (err) {
      console.log("Scheduler error:", err.message);
    }
  }, 60 * 1000);
}

// ================= READY =================
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    updateStats();
    setInterval(updateStats, 5 * 60 * 1000);

    const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);

    if (channel) {
      startDailyMVP(channel);
    } else {
      console.log("❌ Channel not found or bot has no access");
    }

  } catch (err) {
    console.log("READY ERROR:", err.message);
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

    const medals = ["🥇", "🥈", "🥉"];

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
});

// ================= LOGIN =================
client.login(process.env.DISCORD_TOKEN);

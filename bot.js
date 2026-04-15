// SpritzMoon Telegram Bot — Standalone version
// Completamente separato dal backend. Comunica via API pubbliche.
// Deploy: Render Web Service (free tier), oppure tuo PC con `node bot.js`

const { Bot, InlineKeyboard, GrammyError, HttpError } = require('grammy');

// ─── CONFIG ─────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_BASE = process.env.API_BASE || 'https://spritzmoon-api.onrender.com';
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '1054120151');
// COMMUNITY_CHAT_ID can be either a numeric ID (e.g. -1001234567890) or a public username (e.g. @SpritzMoonCryptoToken)
const COMMUNITY_CHAT_ID = process.env.COMMUNITY_CHAT_ID
    ? (/^-?\d+$/.test(process.env.COMMUNITY_CHAT_ID.trim())
        ? parseInt(process.env.COMMUNITY_CHAT_ID.trim())
        : process.env.COMMUNITY_CHAT_ID.trim().startsWith('@')
            ? process.env.COMMUNITY_CHAT_ID.trim()
            : '@' + process.env.COMMUNITY_CHAT_ID.trim())
    : null;

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN environment variable is required!');
    console.error('   Get one from @BotFather on Telegram');
    process.exit(1);
}

console.log('🤖 Starting SpritzMoon bot...');
console.log(`📡 API base: ${API_BASE}`);
console.log(`👤 Admin ID: ${ADMIN_ID}`);

const bot = new Bot(BOT_TOKEN);

// ─── HEALTH CHECK SERVER (per Render) ───────────
// Render free tier richiede una porta HTTP aperta per non andare in sleep aggressivo
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'online', service: 'SpritzMoon Bot', uptime: process.uptime() }));
}).listen(PORT, () => console.log(`💚 Health check server on port ${PORT}`));

// ─── IN-MEMORY STATE ────────────────────────────
// Note: si perde a ogni restart. Per dati persistenti servirebbe un DB, ma per
// quiz/lingua/streaks da bot questa scelta è ok in modalità "fast start"
const userLang = new Map();        // userId → 'it' | 'en'
const quizScores = new Map();      // userId → { score, attempts, lastQuiz }
const lastDaily = new Map();       // userId → timestamp ms
const seenWelcomes = new Set();    // chatId per evitare spam welcome al restart

// ─── HELPERS ────────────────────────────────────
function getLang(userId) {
    return userLang.get(userId) || 'it';
}

async function fetchAPI(endpoint) {
    try {
        const url = `${API_BASE}/api${endpoint}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        console.warn(`API error on ${endpoint}:`, e.message);
        return null;
    }
}

function formatNumber(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return Math.round(n).toString();
}

function escMd(text) {
    // Escape per Markdown V1 di Telegram
    return String(text).replace(/[_*[\]()`]/g, '\\$&');
}

// ─── TRANSLATIONS ───────────────────────────────
const T = {
    it: {
        welcome: `🍹 *Benvenuto in SpritzMoon!*

Sono il bot ufficiale della community SpritzMoon — la crypto italiana ispirata all'aperitivo Spritz.

🆓 Mining gratuito da smartphone e PC
🤝 Scambio tra membri della community
📊 Trasparenza totale sulla blockchain pubblica
🔴 Ora siamo nella fase Campari (Phase 1/4)

*Ecco cosa posso fare:*
/info — Cos'è SpritzMoon
/howto — Come iniziare a minare
/phase — Fase mining attuale
/stats — Statistiche di rete
/top — Top 10 holders
/aperitivo — Una frase Spritz 🍹
/quiz — Mini quiz a tema
/help — Tutti i comandi

Pronto a brindare? 🥂
👉 [spritzmoon.net](https://spritzmoon.net)`,

        info: `🍹 *Cos'è SpritzMoon*

SpritzMoon è la *crypto italiana* ispirata all'aperitivo che ha conquistato il mondo. Non è un investimento finanziario, non è quotata su exchange e non promette guadagni in euro.

*Cosa è:*
✅ Un community token italiano
✅ Mining gratuito da smartphone e PC
✅ Scambio tra membri
✅ Blockchain pubblica trasparente
✅ Supply massimo 21 milioni (come Bitcoin)
✅ 4 fasi mining: Campari → Aperol → Select → Hugo

*Cosa NON è:*
❌ Un investimento
❌ Una promessa di guadagno
❌ Quotato su exchange
❌ Uno schema piramidale

*La visione:* trasformare SpritzMoon in uno stile di vita. Bar partner dove pagare lo Spritz con SPM, eventi esclusivi per i membri, una community che brinda insieme.

🔗 [spritzmoon.net](https://spritzmoon.net)
📧 info@spritzmoon.net`,

        howto: `⛏️ *Come iniziare a minare in 30 secondi*

1️⃣ Apri [spritzmoon.net](https://spritzmoon.net) dal tuo smartphone o PC

2️⃣ Clicca *"Inizia Mining"*

3️⃣ Il tuo wallet viene creato automaticamente con un Device ID unico

4️⃣ Premi *"Start Mining"* e inizi a guadagnare SPM al rate della fase corrente

*Suggerimenti:*
🔸 Salva il tuo Device ID in un posto sicuro
🔸 Più presto inizi, più SPM accumuli (il rate diminuisce con le fasi)
🔸 Puoi controllare ogni transazione sul [registro pubblico](https://spritzmoon.net/registry.html)
🔸 Niente costi, niente registrazione, niente app da scaricare

⚠️ *Importante:* SpritzMoon NON è un investimento finanziario. È un community token che vivrà delle utilità che la community costruirà nel tempo (bar partner, eventi, ecc.).`,

        phase_loading: `🔄 Sto controllando la fase di mining attuale...`,
        phase_error: `⚠️ Non riesco a contattare il backend in questo momento. Riprova tra qualche secondo (potrebbe essere in fase di riavvio).`,

        phaseMsg: (p, totalMined, phaseProgress, phaseSize, minedInPhase, nextPhase) => `${p.emoji} *Fase ${p.name}* · ${p.id}/4

⚡ *Mining rate:* \`${p.rate} SPM/min\`

📊 *Progresso fase:*
\`${'█'.repeat(Math.round(phaseProgress / 5))}${'░'.repeat(20 - Math.round(phaseProgress / 5))}\` ${phaseProgress.toFixed(1)}%

💎 *Supply fase:* ${formatNumber(minedInPhase)} / ${formatNumber(phaseSize)}
🌐 *Totale minato:* ${formatNumber(totalMined)} / 21M (${((totalMined / 21000000) * 100).toFixed(3)}%)
${nextPhase ? `\n⏭️ *Prossima fase:* ${nextPhase.emoji} ${nextPhase.name}` : '\n🍹 *Prossima:* Spritz Completo — mining chiuso'}

🔗 [Registro live](https://spritzmoon.net/registry.html)`,

        spritzCompleto: `🍹 *Spritz Completo!*

Il cap di 21M SPM è stato raggiunto. Il mining è chiuso per sempre.

La community vive ora dei trasferimenti, dei bar partner e degli eventi esclusivi. Il brindisi è eterno! 🥂`,

        statsMsg: (s) => `📊 *Statistiche SpritzMoon*

🧱 Blocchi: *${formatNumber(s.total_blocks)}*
👥 Utenti totali: *${formatNumber(s.total_users)}*
🟢 Attivi ora: *${s.active_users}*
⛏️ Miner attivi: *${s.active_miners}*
📝 Transazioni: *${formatNumber(s.total_transactions)}*
⚡ Hash rate: *${s.total_hash_rate} TH/s*
${s.total_mined !== undefined ? `\n💎 Supply minato: *${formatNumber(s.total_mined)} / 21M* (${(s.supply_percent || 0).toFixed(3)}%)` : ''}
${s.current_phase ? `\n${s.current_phase.emoji} Fase: *${s.current_phase.name}* (${s.current_phase.rate} SPM/min)` : ''}

🔗 [Registro pubblico](https://spritzmoon.net/registry.html)`,

        topHeader: `🏆 *Top 10 Holders — All Time*

`,
        topEmpty: `📊 Nessun dato ancora. Sii il primo a minare!`,

        helpMsg: `🍹 *SpritzMoon Bot — Comandi*

📚 *Info & onboarding*
/start — Avvia il bot
/info — Cos'è SpritzMoon
/howto — Come iniziare a minare
/site — Link al sito
/contact — Email di contatto

📊 *Statistiche live*
/phase — Fase mining attuale
/stats — Statistiche di rete
/top — Top 10 holders
/registry — Registro pubblico

🎮 *Engagement*
/aperitivo — Frase casuale Spritz
/quiz — Mini quiz a tema
/score — Il tuo punteggio quiz

⚙️ *Impostazioni*
/lang — Cambia lingua IT/EN
/help — Mostra questo messaggio

🔗 spritzmoon.net
📧 info@spritzmoon.net`,

        siteMsg: `🍹 *SpritzMoon — Link Ufficiali*

🌐 [Sito ufficiale](https://spritzmoon.net)
⛏️ [Mining](https://spritzmoon.net/index1.html)
📋 [Registro pubblico](https://spritzmoon.net/registry.html)
💬 [Community Telegram](https://t.me/SpritzMoonCryptoToken)

📧 info@spritzmoon.net`,

        contactMsg: `📧 *Contatti SpritzMoon*

Per qualsiasi domanda, collaborazione, partnership con bar/locali, o per chi aveva i vecchi token BSC e vuole essere riconosciuto nella nuova community:

✉️ *info@spritzmoon.net*

Rispondiamo a tutti! 🍹`,

        aperitivo: [
            "🍹 _«Un Spritz al giorno toglie il broker di torno»_",
            "🍊 _«Non c'è crypto senza prosecco»_",
            "🥂 _«Minare è come preparare uno Spritz: serve pazienza, ghiaccio e la giusta dose di Aperol»_",
            "🍹 _«Lo Spritz migliore è quello che bevi con chi mina con te»_",
            "🍊 _«Ogni blocco è un cubetto di ghiaccio nella blockchain»_",
            "🥂 _«Il vero valore di SPM? Quello che scambi in una chiacchierata davanti a uno Spritz»_",
            "🍹 _«Satoshi avrebbe amato l'ora dell'aperitivo»_",
            "🍊 _«Aperol, Campari, Select, Hugo: 4 fasi di mining, 4 modi di brindare»_",
            "🥂 _«La community è il miglior ingrediente di ogni Spritz»_",
            "🍹 _«Il Veneto ha inventato lo Spritz, l'Italia inventa SpritzMoon»_",
            "🍊 _«Il mining migliore? Quello che fai mentre sorseggi uno Spritz»_",
            "🥂 _«Trasparenza come ghiaccio, dolcezza come arancia, decisione come Aperol»_"
        ],

        quizQuestions: [
            { q: "Quale ingrediente è essenziale in un classico Spritz veneziano?", opts: ["Aperol", "Campari", "Vodka", "Rum"], correct: 1, expl: "Il primo Spritz veneziano del 1860 usava Campari, l'Aperol arrivò dopo!" },
            { q: "Qual è il supply massimo di SpritzMoon?", opts: ["10 milioni", "21 milioni", "100 milioni", "1 miliardo"], correct: 1, expl: "21 milioni, esattamente come Bitcoin! 🍹" },
            { q: "Quale fase di mining ha il rate più alto?", opts: ["Campari", "Aperol", "Select", "Hugo"], correct: 0, expl: "Campari è la fase 1 con 0.10 SPM/min, la più generosa." },
            { q: "Da quale regione italiana arriva l'Hugo?", opts: ["Veneto", "Sicilia", "Trentino", "Toscana"], correct: 2, expl: "L'Hugo è nato in Trentino Alto Adige nei primi anni 2000." },
            { q: "Cosa serve per minare SpritzMoon?", opts: ["Una GPU costosa", "Solo un browser", "Un wallet hardware", "Un nodo Bitcoin"], correct: 1, expl: "Solo un browser! Niente hardware, niente costi." },
            { q: "Quante fasi di mining ha SpritzMoon?", opts: ["2", "3", "4", "8"], correct: 2, expl: "4 fasi: Campari, Aperol, Select, Hugo. Una per ogni Spritz italiano!" },
            { q: "SpritzMoon è quotato su exchange?", opts: ["Sì, su Binance", "Sì, su Coinbase", "No, mai", "Solo su DEX"], correct: 2, expl: "No e mai sarà! È un community token, non un investimento." },
            { q: "Cosa succede quando si raggiunge il cap di 21M?", opts: ["Il prezzo esplode", "Il mining si chiude per sempre", "Si crea un nuovo token", "Niente cambia"], correct: 1, expl: "Il mining si chiude. La community continua con trasferimenti e utility future." },
            { q: "In che anno è nato il Campari?", opts: ["1760", "1860", "1920", "1950"], correct: 1, expl: "1860, a Novara. Il pioniere dello Spritz!" },
            { q: "Cosa significa il rate '0.10 SPM/min'?", opts: ["10 SPM all'ora", "0.10 SPM ogni minuto", "10 SPM al secondo", "0.10 SPM al giorno"], correct: 1, expl: "0.10 SPM al minuto = 6 SPM all'ora = 144 SPM al giorno (in fase Campari)." }
        ],

        quizCorrect: (expl) => `✅ *Esatto!*\n\n${expl}\n\nUsa /quiz per un'altra domanda!`,
        quizWrong: (correct, expl) => `❌ *Sbagliato!*\n\nLa risposta corretta era: *${correct}*\n\n${expl}\n\nRiprova con /quiz!`,
        scoreMsg: (s) => `🎮 *Il tuo punteggio quiz*\n\n✅ Risposte corrette: *${s.score}*\n📝 Tentativi totali: *${s.attempts}*\n📊 Accuratezza: *${s.attempts > 0 ? ((s.score / s.attempts) * 100).toFixed(1) : 0}%*\n\nContinua con /quiz! 🍹`,
        scoreEmpty: `🎮 Non hai ancora giocato! Prova /quiz per iniziare.`,

        langSet: `✅ Lingua impostata: *Italiano* 🇮🇹`,
        welcomeMember: (name) => `🍹 Benvenuto *${escMd(name)}* nella community SpritzMoon!

Sei nel posto giusto se ami:
✨ Lo Spritz e l'aperitivo italiano
🆓 Mining gratuito senza investimenti
🤝 Community vere, non speculatori

*Per iniziare:*
1️⃣ Apri [spritzmoon.net](https://spritzmoon.net)
2️⃣ Clicca "Inizia Mining"
3️⃣ Brindiamo insieme! 🥂

Hai domande? Scrivici qui o usa /help`,

        announcePrefix: `📢 *Annuncio SpritzMoon*\n\n`,
        adminOnly: `❌ Comando riservato all'admin.`
    },

    en: {
        welcome: `🍹 *Welcome to SpritzMoon!*

I'm the official bot of the SpritzMoon community — the Italian crypto inspired by the Spritz aperitivo.

🆓 Free mining from smartphone and PC
🤝 Member-to-member exchange
📊 Total transparency on the public blockchain
🔴 Currently in Campari phase (Phase 1/4)

*Here's what I can do:*
/info — What is SpritzMoon
/howto — How to start mining
/phase — Current mining phase
/stats — Network stats
/top — Top 10 holders
/aperitivo — A Spritz quote 🍹
/quiz — Mini themed quiz
/help — All commands

Ready to toast? 🥂
👉 [spritzmoon.net](https://spritzmoon.net)`,

        info: `🍹 *What is SpritzMoon*

SpritzMoon is the *Italian crypto* inspired by the aperitivo that conquered the world. It's not a financial investment, not listed on exchanges, and doesn't promise euro returns.

*What it IS:*
✅ An Italian community token
✅ Free mining from phone and PC
✅ Member-to-member exchange
✅ Transparent public blockchain
✅ Max supply 21 million (like Bitcoin)
✅ 4 mining phases: Campari → Aperol → Select → Hugo

*What it's NOT:*
❌ A financial investment
❌ A promise of returns
❌ Listed on any exchange
❌ A pyramid scheme

*The vision:* turn SpritzMoon into a real lifestyle. Partner bars where you can pay your Spritz with SPM, exclusive events for members, a community that toasts together.

🔗 [spritzmoon.net](https://spritzmoon.net)
📧 info@spritzmoon.net`,

        howto: `⛏️ *How to start mining in 30 seconds*

1️⃣ Open [spritzmoon.net](https://spritzmoon.net) on your phone or PC

2️⃣ Click *"Start Mining"*

3️⃣ Your wallet is created automatically with a unique Device ID

4️⃣ Press *"Start Mining"* and you start earning SPM at the current phase rate

*Tips:*
🔸 Save your Device ID in a safe place
🔸 The earlier you start, the more SPM you accumulate (rate decreases with phases)
🔸 You can verify every transaction on the [public registry](https://spritzmoon.net/registry.html)
🔸 No costs, no registration, no app to download

⚠️ *Important:* SpritzMoon is NOT a financial investment. It's a community token that will live on the utilities the community will build over time (partner bars, events, etc).`,

        phase_loading: `🔄 Checking current mining phase...`,
        phase_error: `⚠️ Cannot reach the backend right now. Try again in a few seconds (it might be restarting).`,

        phaseMsg: (p, totalMined, phaseProgress, phaseSize, minedInPhase, nextPhase) => `${p.emoji} *${p.name} Phase* · ${p.id}/4

⚡ *Mining rate:* \`${p.rate} SPM/min\`

📊 *Phase progress:*
\`${'█'.repeat(Math.round(phaseProgress / 5))}${'░'.repeat(20 - Math.round(phaseProgress / 5))}\` ${phaseProgress.toFixed(1)}%

💎 *Phase supply:* ${formatNumber(minedInPhase)} / ${formatNumber(phaseSize)}
🌐 *Total mined:* ${formatNumber(totalMined)} / 21M (${((totalMined / 21000000) * 100).toFixed(3)}%)
${nextPhase ? `\n⏭️ *Next phase:* ${nextPhase.emoji} ${nextPhase.name}` : '\n🍹 *Next:* Spritz Completo — mining closed'}

🔗 [Live registry](https://spritzmoon.net/registry.html)`,

        spritzCompleto: `🍹 *Spritz Completo!*

The 21M SPM cap has been reached. Mining is closed forever.

The community now lives on transfers, partner bars and exclusive events. The toast is eternal! 🥂`,

        statsMsg: (s) => `📊 *SpritzMoon Stats*

🧱 Blocks: *${formatNumber(s.total_blocks)}*
👥 Total users: *${formatNumber(s.total_users)}*
🟢 Active now: *${s.active_users}*
⛏️ Active miners: *${s.active_miners}*
📝 Transactions: *${formatNumber(s.total_transactions)}*
⚡ Hash rate: *${s.total_hash_rate} TH/s*
${s.total_mined !== undefined ? `\n💎 Supply mined: *${formatNumber(s.total_mined)} / 21M* (${(s.supply_percent || 0).toFixed(3)}%)` : ''}
${s.current_phase ? `\n${s.current_phase.emoji} Phase: *${s.current_phase.name}* (${s.current_phase.rate} SPM/min)` : ''}

🔗 [Public registry](https://spritzmoon.net/registry.html)`,

        topHeader: `🏆 *Top 10 Holders — All Time*

`,
        topEmpty: `📊 No data yet. Be the first to mine!`,

        helpMsg: `🍹 *SpritzMoon Bot — Commands*

📚 *Info & onboarding*
/start — Start the bot
/info — What is SpritzMoon
/howto — How to start mining
/site — Site links
/contact — Contact email

📊 *Live stats*
/phase — Current mining phase
/stats — Network stats
/top — Top 10 holders
/registry — Public registry

🎮 *Engagement*
/aperitivo — Random Spritz quote
/quiz — Themed mini quiz
/score — Your quiz score

⚙️ *Settings*
/lang — Change language IT/EN
/help — Show this message

🔗 spritzmoon.net
📧 info@spritzmoon.net`,

        siteMsg: `🍹 *SpritzMoon — Official Links*

🌐 [Official site](https://spritzmoon.net)
⛏️ [Mining](https://spritzmoon.net/index1.html)
📋 [Public registry](https://spritzmoon.net/registry.html)
💬 [Telegram community](https://t.me/SpritzMoonCryptoToken)

📧 info@spritzmoon.net`,

        contactMsg: `📧 *SpritzMoon Contacts*

For any questions, collaborations, partnerships with bars/venues, or for those who had old BSC tokens and want to be recognized in the new community:

✉️ *info@spritzmoon.net*

We answer everyone! 🍹`,

        aperitivo: [
            "🍹 _«A Spritz a day keeps the broker away»_",
            "🍊 _«No crypto without prosecco»_",
            "🥂 _«Mining is like making a Spritz: takes patience, ice, and the right dose of Aperol»_",
            "🍹 _«The best Spritz is the one you drink with those who mine with you»_",
            "🍊 _«Every block is an ice cube in the blockchain»_",
            "🥂 _«The real value of SPM? The one you trade over a Spritz chat»_",
            "🍹 _«Satoshi would have loved aperitivo time»_",
            "🍊 _«Aperol, Campari, Select, Hugo: 4 mining phases, 4 ways to toast»_",
            "🥂 _«Community is the best ingredient of every Spritz»_",
            "🍹 _«Veneto invented Spritz, Italy invents SpritzMoon»_",
            "🍊 _«The best mining? The one you do while sipping a Spritz»_",
            "🥂 _«Transparent like ice, sweet like orange, bold like Aperol»_"
        ],

        quizQuestions: [
            { q: "Which ingredient is essential in a classic Venetian Spritz?", opts: ["Aperol", "Campari", "Vodka", "Rum"], correct: 1, expl: "The first 1860 Venetian Spritz used Campari, Aperol came later!" },
            { q: "What's the maximum supply of SpritzMoon?", opts: ["10 million", "21 million", "100 million", "1 billion"], correct: 1, expl: "21 million, exactly like Bitcoin! 🍹" },
            { q: "Which mining phase has the highest rate?", opts: ["Campari", "Aperol", "Select", "Hugo"], correct: 0, expl: "Campari is phase 1 with 0.10 SPM/min, the most generous." },
            { q: "Which Italian region does Hugo come from?", opts: ["Veneto", "Sicily", "Trentino", "Tuscany"], correct: 2, expl: "Hugo was born in Trentino Alto Adige in the early 2000s." },
            { q: "What do you need to mine SpritzMoon?", opts: ["An expensive GPU", "Just a browser", "A hardware wallet", "A Bitcoin node"], correct: 1, expl: "Just a browser! No hardware, no costs." },
            { q: "How many mining phases does SpritzMoon have?", opts: ["2", "3", "4", "8"], correct: 2, expl: "4 phases: Campari, Aperol, Select, Hugo. One per Italian Spritz!" },
            { q: "Is SpritzMoon listed on exchanges?", opts: ["Yes, on Binance", "Yes, on Coinbase", "No, never", "Only on DEX"], correct: 2, expl: "No and never will! It's a community token, not an investment." },
            { q: "What happens when the 21M cap is reached?", opts: ["Price explodes", "Mining closes forever", "A new token is created", "Nothing changes"], correct: 1, expl: "Mining closes. Community continues with transfers and future utilities." },
            { q: "When was Campari created?", opts: ["1760", "1860", "1920", "1950"], correct: 1, expl: "1860, in Novara. The pioneer of Spritz!" },
            { q: "What does '0.10 SPM/min' rate mean?", opts: ["10 SPM per hour", "0.10 SPM per minute", "10 SPM per second", "0.10 SPM per day"], correct: 1, expl: "0.10 SPM per minute = 6 SPM per hour = 144 SPM per day (in Campari phase)." }
        ],

        quizCorrect: (expl) => `✅ *Correct!*\n\n${expl}\n\nUse /quiz for another question!`,
        quizWrong: (correct, expl) => `❌ *Wrong!*\n\nThe correct answer was: *${correct}*\n\n${expl}\n\nTry again with /quiz!`,
        scoreMsg: (s) => `🎮 *Your quiz score*\n\n✅ Correct answers: *${s.score}*\n📝 Total attempts: *${s.attempts}*\n📊 Accuracy: *${s.attempts > 0 ? ((s.score / s.attempts) * 100).toFixed(1) : 0}%*\n\nKeep going with /quiz! 🍹`,
        scoreEmpty: `🎮 You haven't played yet! Try /quiz to start.`,

        langSet: `✅ Language set: *English* 🇬🇧`,
        welcomeMember: (name) => `🍹 Welcome *${escMd(name)}* to the SpritzMoon community!

You're in the right place if you love:
✨ Spritz and the Italian aperitivo
🆓 Free mining without investments
🤝 Real communities, not speculators

*To start:*
1️⃣ Open [spritzmoon.net](https://spritzmoon.net)
2️⃣ Click "Start Mining"
3️⃣ Let's toast together! 🥂

Have questions? Write here or use /help`,

        announcePrefix: `📢 *SpritzMoon Announcement*\n\n`,
        adminOnly: `❌ Admin-only command.`
    }
};

// ─── COMMAND: /start ───────────────────────────
bot.command('start', async (ctx) => {
    try {
        const lang = getLang(ctx.from.id);
        await ctx.reply(T[lang].welcome, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (e) { console.error('start:', e); }
});

// ─── COMMAND: /info ────────────────────────────
bot.command('info', async (ctx) => {
    try {
        const lang = getLang(ctx.from.id);
        await ctx.reply(T[lang].info, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (e) { console.error('info:', e); }
});

// ─── COMMAND: /howto ───────────────────────────
bot.command('howto', async (ctx) => {
    try {
        const lang = getLang(ctx.from.id);
        await ctx.reply(T[lang].howto, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (e) { console.error('howto:', e); }
});

// ─── COMMAND: /phase ───────────────────────────
bot.command('phase', async (ctx) => {
    try {
        const lang = getLang(ctx.from.id);
        const data = await fetchAPI('/mining/phase');
        if (!data || !data.success) {
            return ctx.reply(T[lang].phase_error, { parse_mode: 'Markdown' });
        }
        if (data.cap_reached) {
            return ctx.reply(T[lang].spritzCompleto, { parse_mode: 'Markdown' });
        }
        const p = data.current_phase;
        const totalMined = data.total_mined || 0;
        const phaseSize = 21_000_000 / 4;
        const phaseStart = (p.id - 1) * phaseSize;
        const minedInPhase = Math.max(0, totalMined - phaseStart);
        const phaseProgress = (minedInPhase / phaseSize) * 100;
        const phases = [
            { id: 1, name: 'Campari', emoji: '🔴', rate: 0.10 },
            { id: 2, name: 'Aperol', emoji: '🟠', rate: 0.05 },
            { id: 3, name: 'Select', emoji: '🟤', rate: 0.02 },
            { id: 4, name: 'Hugo', emoji: '🟢', rate: 0.005 }
        ];
        const nextPhase = phases.find(ph => ph.id === p.id + 1);
        await ctx.reply(
            T[lang].phaseMsg(p, totalMined, phaseProgress, phaseSize, minedInPhase, nextPhase),
            { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
    } catch (e) { console.error('phase:', e); }
});

// ─── COMMAND: /stats ───────────────────────────
bot.command('stats', async (ctx) => {
    try {
        const lang = getLang(ctx.from.id);
        const data = await fetchAPI('/blockchain/stats');
        if (!data || !data.success) {
            return ctx.reply(T[lang].phase_error, { parse_mode: 'Markdown' });
        }
        await ctx.reply(T[lang].statsMsg(data.stats), { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (e) { console.error('stats:', e); }
});

// ─── COMMAND: /top ─────────────────────────────
// Note: il backend non ha un endpoint /top dedicato, leggiamo da /blockchain/transactions
// e calcoliamo grossolanamente. Versione semplificata: mostriamo solo il counter da stats.
bot.command('top', async (ctx) => {
    try {
        const lang = getLang(ctx.from.id);
        // Per una vera leaderboard servirebbe un endpoint dedicato. Per ora aggreghiamo le tx.
        const data = await fetchAPI('/blockchain/transactions?limit=500');
        if (!data || !data.success || !data.transactions) {
            return ctx.reply(T[lang].topEmpty, { parse_mode: 'Markdown' });
        }
        // Aggregiamo balance approssimativi
        const balances = new Map();
        for (const tx of data.transactions) {
            if (tx.type === 'mining' || tx.type === 'faucet' || tx.type === 'daily') {
                if (tx.to) balances.set(tx.to, (balances.get(tx.to) || 0) + tx.amount);
            } else if (tx.type === 'transfer') {
                if (tx.to) balances.set(tx.to, (balances.get(tx.to) || 0) + tx.amount);
                if (tx.from) balances.set(tx.from, (balances.get(tx.from) || 0) - tx.amount);
            }
        }
        const sorted = [...balances.entries()]
            .filter(([id]) => id && id.startsWith('SPM_'))
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        if (sorted.length === 0) return ctx.reply(T[lang].topEmpty, { parse_mode: 'Markdown' });

        let msg = T[lang].topHeader;
        const medals = ['🥇', '🥈', '🥉'];
        sorted.forEach(([id, bal], i) => {
            const medal = medals[i] || `${i + 1}.`;
            const shortId = id.slice(0, 12) + '...';
            msg += `${medal} \`${shortId}\`\n    *${bal.toFixed(2)} SPM*\n\n`;
        });
        msg += `_${lang === 'it' ? 'Calcolato dalle ultime 500 transazioni' : 'Computed from last 500 transactions'}_`;
        await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) { console.error('top:', e); }
});

// ─── COMMAND: /registry ────────────────────────
bot.command('registry', async (ctx) => {
    const lang = getLang(ctx.from.id);
    const msg = lang === 'it'
        ? `📋 *Registro pubblico SpritzMoon*\n\nOgni transazione è visibile in tempo reale:\n\n🔗 [spritzmoon.net/registry.html](https://spritzmoon.net/registry.html)\n\nTrasparenza totale, sempre. 🍹`
        : `📋 *SpritzMoon public registry*\n\nEvery transaction is visible in real-time:\n\n🔗 [spritzmoon.net/registry.html](https://spritzmoon.net/registry.html)\n\nTotal transparency, always. 🍹`;
    await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
});

// ─── COMMAND: /site ────────────────────────────
bot.command('site', async (ctx) => {
    try {
        const lang = getLang(ctx.from.id);
        await ctx.reply(T[lang].siteMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (e) { console.error('site:', e); }
});

// ─── COMMAND: /contact ─────────────────────────
bot.command('contact', async (ctx) => {
    try {
        const lang = getLang(ctx.from.id);
        await ctx.reply(T[lang].contactMsg, { parse_mode: 'Markdown' });
    } catch (e) { console.error('contact:', e); }
});

// ─── COMMAND: /aperitivo ───────────────────────
bot.command('aperitivo', async (ctx) => {
    try {
        const lang = getLang(ctx.from.id);
        const quotes = T[lang].aperitivo;
        const q = quotes[Math.floor(Math.random() * quotes.length)];
        await ctx.reply(q, { parse_mode: 'Markdown' });
    } catch (e) { console.error('aperitivo:', e); }
});

// ─── COMMAND: /quiz ────────────────────────────
const activeQuizzes = new Map(); // userId → { questionIndex, correct, options }

bot.command('quiz', async (ctx) => {
    try {
        const lang = getLang(ctx.from.id);
        const questions = T[lang].quizQuestions;
        const idx = Math.floor(Math.random() * questions.length);
        const q = questions[idx];
        activeQuizzes.set(ctx.from.id, { idx, correct: q.correct, opts: q.opts, expl: q.expl });

        const kb = new InlineKeyboard();
        q.opts.forEach((opt, i) => {
            kb.text(`${String.fromCharCode(65 + i)}) ${opt}`, `quiz_${i}`).row();
        });
        const header = lang === 'it' ? `🎮 *Quiz SpritzMoon*\n\n` : `🎮 *SpritzMoon Quiz*\n\n`;
        await ctx.reply(header + `*${q.q}*`, { parse_mode: 'Markdown', reply_markup: kb });
    } catch (e) { console.error('quiz:', e); }
});

bot.callbackQuery(/^quiz_(\d+)$/, async (ctx) => {
    try {
        const lang = getLang(ctx.from.id);
        const answer = parseInt(ctx.match[1]);
        const session = activeQuizzes.get(ctx.from.id);
        if (!session) {
            return ctx.answerCallbackQuery({ text: lang === 'it' ? 'Sessione scaduta. Usa /quiz' : 'Session expired. Use /quiz' });
        }

        const score = quizScores.get(ctx.from.id) || { score: 0, attempts: 0 };
        score.attempts++;

        if (answer === session.correct) {
            score.score++;
            await ctx.answerCallbackQuery({ text: '✅ Esatto!' });
            await ctx.editMessageText(T[lang].quizCorrect(session.expl), { parse_mode: 'Markdown' });
        } else {
            await ctx.answerCallbackQuery({ text: '❌ Sbagliato' });
            await ctx.editMessageText(T[lang].quizWrong(session.opts[session.correct], session.expl), { parse_mode: 'Markdown' });
        }

        quizScores.set(ctx.from.id, score);
        activeQuizzes.delete(ctx.from.id);
    } catch (e) { console.error('quiz callback:', e); }
});

// ─── COMMAND: /score ───────────────────────────
bot.command('score', async (ctx) => {
    try {
        const lang = getLang(ctx.from.id);
        const score = quizScores.get(ctx.from.id);
        if (!score) return ctx.reply(T[lang].scoreEmpty, { parse_mode: 'Markdown' });
        await ctx.reply(T[lang].scoreMsg(score), { parse_mode: 'Markdown' });
    } catch (e) { console.error('score:', e); }
});

// ─── COMMAND: /lang ────────────────────────────
bot.command('lang', async (ctx) => {
    try {
        const current = getLang(ctx.from.id);
        const newLang = current === 'it' ? 'en' : 'it';
        userLang.set(ctx.from.id, newLang);
        await ctx.reply(T[newLang].langSet, { parse_mode: 'Markdown' });
    } catch (e) { console.error('lang:', e); }
});

// ─── COMMAND: /help ────────────────────────────
bot.command('help', async (ctx) => {
    try {
        const lang = getLang(ctx.from.id);
        await ctx.reply(T[lang].helpMsg, { parse_mode: 'Markdown' });
    } catch (e) { console.error('help:', e); }
});

// ─── ADMIN: /announce ──────────────────────────
bot.command('announce', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.reply(T[getLang(ctx.from.id)].adminOnly);
    }
    const text = ctx.match;
    if (!text) return ctx.reply('Usage: /announce <message>');
    if (!COMMUNITY_CHAT_ID) {
        return ctx.reply('❌ COMMUNITY_CHAT_ID not configured. Set the env var to enable announcements.');
    }
    try {
        await bot.api.sendMessage(COMMUNITY_CHAT_ID, T.it.announcePrefix + text, { parse_mode: 'Markdown' });
        await ctx.reply('✅ Announcement sent to community chat');
    } catch (e) {
        await ctx.reply('❌ Error: ' + e.message);
    }
});

// ─── GROUP: welcome new members ────────────────
bot.on('chat_member', async (ctx) => {
    try {
        if (ctx.chatMember.new_chat_member.status === 'member' &&
            ctx.chatMember.old_chat_member.status === 'left') {
            const user = ctx.chatMember.new_chat_member.user;
            if (user.is_bot) return;
            const name = user.first_name || 'amico';
            // Default in Italian for the community
            await ctx.reply(T.it.welcomeMember(name), {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
        }
    } catch (e) { console.error('welcome:', e); }
});

// Fallback: also handle the simpler new_chat_members event (when the bot is in the group as regular member)
bot.on(':new_chat_members', async (ctx) => {
    try {
        const newMembers = ctx.message.new_chat_members || [];
        for (const user of newMembers) {
            if (user.is_bot) continue;
            const name = user.first_name || 'amico';
            await ctx.reply(T.it.welcomeMember(name), {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
        }
    } catch (e) { console.error('new_chat_members:', e); }
});

// ─── ERROR HANDLER ─────────────────────────────
bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Bot error for update ${ctx?.update?.update_id}:`);
    const e = err.error;
    if (e instanceof GrammyError) console.error('Grammy:', e.description);
    else if (e instanceof HttpError) console.error('HTTP:', e);
    else console.error('Unknown:', e);
});

// ─── START ─────────────────────────────────────
bot.start({
    allowed_updates: ['message', 'callback_query', 'chat_member']
});

console.log('✅ Bot started successfully!');
console.log('🍹 SpritzMoon bot is now listening for commands');

process.on('SIGTERM', () => { bot.stop(); process.exit(0); });
process.on('SIGINT', () => { bot.stop(); process.exit(0); });

const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    maxHttpBufferSize: 1e8,
    pingTimeout: 60000,
    pingInterval: 25000
});
const path = require('path');
const fs = require('fs');
const https = require('https');

// === DECK BUILDER DEPENDENCIES ===
const sharp = require('sharp');
const archiver = require('archiver');

app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));

// ============================================================================
//  PART 1: DECK BUILDER BACKEND (Ported from Grabon.py)
// ============================================================================

// --- Configuration ---
const IMAGE_QUALITY = 60;
const MAX_IMAGE_WIDTH = 500;
const REQUEST_DELAY = 150; // ms
const MAX_WORKERS = 4;
const MOXFIELD_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json'
};
const IMAGE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'Referer': 'https://scryfall.com/'
};

// --- Builder State ---
let currentJob = { active: false, progress: 0, total: 0, message: "", result: null, error: null, missing: [], done: false };
let activeDeck = { deckName: "New Deck", command: [], library: [], tokens: [] };

// --- Utility: Sleep ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Image Optimization (replaces Python Pillow) ---
async function optimizeImage(b64String) {
    if (!b64String) return b64String;
    try {
        const parts = b64String.split(',');
        if (parts.length < 2) return b64String;
        const data = Buffer.from(parts[1], 'base64');

        let img = sharp(data);
        const meta = await img.metadata();

        if (meta.width > MAX_IMAGE_WIDTH) {
            const ratio = MAX_IMAGE_WIDTH / meta.width;
            const newHeight = Math.round(meta.height * ratio);
            img = img.resize(MAX_IMAGE_WIDTH, newHeight, { fit: 'fill' });
        }

        const output = await img.flatten({ background: '#000000' }).jpeg({ quality: IMAGE_QUALITY }).toBuffer();
        return "data:image/jpeg;base64," + output.toString('base64');
    } catch (e) {
        console.error(`Image optimization failed: ${e.message}`);
        return b64String;
    }
}

// --- HTTP Fetch with Retry ---
async function safeFetch(url, isImage = false) {
    const headers = isImage ? IMAGE_HEADERS : MOXFIELD_HEADERS;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await sleep(REQUEST_DELAY + Math.random() * 100);
            const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
            if (resp.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
            if (resp.status === 404) return null;
            if (!resp.ok) continue;
            return resp;
        } catch (e) {
            if (attempt === 2) return null;
        }
    }
    return null;
}

// --- Safe Download (image URL → optimized base64) ---
async function safeDownload(url) {
    const resp = await safeFetch(url, true);
    if (!resp) return null;
    try {
        const buffer = Buffer.from(await resp.arrayBuffer());
        const rawB64 = "data:image/jpeg;base64," + buffer.toString('base64');
        return await optimizeImage(rawB64);
    } catch { return null; }
}

// --- Scryfall Metadata (3-tier lookup) ---
async function fetchScryfallMetadata(sid, name) {
    // 1. By Scryfall ID
    if (sid) {
        const resp = await safeFetch(`https://api.scryfall.com/cards/${sid}`);
        if (resp) { try { return await resp.json(); } catch { } }
    }
    // 2. Exact name match
    try {
        const safeName = encodeURIComponent(name);
        const resp = await safeFetch(`https://api.scryfall.com/cards/named?exact=${safeName}`);
        if (resp) { try { return await resp.json(); } catch { } }
    } catch { }
    // 3. Fuzzy name match
    try {
        const safeName = encodeURIComponent(name);
        const resp = await safeFetch(`https://api.scryfall.com/cards/named?fuzzy=${safeName}`);
        if (resp) { try { return await resp.json(); } catch { } }
    } catch { }
    return null;
}

// --- Process Single Card ---
async function processSingleCard(item, isToken = false) {
    const cardObj = isToken ? item : (item.card || {});
    const qty = item.quantity || 1;
    const name = cardObj.name || 'Unknown';
    const sid = cardObj.scryfall_id;

    currentJob.message = `Fetching: ${name}`;
    console.log(`Fetching: ${name}`);

    let frontImg = null, backImg = null;
    const meta = await fetchScryfallMetadata(sid, name);

    if (meta) {
        try {
            if (meta.card_faces && !meta.image_uris) {
                frontImg = await safeDownload(meta.card_faces[0].image_uris.large);
                backImg = await safeDownload(meta.card_faces[1].image_uris.large);
            } else {
                let url = meta.image_uris ? meta.image_uris.large : null;
                if (!url && meta.card_faces) url = meta.card_faces[0].image_uris.large;
                frontImg = await safeDownload(url);
            }
        } catch (e) {
            console.error(`Error parsing meta for ${name}: ${e.message}`);
        }
    }

    if (!frontImg && sid) {
        frontImg = await safeDownload(`https://api.scryfall.com/cards/${sid}?format=image&version=large`);
    }

    currentJob.progress += 1;

    if (frontImg) {
        console.log(`[SUCCESS] ${name}`);
        const cardData = {
            id: `c_${Math.floor(10000 + Math.random() * 90000)}`,
            name, front: frontImg, back: backImg, is_flipped: false
        };
        return Array.from({ length: qty }, () => ({ ...cardData }));
    } else {
        console.log(`[FAILED] ${name}`);
        return [];
    }
}

// --- Parallel Card Processing with concurrency limit ---
async function processCardsParallel(items, isToken = false) {
    const results = [];
    // Process in batches of MAX_WORKERS
    for (let i = 0; i < items.length; i += MAX_WORKERS) {
        const batch = items.slice(i, i + MAX_WORKERS);
        const batchResults = await Promise.all(batch.map(item => processSingleCard(item, isToken)));
        for (const r of batchResults) results.push(...r);
    }
    return results;
}

// --- Import Job from pre-fetched card lists (browser fetches Moxfield, server downloads images) ---
async function runImportFromCards(deckName, commanders, library, tokens) {
    try {
        currentJob = { active: true, progress: 0, total: 0, message: "Starting image downloads...", result: null, error: null, missing: [], done: false };

        currentJob.total = commanders.length + library.length + tokens.length;

        const newDeck = { deckName: deckName || "Imported", command: [], library: [], tokens: [] };

        const trackProcess = async (item, isTok = false) => {
            const res = await processSingleCard(item, isTok);
            if (!res || res.length === 0) {
                const c = isTok ? item : (item.card || {});
                currentJob.missing.push(c.name || 'Unknown');
            }
            return res;
        };

        // Process commanders
        for (let i = 0; i < commanders.length; i += MAX_WORKERS) {
            const batch = commanders.slice(i, i + MAX_WORKERS);
            const results = await Promise.all(batch.map(item => trackProcess(item)));
            for (const r of results) newDeck.command.push(...r);
        }

        // Process library
        for (let i = 0; i < library.length; i += MAX_WORKERS) {
            const batch = library.slice(i, i + MAX_WORKERS);
            const results = await Promise.all(batch.map(item => trackProcess(item)));
            for (const r of results) newDeck.library.push(...r);
        }

        // Process tokens
        for (let i = 0; i < tokens.length; i += MAX_WORKERS) {
            const batch = tokens.slice(i, i + MAX_WORKERS);
            const results = await Promise.all(batch.map(item => trackProcess(item, true)));
            for (const r of results) newDeck.tokens.push(...r);
        }

        activeDeck = newDeck;
        currentJob.result = newDeck;
        currentJob.done = true;
        currentJob.message = "Done!";

    } catch (e) {
        console.error(`Import error: ${e.message}`);
        currentJob.error = e.message;
        currentJob.done = true;
    }
}

// === DECK BUILDER API ROUTES ===

// Accept pre-fetched card lists from browser and download images from Scryfall
app.post('/api/builder/import-cards', (req, res) => {
    const { deckName, commanders, library, tokens } = req.body;
    if (!commanders && !library) return res.status(400).json({ error: "Missing card data" });
    runImportFromCards(deckName, commanders || [], library || [], tokens || []);
    res.json({ status: "started" });
});

// Moxfield proxy — uses curl.exe to bypass Cloudflare TLS fingerprinting
const { execFile } = require('child_process');

function curlFetchMoxfield(url) {
    return new Promise((resolve, reject) => {
        const args = [
            '-s', '-L',
            '--max-time', '15',
            '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            '-H', 'Accept: application/json, text/plain, */*',
            '-H', 'Accept-Language: en-US,en;q=0.9',
            '-H', 'Origin: https://www.moxfield.com',
            '-H', 'Referer: https://www.moxfield.com/',
            url
        ];
        execFile('curl.exe', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(`curl failed: ${err.message}`));
            resolve(stdout);
        });
    });
}

app.get('/api/builder/moxfield-proxy', async (req, res) => {
    const deckId = req.query.id;
    if (!deckId) return res.status(400).json({ error: 'Missing deck ID' });
    const safeId = encodeURIComponent(deckId);

    try {
        // Try v3 first
        let body = await curlFetchMoxfield(`https://api2.moxfield.com/v3/decks/all/${safeId}`);
        let data;
        try { data = JSON.parse(body); } catch {
            // v3 failed (HTML/error), try v2
            console.log('Moxfield v3 failed, trying v2...');
            body = await curlFetchMoxfield(`https://api.moxfield.com/v2/decks/all/${safeId}`);
            data = JSON.parse(body);
        }

        if (data && (data.name || data.mainboard || data.commanders)) {
            res.json(data);
        } else {
            throw new Error('Invalid response from Moxfield');
        }
    } catch (e) {
        console.error('Moxfield proxy error:', e.message);
        res.status(502).json({ error: `Could not fetch deck from Moxfield. Is it public/unlisted? (${e.message})` });
    }
});

// Poll import status
app.get('/api/builder/status', (req, res) => {
    const statusCopy = { ...currentJob };
    if (!statusCopy.done) statusCopy.result = null;
    res.json(statusCopy);
});

// Sync deck state
app.post('/api/builder/sync', (req, res) => {
    const data = req.body;
    if (data && (data.command || data.library || data.tokens)) {
        activeDeck = data;
    }
    res.json(activeDeck);
});

// Manual add card (with image optimization)
app.post('/api/builder/add-card', async (req, res) => {
    const data = req.body;
    try {
        const front = await optimizeImage(data.front);
        const back = data.back ? await optimizeImage(data.back) : null;

        const newCard = {
            id: `m-${Date.now()}`,
            name: data.name || "New Card",
            front, back,
            is_flipped: false
        };

        const zone = data.zone || 'library';
        if (!activeDeck[zone]) activeDeck[zone] = [];
        activeDeck[zone].push(newCard);

        res.json({ status: "ok", deck: activeDeck });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Download all card images as ZIP
app.get('/api/builder/download', (req, res) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${(activeDeck.deckName || 'Deck').replace(/\s+/g, '_')}_cards.zip"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);

    for (const zone of ['command', 'library', 'tokens']) {
        (activeDeck[zone] || []).forEach((card, i) => {
            const safeName = (card.name || 'card').replace(/[^a-zA-Z0-9 _-]/g, '').trim();
            if (card.front) {
                try {
                    const parts = card.front.split(',');
                    if (parts.length >= 2) {
                        archive.append(Buffer.from(parts[1], 'base64'), { name: `${zone}/${safeName}_${i}_front.jpg` });
                    }
                } catch { }
            }
            if (card.back) {
                try {
                    const parts = card.back.split(',');
                    if (parts.length >= 2) {
                        archive.append(Buffer.from(parts[1], 'base64'), { name: `${zone}/${safeName}_${i}_back.jpg` });
                    }
                } catch { }
            }
        });
    }

    archive.finalize();
});

// Serve index.html at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// ============================================================================
//  PART 2: ARENA GAME SERVER (Original, unchanged)
// ============================================================================

// --- CONSTANTS FOR GUEST NAMES ---
const ADJECTIVES = ["Abrasive", "Abrupt", "Acidic", "Active", "Aggressive", "Agile", "Alert", "Ancient", "Angry", "Animated", "Annoying", "Anxious", "Arrogant", "Ashamed", "Attractive", "Average", "Awful", "Beautiful", "Celestial", "Best", "Better", "Bewildered", "Big", "Bitter", "Black", "Bland", "Blue", "Boiling", "Bold", "Boring", "Brave", "Bright", "Broad", "Broken", "Bumpy", "Busy", "Calm", "Careful", "Charming", "Cheap", "Cheerful", "Chubby", "Clean", "Clever", "Clumsy", "Cold", "Colorful", "Colossal", "Combative", "Common", "Complete", "Confused", "Cooperative", "Courageous", "Crazy", "Creepy", "Cruel", "Curious", "Cute", "Dangerous", "Dark", "Dead", "Deafening", "Deep", "Defeated", "Delicate", "Delicious", "Determined", "Different", "Difficult", "Dirty", "Disgusting", "Distinct", "Disturbed", "Dizzy", "Drab", "Dry", "Dull", "Dusty", "Eager", "Early", "Easy", "Elegant", "Embarrassed", "Empty", "Enchanted", "Energetic", "Enormous", "Enthusiastic", "Envious", "Evil", "Excited", "Expensive", "Faint", "Fair", "Faithful", "Famous", "Fancy", "Fantastic", "Fast", "Fat", "Fearful", "Fearless", "Ferocious", "Filthy", "Fine", "Flat", "Fluffy", "Foolish", "Fragile", "Frail", "Frantic", "Free", "Fresh", "Friendly", "Frightened", "Funny", "Fuzzy", "Gentle", "Giant", "Gifted", "Gigantic", "Glamorous", "Gleaming", "Glorious", "Good", "Gorgeous", "Graceful", "Great", "Greedy", "Green", "Grieving", "Grim", "Grotesque", "Grumpy", "Handsome", "Happy", "Hard", "Harsh", "Healthy", "Heavy", "Helpful", "Helpless", "High", "Hilarious", "Hollow", "Homeless", "Honest", "Horrible", "Hot", "Huge", "Hungry", "Hurt", "Icy", "Ideal", "Ill", "Immense", "Important", "Impossible", "Innocent", "Inquisitive", "Insane", "Intelligent", "Intense", "Interesting", "Irritating", "Itchy", "Jealous", "Jittery", "Jolly", "Joyous", "Juicy", "Kind", "Large", "Late", "Lazy", "Light", "Little", "Lonely", "Long", "Loose", "Loud", "Lovely", "Lucky", "Mad", "Magnificent", "Massive", "Mean", "Melodic", "Melted", "Messy", "Mighty", "Miniature", "Modern", "Motionless", "Muddy", "Mushy", "Mysterious", "Nasty", "Naughty", "Nervous", "New", "Nice", "Noisy", "Nutty", "Obedient", "Obnoxious", "Odd", "Old", "Open", "Orange", "Ordinary", "Outrageous", "Outstanding", "Pale", "Panicky", "Perfect", "Plain", "Pleasant", "Poised", "Poor", "Powerful", "Precious", "Prickly", "Proud", "Purple", "Putrid", "Quaint", "Quick", "Quiet", "Rapid", "Rare", "Real", "Red", "Rich", "Right", "Ripe", "Robust", "Rotten", "Rough", "Round", "Royal", "Rude", "Sad", "Safe", "Salty", "Scary", "Secret", "Selfish", "Serious", "Sharp", "Shiny", "Shocking", "Short", "Shy", "Silly", "Simple", "Skinny", "Sleepy", "Slim", "Slow", "Small", "Smart", "Smooth", "Soft", "Solid", "Sore", "Sour", "Sparkling", "Spicy", "Splendid", "Spotless", "Square", "Steady", "Steep", "Sticky", "Stormy", "Straight", "Strange", "Strong", "Stupid", "Successful", "Sweet", "Swift", "Tall", "Tame", "Tasty", "Tender", "Tense", "Terrible", "Thick", "Thin", "Thirsty", "Thoughtful", "Tight", "Tiny", "Tired", "Tough", "Troubled", "Ugly", "Uninterested", "Unsightly", "Unusual", "Upset", "Uptight", "Vast", "Victorious", "Vivacious", "Wandering", "Warm", "Weak", "Wealthy", "Weary", "Wet", "Whispering", "White", "Wicked", "Wide", "Wild", "Wise", "Witty", "Wonderful", "Worried", "Wrong", "Yellow", "Young", "Zany", "Zealous"];
const NOUNS = ["Acacia", "Acanthus", "Acorn Squash", "Agapanthus", "Alfalfa", "Allium", "Almond", "Aloe Vera", "Amaranth", "Amaryllis", "Anemone", "Angelica", "Anise", "Apple", "Apricot", "Artichoke", "Arugula", "Asparagus", "Aster", "Aubergine", "Avocado", "Azalea", "Bamboo", "Banana", "Basil", "Bean", "Beet", "Begonia", "Bell Pepper", "Bergamot", "Bilberry", "Blackberry", "Bluebell", "Blueberry", "Bok Choy", "Broccoli", "Buttercup", "Cabbage", "Cactus", "Calendula", "Camellia", "Cantaloupe", "Carnation", "Carrot", "Cauliflower", "Celery", "Chamomile", "Chard", "Cherry", "Chestnut", "Chickpea", "Chili Pepper", "Chrysanthemum", "Cilantro", "Clementine", "Clover", "Coconut", "Corn", "Cornflower", "Cosmos", "Cranberry", "Crocus", "Cucumber", "Currant", "Cyclamen", "Daffodil", "Dahlia", "Daisy", "Dandelion", "Date", "Daylily", "Delphinium", "Dill", "Dragon Fruit", "Elderberry", "Fennel", "Fern", "Fig", "Foxglove", "Freesia", "Fuchsia", "Gardenia", "Garlic", "Geranium", "Ginger", "Gladiolus", "Goldenrod", "Gooseberry", "Grape", "Grapefruit", "Guava", "Hazelnut", "Heather", "Hibiscus", "Holly", "Honeydew", "Honeysuckle", "Hops", "Hyacinth", "Hydrangea", "Iris", "Ivy", "Jasmine", "Juniper", "Kale", "Kiwi", "Kumquat", "Lavender", "Leek", "Lemon", "Lettuce", "Lilac", "Lily", "Lime", "Lotus", "Lychee", "Magnolia", "Mango", "Marigold", "Melon", "Mint", "Mushroom", "Narcissus", "Nasturtium", "Nectarine", "Nutmeg", "Oak", "Olive", "Onion", "Orange", "Orchid", "Oregano", "Pansy", "Papaya", "Parsley", "Peach", "Pear", "Peony", "Pepper", "Peppermint", "Persimmon", "Petunia", "Pine", "Pineapple", "Pistachio", "Plum", "Pomegranate", "Poppy", "Potato", "Pumpkin", "Radish", "Raspberry", "Rose", "Rosemary", "Sage", "Snapdragon", "Snowdrop", "Spinach", "Squash", "Starfruit", "Strawberry", "Sunflower", "Tangerine", "Tea", "Thistle", "Thyme", "Tomato", "Tulip", "Turnip", "Violet", "Walnut", "Watermelon", "Wheat", "Wisteria", "Yam", "Yarrow", "Zinnia", "Zucchini", "Basilisk", "Behemoth", "Centaur", "Cerberus", "Chimera", "Cyclops", "Dragon", "Drake", "Dryad", "Dwarf", "Elf", "Gargoyle", "Ghost", "Ghoul", "Giant", "Goblin", "Golem", "Griffin", "Hydra", "Imp", "Kobold", "Kraken", "Lich", "Manticore", "Medusa", "Mimic", "Minotaur", "Nymph", "Ogre", "Orc", "Owlbear", "Pegasus", "Phoenix", "Satyr", "Skeleton", "Sphinx", "Spirit", "Sprite", "Treant", "Troll", "Unicorn", "Vampire", "Werewolf", "Wraith", "Wyvern", "Yeti", "Zombie"];

// --- STATE ---
let gameState = { players: [], active: false };
let socketOwner = {};
let globalImageCache = {};

function generateGuestName() {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    return `${adj} ${noun}`;
}

function makeData(c, ownerId, isToken = false) {
    const uid = Math.random().toString(36).substr(2, 9);

    globalImageCache[uid] = {
        front: c.image || null,
        back: c.backImage || null
    };

    return {
        ...c,
        uid: uid,
        owner: ownerId,
        image: null,
        backImage: null,
        rotation: 0,
        transformed: false,
        isToken: isToken,
        counters: [],
        x: 0.5, y: 0.5
    };
}

function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
}

function broadcastState() {
    io.sockets.sockets.forEach((socket) => {
        const myPid = socketOwner[socket.id];

        const secretPlayers = gameState.players.map(p => {
            if (p.id !== myPid) {
                return {
                    ...p,
                    hand: p.hand.map(c => ({
                        uid: c.uid,
                        owner: c.owner,
                        isUnknown: true,
                        counters: c.counters
                    })),
                    library: p.library.map(() => ({ uid: 'hidden' }))
                };
            }
            return p;
        });

        socket.emit('stateUpdate', { players: secretPlayers, active: gameState.active });
    });
}

io.on('connection', (socket) => {
    console.log(`[Connect] ${socket.id}`);

    socket.emit('updateImageCache', globalImageCache);
    if (gameState.players.length > 0) broadcastState();

    socket.on('registerPlayer', ({ deckData, displayName }) => {
        const slots = ['P1', 'P2', 'P3', 'P4'];
        const takenSeats = Object.values(socketOwner);
        const assignedPid = slots.find(slot => !takenSeats.includes(slot));

        if (!assignedPid) {
            socket.emit('joinError', 'Game is full (4/4 players)!');
            return;
        }

        const pid = assignedPid;
        socket.emit('playerAssigned', { pid });
        socketOwner[socket.id] = pid;

        const existing = gameState.players.find(p => p.id === pid);

        let finalName = displayName;
        if (!finalName || finalName.trim() === "") {
            finalName = generateGuestName();
        } else if (deckData.deckName && !displayName) {
            finalName = deckData.deckName;
        }

        if (!existing) {
            const library = deckData.library.map(c => makeData(c, pid));
            const command = deckData.command.map(c => makeData(c, pid));

            const tokens = (deckData.tokens || []).map(t => {
                const tUid = Math.random().toString(36).substr(2, 9);
                globalImageCache[tUid] = { front: t.image, back: t.backImage };
                return {
                    ...t, id: tUid, uid: tUid, _cacheId: tUid,
                    image: null, backImage: null
                };
            });

            shuffle(library);

            gameState.players.push({
                id: pid, name: finalName, life: 40,
                library, command, tokens,
                hand: [], graveyard: [], exile: [], battlefield: []
            });

            const p = gameState.players.find(x => x.id === pid);
            for (let i = 0; i < 7; i++) if (p.library.length) doMoveCard(pid, 'library', pid, 'hand');

            io.emit('updateImageCache', globalImageCache);
        } else {
            existing.name = finalName;
        }
        broadcastState();
    });

    socket.on('spawnToken', ({ pid, templateId, x, y }) => {
        const p = gameState.players.find(x => x.id === pid);
        if (!p) return;
        const template = p.tokens.find(t => t.id === templateId);
        if (template) {
            const cacheData = globalImageCache[template._cacheId];
            const token = makeData({
                ...template,
                image: cacheData ? cacheData.front : null,
                backImage: cacheData ? cacheData.back : null
            }, pid, true);
            token.x = x; token.y = y;
            p.battlefield.push(token);
            io.emit('updateImageCache', globalImageCache);
            broadcastState();
        }
    });

    socket.on('untapAll', ({ pid }) => {
        const p = gameState.players.find(x => x.id === pid);
        if (!p) return;
        p.battlefield.forEach(c => { c.rotation = 0; });
        broadcastState();
    });

    socket.on('disconnect', () => {
        console.log(`[Disconnect] ${socket.id}`);
        const pid = socketOwner[socket.id];
        delete socketOwner[socket.id];

        // Remove the disconnected player's data so their seat is freed
        if (pid) {
            const pIdx = gameState.players.findIndex(p => p.id === pid);
            if (pIdx > -1) {
                // Clean up image cache for this player's cards
                const player = gameState.players[pIdx];
                const allCards = [...player.library, ...player.hand, ...player.battlefield, ...player.graveyard, ...player.exile, ...player.command];
                allCards.forEach(c => { if (c.uid) delete globalImageCache[c.uid]; });
                (player.tokens || []).forEach(t => { if (t._cacheId) delete globalImageCache[t._cacheId]; });

                gameState.players.splice(pIdx, 1);
                console.log(`[Freed Seat] ${pid} — ${gameState.players.length}/4 players remain`);
            }
            broadcastState();
        }

        if (io.engine.clientsCount === 0) {
            gameState.players = [];
            socketOwner = {};
            globalImageCache = {};
        }
    });

    socket.on('resetGame', () => {
        gameState.players = [];
        socketOwner = {};
        globalImageCache = {};
        io.emit('updateImageCache', {});
        broadcastState();
        io.emit('resetClient');
    });

    socket.on('moveCard', (payload) => {
        const { fromPid, fromZone, toPid, toZone, uid, x, y, method, index } = payload;
        doMoveCard(fromPid, fromZone, toPid, toZone, uid, x, y, method, index);
        broadcastState();
    });

    socket.on('reorderZone', ({ pid, zone, uid, targetUid }) => {
        const p = gameState.players.find(x => x.id === pid);
        if (!p) return;
        const list = p[zone];
        const oldIdx = list.findIndex(c => c.uid === uid);
        const newIdx = list.findIndex(c => c.uid === targetUid);
        if (oldIdx > -1 && newIdx > -1) {
            const [item] = list.splice(oldIdx, 1);
            list.splice(newIdx, 0, item);
            broadcastState();
        }
    });

    socket.on('modLife', ({ pid, amt }) => {
        const p = gameState.players.find(x => x.id === pid);
        if (p) p.life += amt;
        broadcastState();
    });
    socket.on('setLife', ({ pid, value }) => {
        const p = gameState.players.find(x => x.id === pid);
        if (p) p.life = value;
        broadcastState();
    });

    socket.on('cardUpdate', ({ pid, zone, uid, updates }) => {
        const p = gameState.players.find(x => x.id === pid);
        if (!p) return;
        const card = p[zone].find(c => c.uid === uid);
        if (card) Object.assign(card, updates);
        broadcastState();
    });

    socket.on('shuffle', ({ pid }) => {
        const p = gameState.players.find(x => x.id === pid);
        if (p) shuffle(p.library);
        broadcastState();
    });

    socket.on('deleteCard', ({ pid, zone, uid }) => {
        const p = gameState.players.find(x => x.id === pid);
        if (p) {
            const idx = p[zone].findIndex(c => c.uid === uid);
            if (idx > -1) {
                const card = p[zone][idx];
                doMoveCard(pid, zone, card.owner, 'graveyard', uid);
                broadcastState();
            }
        }
    });
});

function doMoveCard(fromPid, fromZone, toPid, toZone, uid, x = 0.5, y = 0.5, method = 'top', index = -1) {
    if (toZone === 'tokens') return;
    const srcP = gameState.players.find(p => p.id === fromPid);
    const tgtP = gameState.players.find(p => p.id === toPid);
    if (!srcP || !tgtP) return;

    const srcList = srcP[fromZone];
    const tgtList = tgtP[toZone];
    const card = uid ? srcList.find(c => c.uid === uid) : srcList[0];
    if (!card) return;

    const idx = srcList.indexOf(card);
    if (idx > -1) srcList.splice(idx, 1);

    if (toZone === 'battlefield') {
        card.x = x; card.y = y;
    }
    if (card.isToken && toZone !== 'battlefield') return;

    if (toZone === 'library') {
        card.rotation = 0;
        card.transformed = false;
        if (method === 'bottom') tgtList.push(card);
        else if (method === 'shuffle') { tgtList.push(card); shuffle(tgtList); }
        else tgtList.unshift(card);
    } else {
        if (index !== -1 && index <= tgtList.length) {
            tgtList.splice(index, 0, card);
        } else {
            tgtList.push(card);
        }
    }
}

// ============================================================================
//  START SERVER
// ============================================================================
const PORT = 2222;
http.listen(PORT, '0.0.0.0', () => console.log(`MTG Commander Arena running on http://localhost:${PORT}`));
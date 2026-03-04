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
const { spawn } = require('child_process');

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
let activeDeck = { deckName: "New Deck", cardBack: null, command: [], library: [], tokens: [] };

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

// --- Safe Download (image URL â†’ optimized base64) ---
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
// Returns { cards: [...], relatedTokens: [{scryfall_id, name}] }
async function processSingleCard(item, isToken = false) {
    const cardObj = isToken ? item : (item.card || {});
    const qty = item.quantity || 1;
    const name = cardObj.name || 'Unknown';
    const sid = cardObj.scryfall_id;

    currentJob.message = `Fetching: ${name}`;
    console.log(`Fetching: ${name}`);

    let frontImg = null, backImg = null;
    let meta = {
        oracle_text: null, mana_cost: null, cmc: null,
        type_line: null, colors: [], color_identity: [],
        keywords: [], power: null, toughness: null,
        rarity: null, set_name: null, is_dfc: false,
        back_oracle_text: null, back_type_line: null
    };
    const relatedTokens = [];

    const scryfallData = await fetchScryfallMetadata(sid, name);

    if (scryfallData) {
        // Extract metadata
        meta.mana_cost = scryfallData.mana_cost || null;
        meta.cmc = scryfallData.cmc ?? null;
        meta.type_line = scryfallData.type_line || null;
        meta.colors = scryfallData.colors || [];
        meta.color_identity = scryfallData.color_identity || [];
        meta.keywords = scryfallData.keywords || [];
        meta.power = scryfallData.power || null;
        meta.toughness = scryfallData.toughness || null;
        meta.rarity = scryfallData.rarity || null;
        meta.set_name = scryfallData.set_name || null;
        meta.oracle_text = scryfallData.oracle_text || null;

        // Collect related tokens from Scryfall all_parts
        if (scryfallData.all_parts) {
            for (const part of scryfallData.all_parts) {
                if (part.component === 'token') {
                    relatedTokens.push({ scryfall_id: part.id, name: part.name });
                }
            }
        }

        try {
            // Extract face-level metadata for ANY multi-face card (DFC, adventure, split, etc.)
            if (scryfallData.card_faces && scryfallData.card_faces.length >= 2) {
                const face0 = scryfallData.card_faces[0];
                const face1 = scryfallData.card_faces[1];
                meta.oracle_text = face0.oracle_text || meta.oracle_text;
                meta.mana_cost = face0.mana_cost || meta.mana_cost;
                meta.type_line = scryfallData.type_line || face0.type_line || meta.type_line;
                meta.power = face0.power || meta.power;
                meta.toughness = face0.toughness || meta.toughness;
                meta.back_oracle_text = face1.oracle_text || null;
                meta.back_type_line = face1.type_line || null;
            }

            // Handle images â€” DFCs have separate images per face, others use a shared image
            if (scryfallData.card_faces && !scryfallData.image_uris) {
                // True DFC (separate images per face)
                meta.is_dfc = true;
                frontImg = await safeDownload(scryfallData.card_faces[0].image_uris.large);
                backImg = await safeDownload(scryfallData.card_faces[1].image_uris.large);
            } else {
                let url = scryfallData.image_uris ? scryfallData.image_uris.large : null;
                if (!url && scryfallData.card_faces) url = scryfallData.card_faces[0].image_uris.large;
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
            name, front: frontImg, back: backImg, is_flipped: false,
            meta, _modified: Date.now()
        };
        return { cards: Array.from({ length: qty }, () => ({ ...cardData, meta: { ...meta } })), relatedTokens };
    } else {
        console.log(`[FAILED] ${name}`);
        return { cards: [], relatedTokens };
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

// --- Import Job from pre-fetched card lists (browser fetches Moxfield/Archidekt, server downloads images) ---
async function runImportFromCards(deckName, commanders, library, tokens) {
    try {
        currentJob = { active: true, progress: 0, total: 0, message: "Starting image downloads...", result: null, error: null, missing: [], done: false };

        currentJob.total = commanders.length + library.length + tokens.length;

        // Build only the imported cards â€” client will merge with existing deck
        const imported = { deckName: deckName || "Imported", command: [], library: [], tokens: [] };

        // Track discovered token Scryfall IDs from all_parts (for auto-discovery)
        const discoveredTokenIds = new Map(); // scryfall_id -> name

        const trackProcess = async (item, isTok = false) => {
            const result = await processSingleCard(item, isTok);
            if (!result.cards || result.cards.length === 0) {
                const c = isTok ? item : (item.card || {});
                currentJob.missing.push(c.name || 'Unknown');
            }
            // Collect discovered tokens (only from non-token cards)
            if (!isTok && result.relatedTokens) {
                for (const t of result.relatedTokens) {
                    if (!discoveredTokenIds.has(t.scryfall_id)) {
                        discoveredTokenIds.set(t.scryfall_id, t.name);
                    }
                }
            }
            return result.cards;
        };

        // Process commanders
        for (let i = 0; i < commanders.length; i += MAX_WORKERS) {
            const batch = commanders.slice(i, i + MAX_WORKERS);
            const results = await Promise.all(batch.map(item => trackProcess(item)));
            for (const r of results) imported.command.push(...r);
        }

        // Process library
        for (let i = 0; i < library.length; i += MAX_WORKERS) {
            const batch = library.slice(i, i + MAX_WORKERS);
            const results = await Promise.all(batch.map(item => trackProcess(item)));
            for (const r of results) imported.library.push(...r);
        }

        // Process explicit tokens (from Moxfield)
        for (let i = 0; i < tokens.length; i += MAX_WORKERS) {
            const batch = tokens.slice(i, i + MAX_WORKERS);
            const results = await Promise.all(batch.map(item => trackProcess(item, true)));
            for (const r of results) imported.tokens.push(...r);
        }

        // Auto-discover tokens from Scryfall all_parts (for imports without explicit tokens, e.g. Archidekt)
        if (tokens.length === 0 && discoveredTokenIds.size > 0) {
            console.log(`[Tokens] Auto-discovered ${discoveredTokenIds.size} tokens from Scryfall data`);
            currentJob.total += discoveredTokenIds.size;
            const tokenItems = [...discoveredTokenIds.entries()].map(([sid, name]) => ({
                scryfall_id: sid, name
            }));
            for (let i = 0; i < tokenItems.length; i += MAX_WORKERS) {
                const batch = tokenItems.slice(i, i + MAX_WORKERS);
                const results = await Promise.all(batch.map(item => trackProcess(item, true)));
                for (const r of results) imported.tokens.push(...r);
            }
        }

        currentJob.result = imported;
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

// Moxfield proxy â€” uses curl.exe to bypass Cloudflare TLS fingerprinting
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

// Archidekt proxy â€” fetch deck JSON server-side to bypass CORS
app.get('/api/builder/archidekt-proxy', async (req, res) => {
    const deckId = req.query.id;
    if (!deckId || !/^\d+$/.test(deckId)) return res.status(400).json({ error: 'Missing or invalid deck ID' });

    try {
        const resp = await fetch(`https://archidekt.com/api/decks/${deckId}/`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            },
            signal: AbortSignal.timeout(15000)
        });
        if (!resp.ok) {
            return res.status(resp.status).json({ error: `Archidekt returned ${resp.status}. Is the deck public?` });
        }
        const data = await resp.json();
        if (!data || !data.cards) {
            throw new Error('Invalid response from Archidekt');
        }
        res.json(data);
    } catch (e) {
        console.error('Archidekt proxy error:', e.message);
        res.status(502).json({ error: `Could not fetch deck from Archidekt. (${e.message})` });
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

// Manual add card (with image optimization + metadata)
app.post('/api/builder/add-card', async (req, res) => {
    const data = req.body;
    try {
        const front = await optimizeImage(data.front);
        const back = data.back ? await optimizeImage(data.back) : null;

        // Build metadata from provided fields or defaults
        const meta = {
            oracle_text: data.oracle_text || null,
            mana_cost: data.mana_cost || null,
            cmc: data.cmc ?? null,
            type_line: data.type_line || null,
            colors: data.colors || [],
            color_identity: data.color_identity || [],
            keywords: data.keywords || [],
            power: data.power || null,
            toughness: data.toughness || null,
            rarity: null,
            set_name: null,
            is_dfc: !!back,
            back_oracle_text: data.back_oracle_text || null,
            back_type_line: data.back_type_line || null
        };

        const newCard = {
            id: `m-${Date.now()}`,
            name: data.name || "New Card",
            front, back,
            is_flipped: false,
            meta
        };

        const zone = data.zone || 'library';
        if (!activeDeck[zone]) activeDeck[zone] = [];
        activeDeck[zone].push(newCard);

        res.json({ status: "ok", deck: activeDeck });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Optimize a single image (used by Change Image feature)
app.post('/api/builder/optimize-image', async (req, res) => {
    try {
        const optimized = await optimizeImage(req.body.image);
        res.json({ image: optimized });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Scryfall proxy â€” bypass CORS for card lookup
app.get('/api/scryfall/named', async (req, res) => {
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: 'Missing name parameter' });
    try {
        const url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`;
        const resp = await fetch(url);
        if (!resp.ok) return res.status(404).json({ error: 'Card not found' });
        const card = await resp.json();
        // Return simplified metadata
        res.json({
            name: card.name,
            mana_cost: card.mana_cost || null,
            cmc: card.cmc ?? null,
            type_line: card.type_line || null,
            oracle_text: card.oracle_text || null,
            colors: card.colors || [],
            color_identity: card.color_identity || [],
            keywords: card.keywords || [],
            power: card.power || null,
            toughness: card.toughness || null,
            rarity: card.rarity || null,
            set_name: card.set_name || null
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Scryfall autocomplete search
app.get('/api/scryfall/search', async (req, res) => {
    const q = req.query.q;
    if (!q) return res.json([]);
    try {
        const resp = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(q)}`);
        if (!resp.ok) return res.json([]);
        const data = await resp.json();
        res.json(data.data || []);
    } catch {
        res.json([]);
    }
});

// Scryfall prints â€” all printings of a card with images
app.get('/api/scryfall/prints', async (req, res) => {
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: 'Missing name' });
    try {
        // First get the oracle ID via exact name search
        const namedResp = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`);
        if (!namedResp.ok) return res.status(404).json({ error: 'Card not found' });
        const namedCard = await namedResp.json();
        const oracleId = namedCard.oracle_id;

        // Then get all prints
        const printsResp = await fetch(`https://api.scryfall.com/cards/search?order=released&q=oracleid%3A${oracleId}&unique=prints`);
        if (!printsResp.ok) return res.json({ prints: [buildPrint(namedCard)] });
        const printsData = await printsResp.json();

        const prints = (printsData.data || []).map(buildPrint);
        res.json({ prints });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

function buildPrint(card) {
    let image_url = null;
    if (card.image_uris) {
        image_url = card.image_uris.png || card.image_uris.large || card.image_uris.normal;
    } else if (card.card_faces && card.card_faces[0] && card.card_faces[0].image_uris) {
        image_url = card.card_faces[0].image_uris.png || card.card_faces[0].image_uris.large || card.card_faces[0].image_uris.normal;
    }
    let back_image_url = null;
    if (card.card_faces && card.card_faces[1] && card.card_faces[1].image_uris) {
        back_image_url = card.card_faces[1].image_uris.png || card.card_faces[1].image_uris.large || card.card_faces[1].image_uris.normal;
    }
    return {
        id: card.id,
        name: card.name,
        set_name: card.set_name || '',
        set: card.set || '',
        collector_number: card.collector_number || '',
        rarity: card.rarity || '',
        artist: card.artist || '',
        image_url,
        back_image_url,
        mana_cost: card.mana_cost || (card.card_faces ? card.card_faces[0].mana_cost : null) || null,
        cmc: card.cmc ?? null,
        type_line: card.type_line || null,
        oracle_text: card.oracle_text || (card.card_faces ? card.card_faces[0].oracle_text : null) || null,
        colors: card.colors || (card.card_faces ? card.card_faces[0].colors : null) || [],
        color_identity: card.color_identity || [],
        keywords: card.keywords || [],
        power: card.power || (card.card_faces ? card.card_faces[0].power : null) || null,
        toughness: card.toughness || (card.card_faces ? card.card_faces[0].toughness : null) || null,
        is_dfc: !!(card.card_faces && card.card_faces.length > 1 && card.card_faces[1].image_uris)
    };
}

// Proxy Scryfall card image â†’ base64
app.get('/api/scryfall/image', async (req, res) => {
    const url = req.query.url;
    if (!url || !url.startsWith('https://cards.scryfall.io/')) {
        return res.status(400).json({ error: 'Invalid image URL' });
    }
    try {
        const imgResp = await fetch(url);
        if (!imgResp.ok) return res.status(404).json({ error: 'Image not found' });
        const buffer = Buffer.from(await imgResp.arrayBuffer());
        const contentType = imgResp.headers.get('content-type') || 'image/png';
        const b64 = `data:${contentType};base64,${buffer.toString('base64')}`;
        res.json({ image: b64 });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
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
//  PART 2: ARENA GAME SERVER (Room-Based)
// ============================================================================

// --- CONSTANTS FOR GUEST NAMES ---
const ADJECTIVES = ["Abrasive", "Abrupt", "Acidic", "Active", "Aggressive", "Agile", "Alert", "Ancient", "Angry", "Animated", "Annoying", "Anxious", "Arrogant", "Ashamed", "Attractive", "Average", "Awful", "Beautiful", "Celestial", "Best", "Better", "Bewildered", "Big", "Bitter", "Black", "Bland", "Blue", "Boiling", "Bold", "Boring", "Brave", "Bright", "Broad", "Broken", "Bumpy", "Busy", "Calm", "Careful", "Charming", "Cheap", "Cheerful", "Chubby", "Clean", "Clever", "Clumsy", "Cold", "Colorful", "Colossal", "Combative", "Common", "Complete", "Confused", "Cooperative", "Courageous", "Crazy", "Creepy", "Cruel", "Curious", "Cute", "Dangerous", "Dark", "Dead", "Deafening", "Deep", "Defeated", "Delicate", "Delicious", "Determined", "Different", "Difficult", "Dirty", "Disgusting", "Distinct", "Disturbed", "Dizzy", "Drab", "Dry", "Dull", "Dusty", "Eager", "Early", "Easy", "Elegant", "Embarrassed", "Empty", "Enchanted", "Energetic", "Enormous", "Enthusiastic", "Envious", "Evil", "Excited", "Expensive", "Faint", "Fair", "Faithful", "Famous", "Fancy", "Fantastic", "Fast", "Fat", "Fearful", "Fearless", "Ferocious", "Filthy", "Fine", "Flat", "Fluffy", "Foolish", "Fragile", "Frail", "Frantic", "Free", "Fresh", "Friendly", "Frightened", "Funny", "Fuzzy", "Gentle", "Giant", "Gifted", "Gigantic", "Glamorous", "Gleaming", "Glorious", "Good", "Gorgeous", "Graceful", "Great", "Greedy", "Green", "Grieving", "Grim", "Grotesque", "Grumpy", "Handsome", "Happy", "Hard", "Harsh", "Healthy", "Heavy", "Helpful", "Helpless", "High", "Hilarious", "Hollow", "Homeless", "Honest", "Horrible", "Hot", "Huge", "Hungry", "Hurt", "Icy", "Ideal", "Ill", "Immense", "Important", "Impossible", "Innocent", "Inquisitive", "Insane", "Intelligent", "Intense", "Interesting", "Irritating", "Itchy", "Jealous", "Jittery", "Jolly", "Joyous", "Juicy", "Kind", "Large", "Late", "Lazy", "Light", "Little", "Lonely", "Long", "Loose", "Loud", "Lovely", "Lucky", "Mad", "Magnificent", "Massive", "Mean", "Melodic", "Melted", "Messy", "Mighty", "Miniature", "Modern", "Motionless", "Muddy", "Mushy", "Mysterious", "Nasty", "Naughty", "Nervous", "New", "Nice", "Noisy", "Nutty", "Obedient", "Obnoxious", "Odd", "Old", "Open", "Orange", "Ordinary", "Outrageous", "Outstanding", "Pale", "Panicky", "Perfect", "Plain", "Pleasant", "Poised", "Poor", "Powerful", "Precious", "Prickly", "Proud", "Purple", "Putrid", "Quaint", "Quick", "Quiet", "Rapid", "Rare", "Real", "Red", "Rich", "Right", "Ripe", "Robust", "Rotten", "Rough", "Round", "Royal", "Rude", "Sad", "Safe", "Salty", "Scary", "Secret", "Selfish", "Serious", "Sharp", "Shiny", "Shocking", "Short", "Shy", "Silly", "Simple", "Skinny", "Sleepy", "Slim", "Slow", "Small", "Smart", "Smooth", "Soft", "Solid", "Sore", "Sour", "Sparkling", "Spicy", "Splendid", "Spotless", "Square", "Steady", "Steep", "Sticky", "Stormy", "Straight", "Strange", "Strong", "Stupid", "Successful", "Sweet", "Swift", "Tall", "Tame", "Tasty", "Tender", "Tense", "Terrible", "Thick", "Thin", "Thirsty", "Thoughtful", "Tight", "Tiny", "Tired", "Tough", "Troubled", "Ugly", "Uninterested", "Unsightly", "Unusual", "Upset", "Uptight", "Vast", "Victorious", "Vivacious", "Wandering", "Warm", "Weak", "Wealthy", "Weary", "Wet", "Whispering", "White", "Wicked", "Wide", "Wild", "Wise", "Witty", "Wonderful", "Worried", "Wrong", "Yellow", "Young", "Zany", "Zealous"];
const NOUNS = ["Acacia", "Acanthus", "Acorn Squash", "Agapanthus", "Alfalfa", "Allium", "Almond", "Aloe Vera", "Amaranth", "Amaryllis", "Anemone", "Angelica", "Anise", "Apple", "Apricot", "Artichoke", "Arugula", "Asparagus", "Aster", "Aubergine", "Avocado", "Azalea", "Bamboo", "Banana", "Basil", "Bean", "Beet", "Begonia", "Bell Pepper", "Bergamot", "Bilberry", "Blackberry", "Bluebell", "Blueberry", "Bok Choy", "Broccoli", "Buttercup", "Cabbage", "Cactus", "Calendula", "Camellia", "Cantaloupe", "Carnation", "Carrot", "Cauliflower", "Celery", "Chamomile", "Chard", "Cherry", "Chestnut", "Chickpea", "Chili Pepper", "Chrysanthemum", "Cilantro", "Clementine", "Clover", "Coconut", "Corn", "Cornflower", "Cosmos", "Cranberry", "Crocus", "Cucumber", "Currant", "Cyclamen", "Daffodil", "Dahlia", "Daisy", "Dandelion", "Date", "Daylily", "Delphinium", "Dill", "Dragon Fruit", "Elderberry", "Fennel", "Fern", "Fig", "Foxglove", "Freesia", "Fuchsia", "Gardenia", "Garlic", "Geranium", "Ginger", "Gladiolus", "Goldenrod", "Gooseberry", "Grape", "Grapefruit", "Guava", "Hazelnut", "Heather", "Hibiscus", "Holly", "Honeydew", "Honeysuckle", "Hops", "Hyacinth", "Hydrangea", "Iris", "Ivy", "Jasmine", "Juniper", "Kale", "Kiwi", "Kumquat", "Lavender", "Leek", "Lemon", "Lettuce", "Lilac", "Lily", "Lime", "Lotus", "Lychee", "Magnolia", "Mango", "Marigold", "Melon", "Mint", "Mushroom", "Narcissus", "Nasturtium", "Nectarine", "Nutmeg", "Oak", "Olive", "Onion", "Orange", "Orchid", "Oregano", "Pansy", "Papaya", "Parsley", "Peach", "Pear", "Peony", "Pepper", "Peppermint", "Persimmon", "Petunia", "Pine", "Pineapple", "Pistachio", "Plum", "Pomegranate", "Poppy", "Potato", "Pumpkin", "Radish", "Raspberry", "Rose", "Rosemary", "Sage", "Snapdragon", "Snowdrop", "Spinach", "Squash", "Starfruit", "Strawberry", "Sunflower", "Tangerine", "Tea", "Thistle", "Thyme", "Tomato", "Tulip", "Turnip", "Violet", "Walnut", "Watermelon", "Wheat", "Wisteria", "Yam", "Yarrow", "Zinnia", "Zucchini", "Basilisk", "Behemoth", "Centaur", "Cerberus", "Chimera", "Cyclops", "Dragon", "Drake", "Dryad", "Dwarf", "Elf", "Gargoyle", "Ghost", "Ghoul", "Giant", "Goblin", "Golem", "Griffin", "Hydra", "Imp", "Kobold", "Kraken", "Lich", "Manticore", "Medusa", "Mimic", "Minotaur", "Nymph", "Ogre", "Orc", "Owlbear", "Pegasus", "Phoenix", "Satyr", "Skeleton", "Sphinx", "Spirit", "Sprite", "Treant", "Troll", "Unicorn", "Vampire", "Werewolf", "Wraith", "Wyvern", "Yeti", "Zombie"];

// --- ROOM STATE ---
const rooms = new Map();       // roomCode â†’ Room object
const socketToRoom = {};       // socketId â†’ roomCode

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 to avoid confusion
    let code;
    do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
    while (rooms.has(code));
    return code;
}

function generateGuestName() {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    return `${adj} ${noun}`;
}

function createRoom(name, hostSocketId, settings = {}) {
    const code = generateRoomCode();
    const room = {
        code,
        name: name || 'Commander Game',
        hostSocketId,
        settings: {
            gameType: settings.gameType || 'commander',
            maxPlayers: Math.min(4, Math.max(2, settings.maxPlayers || 4)),
            brackets: settings.brackets || [1, 2, 3, 4, 5],
            visibility: settings.visibility || 'public',
            password: settings.password || null,
            allowSpectators: settings.allowSpectators !== false,
            spectatorQueue: settings.spectatorQueue || false,
        },
        phase: 'lobby',
        gameState: { players: [], active: false, isDayTime: true },
        socketOwner: {},
        spectators: [],
        queue: [],
        globalImageCache: {},
        gameLog: [],
        chatLog: [],
        cardOrdering: 'smart',
        locked: false,
        debounceTimers: {
            life: {}, poison: {}, energy: {}, cardCounter: {}, cmdDamage: {}
        }
    };
    rooms.set(code, room);
    return room;
}

function getRoom(socket) {
    const code = socketToRoom[socket.id];
    return code ? rooms.get(code) : null;
}

function isAttachableCard(card) {
    const m = card.meta;
    if (!m) return card.isToken && card.name && card.name.toLowerCase().includes('copy') && !card.name.includes('(Copy)');
    const typeLine = (m.type_line || '').toLowerCase();
    const keywords = (m.keywords || []).map(k => k.toLowerCase());
    if (keywords.includes('reconfigure')) return true;
    if (typeLine.includes('equipment')) return true;
    if (typeLine.includes('aura')) return true;
    if (card.isToken && card.name && card.name.toLowerCase().includes('copy') && !card.name.includes('(Copy)')) return true;
    return false;
}

// --- Room-scoped helpers ---
const DEBOUNCE_MS = 1800;

function addLogEntry(room, entry) {
    entry.time = Date.now();
    room.gameLog.push(entry);
    io.to(room.code).emit('gameLog', entry);
}

function getPlayerName(room, pid) {
    const p = room.gameState.players.find(x => x.id === pid);
    return p ? p.name : pid;
}

function makeData(room, c, ownerId, isToken = false) {
    const uid = Math.random().toString(36).substr(2, 9);
    room.globalImageCache[uid] = { front: c.image || null, back: c.backImage || null };
    return {
        ...c, uid, owner: ownerId,
        image: null, backImage: null,
        rotation: 0, transformed: false, isToken, counters: [],
        x: 0.5, y: 0.5
    };
}

function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
}

function broadcastState(room) {
    io.in(room.code).fetchSockets().then(sockets => {
        for (const socket of sockets) {
            const myPid = room.socketOwner[socket.id];
            const isSpectator = room.spectators.includes(socket.id);

            const secretPlayers = room.gameState.players.map(p => {
                if (p.id !== myPid || isSpectator) {
                    return {
                        ...p,
                        hand: p.hand.map(c => ({
                            uid: c.uid, owner: c.owner, isUnknown: true,
                            counters: c.counters
                        })),
                        library: p.library.map(() => ({ uid: 'hidden' }))
                    };
                }
                return p;
            });

            socket.emit('stateUpdate', {
                players: secretPlayers,
                active: room.gameState.active,
                isDayTime: room.gameState.isDayTime
            });
        }
    });
}

function broadcastRoomInfo(room) {
    const info = getRoomInfo(room);
    io.to(room.code).emit('roomUpdate', info);
}

function getRoomInfo(room) {
    const players = room.gameState.players.map(p => ({ id: p.id, name: p.name }));
    const hostPid = room.socketOwner[room.hostSocketId] || null;
    return {
        code: room.code,
        name: room.name,
        hostSocketId: room.hostSocketId,
        hostPid,
        settings: room.settings,
        phase: room.phase,
        locked: room.locked,
        playerCount: room.gameState.players.length,
        spectatorCount: room.spectators.length,
        players,
        spectators: room.spectators.length,
        queueCount: room.queue.length,
    };
}

function destroyRoom(code) {
    const room = rooms.get(code);
    if (!room) return;
    // Clear all debounce timers
    for (const map of Object.values(room.debounceTimers)) {
        for (const key of Object.keys(map)) {
            if (map[key] && map[key].timer) clearTimeout(map[key].timer);
            delete map[key];
        }
    }
    io.to(code).emit('roomClosed', { reason: 'Host disconnected' });
    // Remove all sockets from the Socket.IO room
    io.in(code).socketsLeave(code);
    // Clean up socketToRoom
    for (const [sid, rc] of Object.entries(socketToRoom)) {
        if (rc === code) delete socketToRoom[sid];
    }
    rooms.delete(code);
    console.log(`[Room Destroyed] ${code}`);
}

// --- Debounced logging (room-scoped) ---
function debouncedLifeLog(room, pid) {
    const p = room.gameState.players.find(x => x.id === pid);
    if (!p) return;
    const timers = room.debounceTimers.life;
    if (!timers[pid]) timers[pid] = { initial: p.life, timer: null };
    if (timers[pid].timer) clearTimeout(timers[pid].timer);
    timers[pid].timer = setTimeout(() => {
        const pNow = room.gameState.players.find(x => x.id === pid);
        if (!pNow) { delete timers[pid]; return; }
        const diff = pNow.life - timers[pid].initial;
        if (diff > 0) addLogEntry(room, { type: 'lifeGain', pid, playerName: getPlayerName(room, pid), amount: diff, from: timers[pid].initial, to: pNow.life });
        else if (diff < 0) addLogEntry(room, { type: 'lifeLoss', pid, playerName: getPlayerName(room, pid), amount: Math.abs(diff), from: timers[pid].initial, to: pNow.life });
        delete timers[pid];
    }, DEBOUNCE_MS);
}

function debouncedPoisonLog(room, pid) {
    const p = room.gameState.players.find(x => x.id === pid);
    if (!p) return;
    const timers = room.debounceTimers.poison;
    if (!timers[pid]) timers[pid] = { initial: p.poison, timer: null };
    if (timers[pid].timer) clearTimeout(timers[pid].timer);
    timers[pid].timer = setTimeout(() => {
        const pNow = room.gameState.players.find(x => x.id === pid);
        if (!pNow) { delete timers[pid]; return; }
        const diff = pNow.poison - timers[pid].initial;
        if (diff !== 0) addLogEntry(room, { type: 'poison', pid, playerName: getPlayerName(room, pid), amount: Math.abs(diff), from: timers[pid].initial, to: pNow.poison, gained: diff > 0 });
        delete timers[pid];
    }, DEBOUNCE_MS);
}

function debouncedEnergyLog(room, pid) {
    const p = room.gameState.players.find(x => x.id === pid);
    if (!p) return;
    const timers = room.debounceTimers.energy;
    if (!timers[pid]) timers[pid] = { initial: p.energy, timer: null };
    if (timers[pid].timer) clearTimeout(timers[pid].timer);
    timers[pid].timer = setTimeout(() => {
        const pNow = room.gameState.players.find(x => x.id === pid);
        if (!pNow) { delete timers[pid]; return; }
        const diff = pNow.energy - timers[pid].initial;
        if (diff !== 0) addLogEntry(room, { type: 'energy', pid, playerName: getPlayerName(room, pid), amount: Math.abs(diff), from: timers[pid].initial, to: pNow.energy, gained: diff > 0 });
        delete timers[pid];
    }, DEBOUNCE_MS);
}

function debouncedCardCounterLog(room, pid, uid, cardName) {
    const key = `${pid}_${uid}`;
    const p = room.gameState.players.find(x => x.id === pid);
    if (!p) return;
    const allZones = ['battlefield', 'command', 'hand', 'library', 'graveyard', 'exile'];
    let card = null;
    for (const z of allZones) { card = (p[z] || []).find(c => c.uid === uid); if (card) break; }
    if (!card) return;
    const qtyFilter = c => /^.+:-?\d+$/.test(c);
    const timers = room.debounceTimers.cardCounter;
    if (!timers[key]) timers[key] = { initial: JSON.stringify((card.counters || []).filter(qtyFilter)), timer: null, cardName };
    if (timers[key].timer) clearTimeout(timers[key].timer);
    timers[key].timer = setTimeout(() => {
        const pNow = room.gameState.players.find(x => x.id === pid);
        let cardNow = null;
        if (pNow) { for (const z of allZones) { cardNow = (pNow[z] || []).find(c => c.uid === uid); if (cardNow) break; } }
        const currentQty = (cardNow ? (cardNow.counters || []) : []).filter(qtyFilter);
        const currentStr = JSON.stringify(currentQty);
        if (timers[key].initial !== currentStr && currentQty.length > 0) {
            addLogEntry(room, { type: 'counterChange', pid, playerName: getPlayerName(room, pid), cardName: timers[key].cardName, counters: currentQty.join(', ') });
        }
        delete timers[key];
    }, DEBOUNCE_MS);
}

function debouncedCmdDamageLog(room, pid, cmdUid, cmdName) {
    const key = `${pid}_${cmdUid}`;
    const p = room.gameState.players.find(x => x.id === pid);
    if (!p) return;
    const currentDmg = p.cmdDamage[cmdUid] ? p.cmdDamage[cmdUid].damage : 0;
    const timers = room.debounceTimers.cmdDamage;
    if (!timers[key]) timers[key] = { initial: currentDmg, initialLife: p.life, timer: null, cmdName };
    if (timers[key].timer) clearTimeout(timers[key].timer);
    timers[key].timer = setTimeout(() => {
        const pNow = room.gameState.players.find(x => x.id === pid);
        if (!pNow) { delete timers[key]; return; }
        const nowDmg = pNow.cmdDamage[cmdUid] ? pNow.cmdDamage[cmdUid].damage : 0;
        const diff = nowDmg - timers[key].initial;
        if (diff !== 0) {
            addLogEntry(room, { type: 'cmdDamage', pid, playerName: getPlayerName(room, pid), cmdName: timers[key].cmdName, amount: Math.abs(diff), from: timers[key].initial, to: nowDmg, gained: diff > 0, lifeBefore: timers[key].initialLife, life: pNow.life });
        }
        delete timers[key];
    }, DEBOUNCE_MS);
}

function doMoveCard(room, fromPid, fromZone, toPid, toZone, uid, x = 0.5, y = 0.5, method = 'top', index = -1) {
    if (toZone === 'tokens') return;
    const srcP = room.gameState.players.find(p => p.id === fromPid);
    const tgtP = room.gameState.players.find(p => p.id === toPid);
    if (!srcP || !tgtP) return;

    const srcList = srcP[fromZone];
    const tgtList = tgtP[toZone];
    const card = uid ? srcList.find(c => c.uid === uid) : srcList[0];
    if (!card) return;

    const idx = srcList.indexOf(card);
    if (idx > -1) srcList.splice(idx, 1);

    if (toZone === 'battlefield') { card.x = x; card.y = y; }
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
        } else if (toZone === 'battlefield' && room.cardOrdering === 'bottom') {
            tgtList.unshift(card);
        } else if (toZone === 'battlefield' && room.cardOrdering === 'smart') {
            isAttachableCard(card) ? tgtList.unshift(card) : tgtList.push(card);
        } else {
            tgtList.push(card);
        }
    }
}

// === SOCKET CONNECTION ===
io.on('connection', (socket) => {
    console.log(`[Connect] ${socket.id}`);

    // --- ROOM MANAGEMENT ---

    socket.on('createRoom', ({ name, settings }, callback) => {
        const room = createRoom(name, socket.id, settings);
        socketToRoom[socket.id] = room.code;
        socket.join(room.code);
        console.log(`[Room Created] ${room.code} by ${socket.id} â€” "${room.name}"`);
        if (callback) callback({ ok: true, code: room.code, room: getRoomInfo(room) });
        // Broadcast updated room list to everyone in lobby
        io.emit('roomListUpdate', getPublicRoomList());
    });

    socket.on('listRooms', (_, callback) => {
        if (callback) callback(getPublicRoomList());
    });

    socket.on('joinRoom', ({ code, password, asSpectator }, callback) => {
        const room = rooms.get(code);
        if (!room) { if (callback) callback({ ok: false, error: 'Room not found' }); return; }
        if (room.locked && socket.id !== room.hostSocketId) { if (callback) callback({ ok: false, error: 'Room is locked' }); return; }
        if (room.settings.visibility === 'password' && room.settings.password && password !== room.settings.password) {
            if (callback) callback({ ok: false, error: 'Incorrect password' }); return;
        }

        // Leave any current room first
        const currentRoom = socketToRoom[socket.id];
        if (currentRoom) leaveCurrentRoom(socket);

        socketToRoom[socket.id] = room.code;
        socket.join(room.code);

        if (asSpectator || (room.phase === 'playing' && !room.socketOwner[socket.id])) {
            // Join as spectator
            if (!room.settings.allowSpectators && socket.id !== room.hostSocketId) {
                if (callback) callback({ ok: false, error: 'Spectators not allowed' }); return;
            }
            room.spectators.push(socket.id);
            console.log(`[Spectator Joined] ${socket.id} â†’ ${room.code}`);
            socket.emit('updateImageCache', room.globalImageCache);
            socket.emit('gameLogFull', room.gameLog);
            if (room.phase === 'playing') broadcastState(room);
        }

        broadcastRoomInfo(room);
        if (callback) callback({ ok: true, room: getRoomInfo(room), phase: room.phase });
        io.emit('roomListUpdate', getPublicRoomList());
    });

    socket.on('leaveRoom', () => {
        leaveCurrentRoom(socket);
    });

    socket.on('startGame', () => {
        const room = getRoom(socket);
        if (!room || socket.id !== room.hostSocketId) return;
        if (room.phase !== 'lobby') return;
        room.phase = 'playing';
        broadcastRoomInfo(room);
        io.emit('roomListUpdate', getPublicRoomList());
        console.log(`[Game Started] ${room.code}`);
    });

    // --- HOST CONTROLS ---
    socket.on('kickPlayer', ({ targetPid }) => {
        const room = getRoom(socket);
        if (!room || socket.id !== room.hostSocketId) return;
        // Find the socket for targetPid
        const targetSid = Object.entries(room.socketOwner).find(([, pid]) => pid === targetPid)?.[0];
        if (!targetSid) return;
        const targetSocket = io.sockets.sockets.get(targetSid);
        if (targetSocket) {
            targetSocket.emit('kicked', { reason: 'You were kicked by the host' });
            leaveCurrentRoom(targetSocket);
        }
    });

    socket.on('lockRoom', () => {
        const room = getRoom(socket);
        if (!room || socket.id !== room.hostSocketId) return;
        room.locked = true;
        broadcastRoomInfo(room);
    });

    socket.on('unlockRoom', () => {
        const room = getRoom(socket);
        if (!room || socket.id !== room.hostSocketId) return;
        room.locked = false;
        broadcastRoomInfo(room);
    });

    socket.on('transferHost', ({ targetSocketId }) => {
        const room = getRoom(socket);
        if (!room || socket.id !== room.hostSocketId) return;
        if (socketToRoom[targetSocketId] !== room.code) return;
        room.hostSocketId = targetSocketId;
        console.log(`[Host Transfer] ${room.code} â†’ ${targetSocketId}`);
        broadcastRoomInfo(room);
    });

    // --- CHAT ---
    socket.on('chatMessage', ({ text }) => {
        const room = getRoom(socket);
        if (!room) return;
        const pid = room.socketOwner[socket.id];
        const isSpectator = room.spectators.includes(socket.id);
        const name = pid ? getPlayerName(room, pid) : (isSpectator ? 'Spectator' : 'Unknown');
        const msg = { sender: name, text: text.substring(0, 500), time: Date.now(), isSpectator };
        room.chatLog.push(msg);
        io.to(room.code).emit('chatMessage', msg);
    });

    // --- GAME EVENTS (room-scoped) ---

    socket.on('registerPlayer', ({ deckData, displayName }) => {
        const room = getRoom(socket);
        if (!room) return;
        if (room.phase !== 'lobby' && room.phase !== 'playing') return;

        // Remove from spectators if joining as player
        room.spectators = room.spectators.filter(s => s !== socket.id);

        const slots = Array.from({ length: room.settings.maxPlayers }, (_, i) => `P${i + 1}`);
        const takenSeats = Object.values(room.socketOwner);
        const assignedPid = slots.find(slot => !takenSeats.includes(slot));

        if (!assignedPid) {
            socket.emit('joinError', `Game is full (${room.settings.maxPlayers}/${room.settings.maxPlayers} players)!`);
            return;
        }

        const pid = assignedPid;
        socket.emit('playerAssigned', { pid });
        room.socketOwner[socket.id] = pid;

        const existing = room.gameState.players.find(p => p.id === pid);

        let finalName = displayName;
        if (!finalName || finalName.trim() === "") finalName = generateGuestName();
        else if (deckData.deckName && !displayName) finalName = deckData.deckName;

        if (!existing) {
            const library = deckData.library.map(c => makeData(room, c, pid));
            const command = deckData.command.map(c => makeData(room, c, pid));
            const commanders = command.map(c => ({ uid: c.uid, name: c.name || 'Commander', _cacheId: c._cacheId || c.uid }));

            const tokens = (deckData.tokens || []).map(t => {
                const tUid = Math.random().toString(36).substr(2, 9);
                room.globalImageCache[tUid] = { front: t.image, back: t.backImage };
                return { ...t, id: tUid, uid: tUid, _cacheId: tUid, image: null, backImage: null };
            });

            shuffle(library);

            room.gameState.players.push({
                id: pid, name: finalName, life: 40,
                poison: 0, energy: 0, isMonarch: false,
                cmdDamage: {},
                commanders, library, command, tokens,
                hand: [], graveyard: [], exile: [], battlefield: []
            });

            const p = room.gameState.players.find(x => x.id === pid);
            for (let i = 0; i < 7; i++) if (p.library.length) doMoveCard(room, pid, 'library', pid, 'hand');

            io.to(room.code).emit('updateImageCache', room.globalImageCache);

            if (deckData.cardBack) {
                room.globalImageCache['__cardBack_' + pid] = { front: deckData.cardBack, back: null };
                io.to(room.code).emit('updateImageCache', { ['__cardBack_' + pid]: room.globalImageCache['__cardBack_' + pid] });
            }
        } else {
            existing.name = finalName;
        }
        addLogEntry(room, { type: 'playerJoin', pid, playerName: finalName });
        broadcastState(room);
        broadcastRoomInfo(room);
        io.emit('roomListUpdate', getPublicRoomList());
    });

    socket.on('spawnToken', ({ pid, templateId, x, y }) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.gameState.players.find(x => x.id === pid);
        if (!p) return;
        const template = p.tokens.find(t => t.id === templateId);
        if (template) {
            const cacheData = room.globalImageCache[template._cacheId];
            const token = makeData(room, {
                ...template,
                image: cacheData ? cacheData.front : null,
                backImage: cacheData ? cacheData.back : null
            }, pid, true);
            token.x = x; token.y = y;
            if (room.cardOrdering === 'bottom' || (room.cardOrdering === 'smart' && isAttachableCard(token))) {
                p.battlefield.unshift(token);
            } else {
                p.battlefield.push(token);
            }
            addLogEntry(room, { type: 'tokenSpawn', pid, playerName: getPlayerName(room, pid), tokenName: template.name || 'Token' });
            io.to(room.code).emit('updateImageCache', room.globalImageCache);
            broadcastState(room);
        }
    });

    socket.on('untapAll', ({ pid }) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.gameState.players.find(x => x.id === pid);
        if (!p) return;
        p.battlefield.forEach(c => {
            const norm = ((c.rotation || 0) % 360 + 360) % 360;
            if (norm === 90 || norm === 270) c.rotation = 0;
        });
        addLogEntry(room, { type: 'untapAll', pid, playerName: getPlayerName(room, pid) });
        broadcastState(room);
    });

    socket.on('disconnect', () => {
        console.log(`[Disconnect] ${socket.id}`);
        const code = socketToRoom[socket.id];
        const room = code ? rooms.get(code) : null;

        if (room) {
            const pid = room.socketOwner[socket.id];
            delete room.socketOwner[socket.id];
            room.spectators = room.spectators.filter(s => s !== socket.id);
            room.queue = room.queue.filter(s => s !== socket.id);

            if (pid) {
                const pIdx = room.gameState.players.findIndex(p => p.id === pid);
                if (pIdx > -1) {
                    const player = room.gameState.players[pIdx];
                    addLogEntry(room, { type: 'playerLeave', pid, playerName: player.name });
                    const allCards = [...player.library, ...player.hand, ...player.battlefield, ...player.graveyard, ...player.exile, ...player.command];
                    allCards.forEach(c => { if (c.uid) delete room.globalImageCache[c.uid]; });
                    (player.tokens || []).forEach(t => { if (t._cacheId) delete room.globalImageCache[t._cacheId]; });
                    room.gameState.players.splice(pIdx, 1);
                    console.log(`[Freed Seat] ${pid} in ${room.code} â€” ${room.gameState.players.length}/${room.settings.maxPlayers} players remain`);
                }
            }

            // Host disconnected â†’ destroy room
            if (socket.id === room.hostSocketId) {
                destroyRoom(room.code);
            } else {
                broadcastState(room);
                broadcastRoomInfo(room);
            }
        }

        delete socketToRoom[socket.id];
        io.emit('roomListUpdate', getPublicRoomList());
    });

    socket.on('resetGame', () => {
        const room = getRoom(socket);
        if (!room || socket.id !== room.hostSocketId) return;
        room.gameState = { players: [], active: false, isDayTime: true };
        room.socketOwner = {};
        // Keep host in socketOwner
        room.socketOwner[socket.id] = undefined; // Will re-register
        room.globalImageCache = {};
        room.gameLog = [];
        room.phase = 'lobby';
        // Clear debounce timers
        for (const map of Object.values(room.debounceTimers)) {
            for (const key of Object.keys(map)) {
                if (map[key] && map[key].timer) clearTimeout(map[key].timer);
                delete map[key];
            }
        }
        // Reset socketOwner properly â€” remove all pid mappings
        for (const sid of Object.keys(room.socketOwner)) {
            delete room.socketOwner[sid];
        }
        io.to(room.code).emit('updateImageCache', {});
        io.to(room.code).emit('resetClient');
        broadcastState(room);
        broadcastRoomInfo(room);
        io.emit('roomListUpdate', getPublicRoomList());
    });

    socket.on('moveCard', (payload) => {
        const room = getRoom(socket);
        if (!room) return;
        const { fromPid, fromZone, toPid, toZone, uid, x, y, method, index } = payload;
        const srcP = room.gameState.players.find(p => p.id === fromPid);
        const card = srcP ? (uid ? srcP[fromZone].find(c => c.uid === uid) : srcP[fromZone][0]) : null;
        const cardName = card ? (card.name || 'Unknown') : 'Unknown';
        doMoveCard(room, fromPid, fromZone, toPid, toZone, uid, x, y, method, index);
        if (fromZone === toZone && fromPid === toPid) { broadcastState(room); return; }
        let dest = toZone;
        if (toZone === 'library') {
            const methodLabel = { top: 'Top', bottom: 'Bottom', shuffle: 'Shuffle' };
            dest = `Library, ${methodLabel[method] || 'Top'}`;
        }
        addLogEntry(room, {
            type: 'move', cardName, fromZone, toZone, fromPid, toPid, method, dest,
            fromPlayerName: getPlayerName(room, fromPid), toPlayerName: getPlayerName(room, toPid)
        });
        broadcastState(room);
    });

    socket.on('reorderZone', ({ pid, zone, uid, targetUid }) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.gameState.players.find(x => x.id === pid);
        if (!p) return;
        const list = p[zone];
        const oldIdx = list.findIndex(c => c.uid === uid);
        const newIdx = list.findIndex(c => c.uid === targetUid);
        if (oldIdx > -1 && newIdx > -1) {
            const [item] = list.splice(oldIdx, 1);
            list.splice(newIdx, 0, item);
            if (zone === 'library') addLogEntry(room, { type: 'reorder', pid, zone, playerName: getPlayerName(room, pid) });
            broadcastState(room);
        }
    });

    socket.on('modLife', ({ pid, amt }) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.gameState.players.find(x => x.id === pid);
        if (!p) return;
        if (!room.debounceTimers.life[pid]) room.debounceTimers.life[pid] = { initial: p.life, timer: null };
        p.life += amt;
        debouncedLifeLog(room, pid);
        broadcastState(room);
    });

    socket.on('setLife', ({ pid, value }) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.gameState.players.find(x => x.id === pid);
        if (!p) return;
        if (!room.debounceTimers.life[pid]) room.debounceTimers.life[pid] = { initial: p.life, timer: null };
        p.life = value;
        debouncedLifeLog(room, pid);
        broadcastState(room);
    });

    socket.on('modPoison', ({ pid, amt }) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.gameState.players.find(x => x.id === pid);
        if (!p) return;
        if (!room.debounceTimers.poison[pid]) room.debounceTimers.poison[pid] = { initial: p.poison || 0, timer: null };
        p.poison = Math.max(0, (p.poison || 0) + amt);
        debouncedPoisonLog(room, pid);
        broadcastState(room);
    });

    socket.on('modEnergy', ({ pid, amt }) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.gameState.players.find(x => x.id === pid);
        if (!p) return;
        if (!room.debounceTimers.energy[pid]) room.debounceTimers.energy[pid] = { initial: p.energy || 0, timer: null };
        p.energy = Math.max(0, (p.energy || 0) + amt);
        debouncedEnergyLog(room, pid);
        broadcastState(room);
    });

    socket.on('setMonarch', ({ pid }) => {
        const room = getRoom(socket);
        if (!room) return;
        room.gameState.players.forEach(p => p.isMonarch = false);
        const p = room.gameState.players.find(x => x.id === pid);
        if (p) { p.isMonarch = true; addLogEntry(room, { type: 'monarch', pid, playerName: getPlayerName(room, pid) }); }
        broadcastState(room);
    });

    socket.on('removeMonarch', ({ pid }) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.gameState.players.find(x => x.id === pid);
        if (p) p.isMonarch = false;
        broadcastState(room);
    });

    socket.on('toggleDayNight', () => {
        const room = getRoom(socket);
        if (!room) return;
        room.gameState.isDayTime = !room.gameState.isDayTime;
        addLogEntry(room, { type: 'dayNight', isDayTime: room.gameState.isDayTime, playerName: getPlayerName(room, room.socketOwner[socket.id]) });
        broadcastState(room);
    });

    socket.on('modCmdDamage', ({ pid, cmdUid, cmdName, cmdOwner, amt }) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.gameState.players.find(x => x.id === pid);
        if (!p) return;
        if (!p.cmdDamage[cmdUid]) p.cmdDamage[cmdUid] = { uid: cmdUid, name: cmdName, owner: cmdOwner, damage: 0 };
        const key = `${pid}_${cmdUid}`;
        if (!room.debounceTimers.cmdDamage[key]) room.debounceTimers.cmdDamage[key] = { initial: p.cmdDamage[cmdUid].damage, initialLife: p.life, timer: null, cmdName };
        const oldDmg = p.cmdDamage[cmdUid].damage;
        p.cmdDamage[cmdUid].damage = Math.max(0, oldDmg + amt);
        const actualDmgChange = p.cmdDamage[cmdUid].damage - oldDmg;
        if (actualDmgChange !== 0) p.life -= actualDmgChange;
        debouncedCmdDamageLog(room, pid, cmdUid, cmdName);
        broadcastState(room);
    });

    socket.on('cardUpdate', ({ pid, zone, uid, updates }) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.gameState.players.find(x => x.id === pid);
        if (!p) return;
        const card = p[zone].find(c => c.uid === uid);
        if (!card) return;
        if (updates.counters) debouncedCardCounterLog(room, pid, uid, card.name || 'Unknown');
        if (updates.rotation !== undefined && updates.rotation !== card.rotation) {
            const normNew = ((updates.rotation % 360) + 360) % 360;
            if (normNew === 90 || normNew === 270) addLogEntry(room, { type: 'tap', pid, playerName: getPlayerName(room, pid), cardName: card.name || 'Unknown' });
        }
        Object.assign(card, updates);
        broadcastState(room);
    });

    socket.on('shuffle', ({ pid }) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.gameState.players.find(x => x.id === pid);
        if (p) shuffle(p.library);
        addLogEntry(room, { type: 'shuffle', pid, playerName: getPlayerName(room, pid) });
        broadcastState(room);
    });

    socket.on('logAssociation', ({ sourceName, targetName, sourceUid, targetUid, assocType }) => {
        const room = getRoom(socket);
        if (!room) return;
        const pid = room.socketOwner[socket.id];
        let message = '';
        if (assocType === 'equipment') message = `${sourceName} became attached to ${targetName}`;
        else if (assocType === 'aura') message = `${sourceName} enchanted ${targetName}`;
        else if (assocType === 'copyToken') {
            message = `Copied ${targetName}`;
            if (sourceUid && targetUid) {
                const p = room.gameState.players.find(x => x.id === pid);
                if (p) {
                    const allZones = ['battlefield', 'hand', 'command', 'graveyard', 'exile', 'library'];
                    let token = null;
                    for (const z of allZones) { token = (p[z] || []).find(c => c.uid === sourceUid); if (token) break; }
                    if (token) {
                        token.name = `${targetName} (Copy)`;
                        if (room.globalImageCache[targetUid]) {
                            room.globalImageCache[sourceUid] = { ...room.globalImageCache[targetUid] };
                            io.to(room.code).emit('updateImageCache', { [sourceUid]: room.globalImageCache[sourceUid] });
                        }
                    }
                }
            }
        } else if (assocType === 'reconfigure') message = `${sourceName} was reconfigured and attached to ${targetName}`;
        if (message) { addLogEntry(room, { type: 'association', pid, playerName: getPlayerName(room, pid), message }); broadcastState(room); }
    });

    socket.on('setCardOrdering', ({ ordering }) => {
        const room = getRoom(socket);
        if (!room) return;
        if (ordering === 'top' || ordering === 'bottom' || ordering === 'smart') room.cardOrdering = ordering;
    });

    socket.on('openInspect', ({ pid, zone }) => {
        const room = getRoom(socket);
        if (!room) return;
        const ownerPid = room.socketOwner[socket.id];
        addLogEntry(room, { type: 'inspect', pid: ownerPid || 'unknown', playerName: getPlayerName(room, ownerPid || 'unknown'), targetPid: pid, targetPlayerName: getPlayerName(room, pid), zone });
    });

    socket.on('deleteCard', ({ pid, zone, uid }) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.gameState.players.find(x => x.id === pid);
        if (p) {
            const idx = p[zone].findIndex(c => c.uid === uid);
            if (idx > -1) {
                const card = p[zone][idx];
                doMoveCard(room, pid, zone, card.owner, 'graveyard', uid);
                broadcastState(room);
            }
        }
    });
});

// --- Helper: leave current room ---
function leaveCurrentRoom(socket) {
    const code = socketToRoom[socket.id];
    const room = code ? rooms.get(code) : null;
    if (!room) return;

    const pid = room.socketOwner[socket.id];
    delete room.socketOwner[socket.id];
    room.spectators = room.spectators.filter(s => s !== socket.id);
    room.queue = room.queue.filter(s => s !== socket.id);

    if (pid) {
        const pIdx = room.gameState.players.findIndex(p => p.id === pid);
        if (pIdx > -1) {
            const player = room.gameState.players[pIdx];
            addLogEntry(room, { type: 'playerLeave', pid, playerName: player.name });
            const allCards = [...player.library, ...player.hand, ...player.battlefield, ...player.graveyard, ...player.exile, ...player.command];
            allCards.forEach(c => { if (c.uid) delete room.globalImageCache[c.uid]; });
            (player.tokens || []).forEach(t => { if (t._cacheId) delete room.globalImageCache[t._cacheId]; });
            room.gameState.players.splice(pIdx, 1);
        }
    }

    socket.leave(code);
    delete socketToRoom[socket.id];

    if (socket.id === room.hostSocketId) {
        destroyRoom(code);
    } else {
        broadcastState(room);
        broadcastRoomInfo(room);
    }
    io.emit('roomListUpdate', getPublicRoomList());
}

// --- Helper: get public room list ---
function getPublicRoomList() {
    const list = [];
    for (const [, room] of rooms) {
        if (room.settings.visibility === 'private') continue;
        list.push({
            code: room.code,
            name: room.name,
            playerCount: room.gameState.players.length,
            maxPlayers: room.settings.maxPlayers,
            spectatorCount: room.spectators.length,
            phase: room.phase,
            gameType: room.settings.gameType,
            brackets: room.settings.brackets,
            hasPassword: room.settings.visibility === 'password',
            locked: room.locked,
        });
    }
    return list;
}

// ============================================================================
//  PART 3: CLOUDFLARE TUNNEL
// ============================================================================

let tunnelState = { active: false, url: null, error: null };
let tunnelProcess = null;

function startTunnel() {
    if (tunnelProcess) return;

    tunnelState = { active: false, url: null, error: null };
    tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    tunnelProcess.stderr.on('data', (chunk) => {
        output += chunk.toString();
        const m = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (m && !tunnelState.active) {
            tunnelState = { active: true, url: m[0], error: null };
            console.log(`[Tunnel] ${tunnelState.url}`);
        }
    });

    tunnelProcess.on('error', () => {
        tunnelState = { active: false, url: null, error: 'cloudflared not found. Is it installed?' };
        tunnelProcess = null;
    });

    tunnelProcess.on('close', () => {
        tunnelState = { active: false, url: null, error: null };
        tunnelProcess = null;
    });
}

function stopTunnel() {
    if (tunnelProcess) { tunnelProcess.kill(); tunnelProcess = null; }
    tunnelState = { active: false, url: null, error: null };
}

app.get('/api/tunnel/status', (_req, res) => res.json(tunnelState));
app.post('/api/tunnel/start', (_req, res) => { startTunnel(); res.json({ ok: true }); });
app.post('/api/tunnel/stop', (_req, res) => { stopTunnel(); res.json({ ok: true }); });

process.on('exit', stopTunnel);
process.on('SIGINT', () => { stopTunnel(); process.exit(); });

// ============================================================================
//  START SERVER
// ============================================================================
const PORT = 2222;
http.listen(PORT, '0.0.0.0', () => console.log(`MTG Commander Arena running on http://localhost:${PORT}`));

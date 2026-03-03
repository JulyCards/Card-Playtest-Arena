/**
 * card-meta.js — Metadata import for MTG deck builder
 * Supports: Scryfall API lookup (real cards) + MTGSE XML import (custom cards)
 */

// ============================================================
//  MTGSE MANA COST CONVERTER
//  Converts compact MTGSE format ("1U", "2RG", "WUBRG", "XBB")
//  into space-separated tokens for normalizeManaCost()
// ============================================================

function convertMTGSECost(raw) {
    if (!raw || !raw.trim()) return '';
    const s = raw.trim().toUpperCase();
    const tokens = [];
    let i = 0;

    while (i < s.length) {
        const ch = s[i];

        // Collect consecutive digits as one generic token
        if (/\d/.test(ch)) {
            let num = '';
            while (i < s.length && /\d/.test(s[i])) { num += s[i]; i++; }
            tokens.push(num);
            continue;
        }

        // X, C, or color letters → individual tokens
        if ('WUBRGXCP'.includes(ch)) {
            // Check for hybrid: two colors separated by /
            if (i + 2 < s.length && s[i + 1] === '/') {
                tokens.push(s.substring(i, i + 3)); // e.g. "W/U"
                i += 3;
            } else {
                tokens.push(ch);
                i++;
            }
            continue;
        }

        // Skip unknown characters
        i++;
    }

    return tokens.join(' ');
}

// ============================================================
//  MTGSE RARITY CONVERTER
// ============================================================

const RARITY_MAP = {
    'C': 'common',
    'U': 'uncommon',
    'R': 'rare',
    'M': 'mythic',
    'S': 'special',
    'L': 'land'
};

function convertRarity(r) {
    if (!r) return null;
    return RARITY_MAP[r.trim().toUpperCase()] || r.trim().toLowerCase();
}

// ============================================================
//  MTGSE XML PARSER
// ============================================================

/**
 * Parse MTGSE XML string into array of card metadata objects.
 * @param {string} xmlString
 * @returns {{ setName: string, cards: Array<object> }}
 */
function parseMTGSEXml(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'text/xml');

    const spoiler = doc.querySelector('spoiler');
    const setName = spoiler ? (spoiler.getAttribute('set') || null) : null;

    const cardEls = doc.querySelectorAll('card');
    const cards = [];

    cardEls.forEach(cardEl => {
        const getText = (tag) => {
            const el = cardEl.querySelector(tag);
            return el ? (el.textContent || '').trim() : '';
        };

        const name = getText('name');
        if (!name) return; // skip unnamed cards

        // Build type line: "Supertype — Subtype"
        const supertype = getText('type > supertype');
        const subtype = getText('type > subtype').trim();
        let type_line = supertype || '';
        if (subtype) type_line += ' \u2014 ' + subtype;

        // Mana cost
        const rawCost = getText('cost');
        const spacedCost = convertMTGSECost(rawCost);

        // Rules text
        const oracle_text = getText('rules');

        // Stats
        const power = getText('stats > power') || null;
        const toughness = getText('stats > toughness') || null;

        // Rarity
        const rarity = convertRarity(getText('rarity'));

        cards.push({
            name,
            type_line: type_line || null,
            mana_cost_raw: spacedCost, // space-separated, ready for normalizeManaCost()
            oracle_text: oracle_text || null,
            power,
            toughness,
            rarity,
            set_name: setName,
            number: getText('number') || null
        });
    });

    return { setName, cards };
}

// ============================================================
//  NAME MATCHING
// ============================================================

/**
 * Match parsed XML/Scryfall cards to deck cards by name (case-insensitive).
 * @param {Array} metaCards — Array of { name, ...metadata }
 * @param {object} deck — { command: [...], library: [...], tokens: [...] }
 * @returns {{ matched: Array<{zone, idx, deckCard, metaCard}>, unmatched: Array }}
 */
function matchMetaToDeck(metaCards, deck) {
    const matched = [];
    const unmatched = [];

    // Build a lookup by lowercase name → metadata
    const metaByName = {};
    metaCards.forEach(mc => {
        const key = mc.name.toLowerCase().trim();
        if (!metaByName[key]) metaByName[key] = mc;
    });

    // Scan all deck zones
    ['command', 'library', 'tokens'].forEach(zone => {
        (deck[zone] || []).forEach((card, idx) => {
            const key = (card.name || '').toLowerCase().trim();
            if (metaByName[key]) {
                matched.push({ zone, idx, deckCard: card, metaCard: metaByName[key] });
            }
        });
    });

    // Find meta cards that didn't match any deck card
    const matchedNames = new Set(matched.map(m => m.metaCard.name.toLowerCase().trim()));
    metaCards.forEach(mc => {
        if (!matchedNames.has(mc.name.toLowerCase().trim())) {
            unmatched.push(mc);
        }
    });

    return { matched, unmatched };
}

// ============================================================
//  APPLY METADATA TO DECK
// ============================================================

/**
 * Apply matched metadata to deck cards.
 * Uses normalizeManaCost, parseColors, parseManaValue, sortColors from builder.
 * @param {object} deck
 * @param {Array} matches — from matchMetaToDeck().matched
 */
function applyMetaToDeck(deck, matches) {
    matches.forEach(({ zone, idx, metaCard }) => {
        const card = deck[zone][idx];
        if (!card.meta) card.meta = {};
        const m = card.meta;

        // Name
        if (metaCard.name) card.name = metaCard.name;

        // Type line
        if (metaCard.type_line) m.type_line = metaCard.type_line;

        // Oracle text
        if (metaCard.oracle_text) m.oracle_text = metaCard.oracle_text;

        // P/T
        if (metaCard.power) m.power = metaCard.power;
        if (metaCard.toughness) m.toughness = metaCard.toughness;

        // Rarity
        if (metaCard.rarity) m.rarity = metaCard.rarity;

        // Set name
        if (metaCard.set_name) m.set_name = metaCard.set_name;

        // Mana cost — normalize if raw format provided
        if (metaCard.mana_cost_raw && typeof normalizeManaCost === 'function') {
            const norm = normalizeManaCost(metaCard.mana_cost_raw);
            if (!norm.error) {
                m.mana_cost = norm.result;
                m.cmc = parseManaValue(m.mana_cost);
                m.colors = sortColors(parseColors(m.mana_cost));
                m.color_identity = [...m.colors];
            }
        } else if (metaCard.mana_cost) {
            // Already in {X}{U} format (from Scryfall)
            m.mana_cost = metaCard.mana_cost;
            m.cmc = metaCard.cmc ?? parseManaValue(m.mana_cost);
            m.colors = metaCard.colors ? sortColors([...metaCard.colors]) : sortColors(parseColors(m.mana_cost));
            m.color_identity = metaCard.color_identity ? sortColors([...metaCard.color_identity]) : [...m.colors];
        }

        // Keywords
        if (metaCard.keywords && metaCard.keywords.length > 0) {
            m.keywords = metaCard.keywords;
        }

        card._modified = Date.now();
    });
}

// ============================================================
//  SCRYFALL LOOKUP
// ============================================================

/**
 * Look up a single card by name via server proxy.
 * @param {string} cardName
 * @returns {object|null} metadata or null if not found
 */
async function scryfallLookup(cardName) {
    try {
        const res = await fetch(`/api/scryfall/named?name=${encodeURIComponent(cardName)}`);
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

/**
 * Batch Scryfall lookup for multiple card names.
 * Returns array of metadata objects (null for misses).
 * @param {Array<string>} names
 * @param {function} onProgress — callback(current, total)
 */
async function scryfallBatchLookup(names, onProgress) {
    const results = [];
    for (let i = 0; i < names.length; i++) {
        if (onProgress) onProgress(i + 1, names.length);
        const meta = await scryfallLookup(names[i]);
        results.push(meta);
        // Scryfall asks for max 10 req/sec — pace at ~150ms
        if (i < names.length - 1) await new Promise(r => setTimeout(r, 150));
    }
    return results;
}

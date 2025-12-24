// Polyfill for pdf.js in Worker environment
if (typeof document === 'undefined') {
    self.document = {
        createElement: (tag) => {
            if (tag === 'canvas') {
                return {
                    getContext: () => ({
                        fillRect: () => {},
                        drawImage: () => {},
                        getImageData: () => ({ data: [] }),
                        putImageData: () => {},
                        createImageData: () => ({ data: [] }),
                        setTransform: () => {},
                        save: () => {},
                        restore: () => {},
                        scale: () => {},
                        rotate: () => {},
                        translate: () => {},
                        transform: () => {},
                        beginPath: () => {},
                        closePath: () => {},
                        moveTo: () => {},
                        lineTo: () => {},
                        stroke: () => {},
                        fill: () => {}
                    }),
                    width: 0,
                    height: 0,
                    style: {}
                };
            }
            return { style: {} };
        },
        currentScript: { src: '' },
        documentElement: { style: {} },
        head: { appendChild: () => {} },
        body: { appendChild: () => {} }
    };
}
if (typeof window === 'undefined') {
    self.window = self;
}

let _ready = false;
let _pdfjsReady = false;
let _index = new Map(); // gram -> Array<{bookId,page,offset}>
let _bookMeta = new Map(); // bookId -> {name, pages}
let _pageText = new Map(); // `${bookId}:${page}` -> text

const DB_NAME = 'zero_reader_search_v1';
const DB_VERSION = 1;
const STORE_TEXT = 'pageText';
const STORE_META = 'bookMeta';

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => reject(req.error);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_TEXT)) db.createObjectStore(STORE_TEXT);
            if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
        };
        req.onsuccess = () => resolve(req.result);
    });
}

async function dbPut(store, key, value) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.objectStore(store).put(value, key);
    });
    db.close();
}

async function dbGet(store, key) {
    const db = await openDb();
    const val = await new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    db.close();
    return val;
}

async function dbDelete(store, key) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.objectStore(store).delete(key);
    });
    db.close();
}

async function dbGetAllKeys(store) {
    const db = await openDb();
    const keys = await new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
    db.close();
    return keys;
}

async function indexText({ bookId, bookName, text }) {
    const t = String(text || '');
    _bookMeta.set(bookId, { name: bookName, pages: 1 });
    await dbPut(STORE_META, bookId, { name: bookName, pages: 1 });

    const key = `${bookId}:1`;
    _pageText.set(key, t);
    await dbPut(STORE_TEXT, key, t);

    const grams = gramsFromText(t);
    for (const g of grams) addPosting(g, { bookId, page: 1, offset: 0 });
    postMessage({ type: 'indexed', bookId, pages: 1 });
}

function isCJK(ch) {
    const c = ch.charCodeAt(0);
    return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf);
}

function gramsFromText(text) {
    const grams = [];
    const t = String(text || '');

    // latin/number words
    const words = t.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
    for (const w of words) grams.push(w);

    // CJK bigrams (skip whitespace)
    const chars = [];
    for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        if (isCJK(ch)) chars.push(ch);
    }
    for (let i = 0; i < chars.length - 1; i++) grams.push(chars[i] + chars[i + 1]);

    return grams;
}

function gramsFromQuery(q) {
    const query = String(q || '').trim();
    if (!query) return [];

    const grams = [];

    const words = query.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
    for (const w of words) grams.push(w);

    const cjk = [];
    for (let i = 0; i < query.length; i++) {
        const ch = query[i];
        if (isCJK(ch)) cjk.push(ch);
    }

    if (cjk.length >= 2) {
        for (let i = 0; i < cjk.length - 1; i++) grams.push(cjk[i] + cjk[i + 1]);
    } else if (cjk.length === 1) {
        // single CJK char: can't bigram; force full scan (do not rely on index)
        return [];
    }

    // if no grams produced, fallback to raw query
    if (!grams.length) grams.push(query.toLowerCase());
    return grams;
}

function addPosting(gram, posting) {
    let arr = _index.get(gram);
    if (!arr) {
        arr = [];
        _index.set(gram, arr);
    }
    arr.push(posting);
}

async function ensurePdfJs() {
    if (_pdfjsReady && self.pdfjsLib) return;
    
    // Use pdf.js 2.x which has better Worker compatibility
    const pdfUrl = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js';
    const workerUrl = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
    
    try {
        importScripts(pdfUrl);
        if (self.pdfjsLib) {
            // Set workerSrc to the actual worker file
            self.pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
            _pdfjsReady = true;
            console.log('[Worker] pdf.js 2.16.105 loaded successfully');
            return;
        }
    } catch (e) {
        console.log('[Worker] Failed to load pdf.js:', e.message);
    }
    throw new Error('pdfjsLib not loaded');
}

async function rebuildIndexFromTexts() {
    _index.clear();
    for (const [key, text] of _pageText.entries()) {
        const [bookId, pageStr] = key.split(':');
        const page = Number(pageStr);
        const grams = gramsFromText(text);
        for (const g of grams) addPosting(g, { bookId, page, offset: 0 });
    }
}

function getStats() {
    return { pages: _pageText.size, books: _bookMeta.size, grams: _index.size };
}

async function removeBook(bookId) {
    const id = String(bookId || '').trim();
    if (!id) return;

    const prefix = `${id}:`;
    const toDelete = [];
    for (const key of _pageText.keys()) {
        if (key.startsWith(prefix)) toDelete.push(key);
    }

    for (const key of toDelete) {
        _pageText.delete(key);
        await dbDelete(STORE_TEXT, key);
    }

    _bookMeta.delete(id);
    await dbDelete(STORE_META, id);

    await rebuildIndexFromTexts();
}

async function loadPersisted() {
    const keys = await dbGetAllKeys(STORE_TEXT);
    for (const k of keys) {
        const t = await dbGet(STORE_TEXT, k);
        if (typeof t === 'string') _pageText.set(k, t);
    }

    const metaKeys = await dbGetAllKeys(STORE_META);
    for (const k of metaKeys) {
        const m = await dbGet(STORE_META, k);
        if (m && typeof m.name === 'string') _bookMeta.set(k, m);
    }

    await rebuildIndexFromTexts();
}

function buildSnippet(text, qLower) {
    const lower = text.toLowerCase();
    const idx = lower.indexOf(qLower);
    if (idx === -1) return text.slice(0, 120).replace(/\s+/g, ' ').trim();
    const left = Math.max(0, idx - 28);
    const right = Math.min(text.length, idx + qLower.length + 40);
    return text.slice(left, right).replace(/\s+/g, ' ').trim();
}

async function indexPdf({ bookId, bookName, data }) {
    await ensurePdfJs();

    const loadingTask = self.pdfjsLib.getDocument({ data });
    const doc = await loadingTask.promise;

    _bookMeta.set(bookId, { name: bookName, pages: doc.numPages });
    await dbPut(STORE_META, bookId, { name: bookName, pages: doc.numPages });

    for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const parts = (content.items || []).map((it) => String(it?.str || ''));
        let text = '';
        const isLatinLike = (ch) => {
            const c = ch.charCodeAt(0);
            return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
        };
        for (let i = 0; i < parts.length; i++) {
            const cur = parts[i];
            if (!cur) continue;
            const prevLast = text ? text[text.length - 1] : '';
            if (prevLast && isLatinLike(prevLast) && isLatinLike(cur[0])) {
                text += ' ';
            }
            text += cur;
        }
        text = text.replace(/\s+/g, ' ').trim();
        const key = `${bookId}:${p}`;

        _pageText.set(key, text);
        await dbPut(STORE_TEXT, key, text);

        const grams = gramsFromText(text);
        for (const g of grams) addPosting(g, { bookId, page: p, offset: 0 });

        if (p % 5 === 0) {
            postMessage({ type: 'indexProgress', bookId, page: p, total: doc.numPages });
        }
    }

    postMessage({ type: 'indexed', bookId, pages: doc.numPages });
}

async function search({ query, maxResults = 120 }) {
    const q = String(query || '').trim();
    if (!q) return { results: [] };

    const grams = gramsFromQuery(q);
    const qLower = q.toLowerCase();

    // candidate set
    let candidates = null; // Map<key, {bookId,page}>

    for (const g of grams) {
        const postings = _index.get(g) || [];
        const set = new Map();
        for (const it of postings) {
            const k = `${it.bookId}:${it.page}`;
            set.set(k, { bookId: it.bookId, page: it.page });
        }

        if (candidates === null) {
            candidates = set;
        } else {
            // intersect
            for (const k of candidates.keys()) {
                if (!set.has(k)) candidates.delete(k);
            }
        }

        if (candidates && candidates.size === 0) break;
    }

    // If no candidates or intersection is empty, fallback scan all
    const scanKeys = (!candidates || candidates.size === 0) ? Array.from(_pageText.keys()) : Array.from(candidates.keys());

    const results = [];
    for (const key of scanKeys) {
        const text = _pageText.get(key) || '';
        if (!text) continue;
        if (text.toLowerCase().includes(qLower)) {
            const [bookId, pageStr] = key.split(':');
            const page = Number(pageStr);
            const meta = _bookMeta.get(bookId);
            results.push({
                bookId,
                bookName: meta?.name || '未命名',
                page,
                snippet: buildSnippet(text, qLower)
            });
            if (results.length >= maxResults) break;
        }
    }

    return { results };
}

self.onmessage = async (e) => {
    const { type, payload } = e.data || {};

    try {
        if (type === 'init') {
            await loadPersisted();
            _ready = true;
            postMessage({ type: 'ready', pages: _pageText.size, books: _bookMeta.size });
            return;
        }

        if (type === 'indexPdf') {
            try {
                await indexPdf(payload);
            } catch (err) {
                postMessage({ type: 'error', message: `indexPdf failed: ${err?.message || err}` });
                // Still send indexed message so main thread doesn't hang
                postMessage({ type: 'indexed', bookId: payload?.bookId, pages: 0, error: true });
            }
            return;
        }

        if (type === 'indexText') {
            await indexText(payload);
            return;
        }

        if (type === 'search') {
            if (!_ready) await loadPersisted();
            const res = await search(payload);
            postMessage({ type: 'searchResults', requestId: payload?.requestId, ...res });
            return;
        }

        if (type === 'clearIndex') {
            _index.clear();
            _bookMeta.clear();
            _pageText.clear();
            _ready = true;
            postMessage({ type: 'cleared' });
            return;
        }

        if (type === 'stats') {
            postMessage({ type: 'stats', requestId: payload?.requestId, ...getStats() });
            return;
        }

        if (type === 'removeBook') {
            await removeBook(payload?.bookId);
            postMessage({ type: 'removedBook', bookId: payload?.bookId, ...getStats() });
            return;
        }
    } catch (err) {
        postMessage({ type: 'error', requestId: payload?.requestId, message: String(err?.message || err || 'unknown') });
    }
};

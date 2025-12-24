export class SearchEngine {
    constructor() {
        this.onProgress = null;
        this.onStatus = null;

        this._worker = null;
        this._ready = false;
        this._pending = new Map();
        this._seq = 0;

        this.init();
    }

    init() {
        if (!('Worker' in window)) return;

        this._worker = new Worker('./js/searchWorker.js?v=' + Date.now());
        this._worker.onerror = (e) => {
            console.error('[SearchEngine] Worker error:', e);
            if (this.onStatus) this.onStatus(`Worker 错误: ${e.message || 'unknown'}`);
        };
        this._worker.onmessage = (e) => {
            const msg = e.data || {};

            if (msg.type === 'ready') {
                this._ready = true;
                if (this.onStatus) this.onStatus(`搜索引擎就绪（已缓存页数: ${msg.pages}）`);
                return;
            }

            if (msg.type === 'indexProgress') {
                if (typeof this.onProgress === 'function') {
                    this.onProgress({ bookId: msg.bookId, page: msg.page, total: msg.total });
                }
                return;
            }

            if (msg.type === 'indexed') {
                if (this.onStatus) this.onStatus(`已建立索引（${msg.bookId}）`);
                return;
            }

            if (msg.type === 'searchResults') {
                const { requestId } = msg;
                const p = this._pending.get(requestId);
                if (p) {
                    this._pending.delete(requestId);
                    p.resolve({ results: msg.results || [] });
                }
                return;
            }

            if (msg.type === 'stats') {
                const { requestId } = msg;
                const p = this._pending.get(requestId);
                if (p) {
                    this._pending.delete(requestId);
                    p.resolve({ pages: msg.pages || 0, books: msg.books || 0, grams: msg.grams || 0 });
                }
                return;
            }

            if (msg.type === 'removedBook') {
                if (this.onStatus) this.onStatus(`已移除索引（${msg.bookId}，剩余页数: ${msg.pages || 0}）`);
                return;
            }

            if (msg.type === 'cleared') {
                if (this.onStatus) this.onStatus('已清空搜索索引');
                return;
            }

            if (msg.type === 'error') {
                const { requestId } = msg;
                if (requestId) {
                    const p = this._pending.get(requestId);
                    if (p) {
                        this._pending.delete(requestId);
                        p.reject(new Error(msg.message || 'worker error'));
                        return;
                    }
                }
                // non-request error
                if (this.onStatus) this.onStatus(`搜索引擎错误：${msg.message || 'unknown'}`);
            }
        };

        this._worker.postMessage({ type: 'init' });
    }

    _nextId() {
        this._seq += 1;
        return `req_${Date.now()}_${this._seq}`;
    }

    async indexDocument(book) {
        console.log('[SearchEngine] indexDocument called, worker:', !!this._worker, 'file:', !!book?.file);
        if (!this._worker) {
            console.log('[SearchEngine] No worker!');
            return;
        }
        if (!book?.file) {
            console.log('[SearchEngine] No file!');
            return;
        }

        const name = String(book.name || '');
        const lower = name.toLowerCase();
        console.log('[SearchEngine] Processing file:', lower);

        // .doc (legacy binary) is not supported for local parsing/indexing
        if (lower.endsWith('.doc') && !lower.endsWith('.docx')) {
            if (this.onStatus) this.onStatus(`跳过索引（暂不支持 .doc）: ${book.name}`);
            return;
        }

        if (lower.endsWith('.docx') || book.file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            if (this.onStatus) this.onStatus(`正在建立索引: ${book.name}`);
            if (!window.mammoth?.extractRawText) throw new Error('mammoth not loaded');
            const arrayBuffer = await book.file.arrayBuffer();
            const res = await window.mammoth.extractRawText({ arrayBuffer });
            const text = String(res?.value || '');
            
            return new Promise((resolve) => {
                let resolved = false;
                const handler = (e) => {
                    const msg = e.data || {};
                    if (msg.type === 'indexed' && msg.bookId === book.id) {
                        if (!resolved) {
                            resolved = true;
                            this._worker.removeEventListener('message', handler);
                            resolve();
                        }
                    }
                };
                this._worker.addEventListener('message', handler);
                setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        this._worker.removeEventListener('message', handler);
                        resolve();
                    }
                }, 30000);
                this._worker.postMessage({
                    type: 'indexText',
                    payload: { bookId: book.id, bookName: book.name, text }
                });
            });
        }

        // default: PDF
        console.log('[SearchEngine] PDF branch, file type:', book.file.type);
        if (this.onStatus) this.onStatus(`正在建立索引: ${book.name}`);
        // Guard: only index PDFs here
        if (!(lower.endsWith('.pdf') || book.file.type === 'application/pdf')) {
            console.log('[SearchEngine] Skipping non-PDF');
            if (this.onStatus) this.onStatus(`跳过索引（非 PDF）: ${book.name}`);
            return;
        }
        console.log('[SearchEngine] Getting arrayBuffer...');
        const data = await book.file.arrayBuffer();
        console.log('[SearchEngine] ArrayBuffer size:', data.byteLength);
        
        // Return a promise that resolves when indexing is complete
        console.log('[SearchEngine] Sending indexPdf to worker...');
        return new Promise((resolve) => {
            let resolved = false;
            const handler = (e) => {
                const msg = e.data || {};
                console.log('[SearchEngine] Worker response:', msg.type, msg.bookId);
                if (msg.type === 'indexed' && msg.bookId === book.id) {
                    console.log('[SearchEngine] Index complete!');
                    if (!resolved) {
                        resolved = true;
                        this._worker.removeEventListener('message', handler);
                        resolve();
                    }
                }
                if (msg.type === 'error') {
                    console.log('[SearchEngine] Worker error:', msg.message);
                    if (!resolved) {
                        resolved = true;
                        this._worker.removeEventListener('message', handler);
                        resolve(); // resolve anyway to not block
                    }
                }
            };
            this._worker.addEventListener('message', handler);
            
            // Timeout after 60 seconds
            setTimeout(() => {
                if (!resolved) {
                    console.log('[SearchEngine] Index timeout!');
                    resolved = true;
                    this._worker.removeEventListener('message', handler);
                    resolve();
                }
            }, 60000);
            
            this._worker.postMessage(
                {
                    type: 'indexPdf',
                    payload: {
                        bookId: book.id,
                        bookName: book.name,
                        data
                    }
                },
                [data]
            );
            console.log('[SearchEngine] Message sent to worker');
        });
    }

    clear() {
        if (this._worker) this._worker.postMessage({ type: 'clearIndex' });
    }

    async getStats() {
        if (!this._worker) return { pages: 0, books: 0, grams: 0 };
        // Wait a bit for worker to be ready if needed
        if (!this._ready) {
            await new Promise(r => setTimeout(r, 800));
        }
        const requestId = this._nextId();
        const p = new Promise((resolve, reject) => {
            this._pending.set(requestId, { resolve, reject });
            // Timeout after 5 seconds
            setTimeout(() => {
                if (this._pending.has(requestId)) {
                    this._pending.delete(requestId);
                    resolve({ pages: 0, books: 0, grams: 0, timeout: true });
                }
            }, 5000);
        });
        this._worker.postMessage({ type: 'stats', payload: { requestId } });
        return p;
    }

    removeBook(bookId) {
        if (!this._worker) return;
        this._worker.postMessage({ type: 'removeBook', payload: { bookId } });
    }

    async searchGlobal(query, _books, opts = {}) {
        // Worker uses persisted pageText+meta in IndexedDB, so books list isn't required for speed.
        if (!this._worker) return { results: [] };
        const q = String(query || '').trim();
        if (!q) return { results: [] };

        const requestId = this._nextId();
        const maxResults = Number(opts.maxResults || 120);

        const p = new Promise((resolve, reject) => {
            this._pending.set(requestId, { resolve, reject });
        });

        this._worker.postMessage({
            type: 'search',
            payload: {
                requestId,
                query: q,
                maxResults
            }
        });

        return p;
    }
}

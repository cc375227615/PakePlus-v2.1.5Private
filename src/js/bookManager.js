export class BookManager {
    constructor() {
        this.books = [];
        this.storageKey = 'zero_reader_books_v1';

        this._db = null;
        this._dbName = 'zero_reader_db_v1';
        this._handleStore = 'fileHandles';
    }

    async initDb() {
        if (this._db) return this._db;
        this._db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(this._dbName, 1);
            req.onerror = () => reject(req.error);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(this._handleStore)) {
                    db.createObjectStore(this._handleStore);
                }
            };
            req.onsuccess = () => resolve(req.result);
        });
        return this._db;
    }

    async saveFileHandle(bookId, handle) {
        if (!handle) return;
        await this.initDb();
        await new Promise((resolve, reject) => {
            const tx = this._db.transaction(this._handleStore, 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.objectStore(this._handleStore).put(handle, bookId);
        });
    }

    async getFileHandle(bookId) {
        await this.initDb();
        return await new Promise((resolve, reject) => {
            const tx = this._db.transaction(this._handleStore, 'readonly');
            const req = tx.objectStore(this._handleStore).get(bookId);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async deleteFileHandle(bookId) {
        await this.initDb();
        await new Promise((resolve, reject) => {
            const tx = this._db.transaction(this._handleStore, 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.objectStore(this._handleStore).delete(bookId);
        });
    }

    async hydrateFilesFromHandles() {
        // Best-effort: only works when browser allows reading previously granted handles.
        // If permission is not granted, keep file undefined (UI will prompt user).
        if (!('FileSystemFileHandle' in window) && !('showOpenFilePicker' in window)) return;
        await this.initDb();

        for (const b of this.books) {
            if (b.file) continue;
            try {
                const handle = await this.getFileHandle(b.id);
                if (!handle) continue;
                // Do not trigger permission prompt on load; only query.
                if (typeof handle.queryPermission === 'function') {
                    const p = await handle.queryPermission({ mode: 'read' });
                    if (p !== 'granted') continue;
                }
                const file = await handle.getFile();
                b.file = file;
                b.size = file.size;
                b.name = b.name || file.name;
                b.fileHandle = handle;
            } catch {
                // ignore
            }
        }
    }

    async loadBooks() {
        try {
            const raw = localStorage.getItem(this.storageKey);
            this.books = raw ? JSON.parse(raw) : [];
        } catch {
            this.books = [];
        }
        return this.books;
    }

    async saveBooks() {
        const safeBooks = this.books.map(b => ({
            id: b.id,
            name: b.name,
            size: b.size,
            lastOpened: b.lastOpened,
            lastScrollTop: b.lastScrollTop ?? 0
        }));
        localStorage.setItem(this.storageKey, JSON.stringify(safeBooks));
    }

    findBookByFile(file) {
        if (!file) return null;
        // 去重策略：同名 + 同大小（足够实用且不阻塞）
        return this.books.find(b => b.name === file.name && b.size === file.size) || null;
    }

    findBookById(id) {
        return this.books.find(b => b.id === id) || null;
    }

    getBookIndex(book) {
        return this.books.findIndex(b => b.id === book.id);
    }

    async addBook(file, fileName) {
        const name = fileName || file?.name || '未命名.pdf';
        const size = file?.size ?? 0;

        const dup = this.books.find(b => b.name === name && b.size === size);
        if (dup) {
            // Attach file if missing (common after refresh)
            if (!dup.file && file) dup.file = file;
            return dup;
        }

        const book = {
            id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
            name,
            size,
            lastOpened: new Date().toISOString(),
            lastScrollTop: 0,
            // 运行期字段（不持久化）
            file,
            fileHandle: null
        };

        this.books.unshift(book);
        return book;
    }

    async attachFileToBook(bookId, file) {
        const book = this.findBookById(bookId);
        if (!book) return null;
        book.file = file;
        return book;
    }

    async attachHandleToBook(bookId, handle) {
        const book = this.findBookById(bookId);
        if (!book) return null;
        book.fileHandle = handle;
        await this.saveFileHandle(bookId, handle);
        return book;
    }

    updateBookMeta(bookId, updates) {
        const b = this.findBookById(bookId);
        if (!b) return false;
        Object.assign(b, updates);
        return true;
    }

    async removeBook(bookId) {
        const id = String(bookId || '').trim();
        if (!id) return false;
        const idx = this.books.findIndex(b => b.id === id);
        if (idx === -1) return false;
        this.books.splice(idx, 1);
        try {
            await this.deleteFileHandle(id);
        } catch {
            // ignore
        }
        await this.saveBooks();
        return true;
    }
}

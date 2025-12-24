// Main application module
import { BookManager } from './js/bookManager.js';
import { PDFViewer } from './js/pdfViewer.js';
import { SearchEngine } from './js/searchEngine.js';
import { UI } from './js/ui.js';

class App {
    constructor() {
        // Initialize components
        this.bookManager = new BookManager();
        this.pdfViewer = new PDFViewer();
        this.searchEngine = new SearchEngine();
        this.ui = new UI(this);

        this._pageInfoEl = document.getElementById('pageInfo');
        this._indexingProgressEl = document.getElementById('indexingProgress');

        this.pdfViewer.onProgress = ({ bookId, lastScrollTop }) => {
            this.bookManager.updateBookMeta(bookId, { lastScrollTop });
            // Best-effort persistence; avoid spamming by letting browser batch writes
            this.bookManager.saveBooks();
        };

        this.searchEngine.onStatus = (text) => {
            if (this._pageInfoEl) this._pageInfoEl.textContent = String(text || '就绪');
        };

        this.searchEngine.onProgress = ({ page, total }) => {
            if (!this._indexingProgressEl) return;
            const t = Number(total || 0);
            const p = Number(page || 0);
            if (!t) {
                this._indexingProgressEl.style.width = '0%';
                return;
            }
            const ratio = Math.max(0, Math.min(1, p / t));
            this._indexingProgressEl.style.width = `${Math.round(ratio * 100)}%`;
        };
        
        // Initialize the app
        this.init();
    }
    
    async init() {
        // Initialize UI components
        this.ui.init();
        
        // Load saved books from IndexedDB
        await this.bookManager.loadBooks();
        await this.bookManager.hydrateFilesFromHandles();
        this.ui.updateBookList(this.bookManager.books);
        
        // Setup event listeners
        this.setupEventListeners();
        
        // Apply eye-care mode by default
        document.body.classList.add('eye-care');

        // Debug: show search engine persisted stats on startup
        try {
            const s = await this.searchEngine.getStats();
            if (this._pageInfoEl) this._pageInfoEl.textContent = `搜索引擎就绪（页: ${s.pages}，书: ${s.books}）`;

            // If empty index but we have readable files, rebuild now (common on first run / after refresh)
            if ((s.pages || 0) === 0 && (s.books || 0) === 0) {
                const candidates = (this.bookManager.books || []).filter(b => !!b?.file);
                if (candidates.length) {
                    if (this._pageInfoEl) this._pageInfoEl.textContent = `正在重建索引（${candidates.length} 本书）…`;
                    for (const b of candidates) {
                        await this.searchEngine.indexDocument(b);
                    }
                    const s2 = await this.searchEngine.getStats();
                    if (this._pageInfoEl) this._pageInfoEl.textContent = `索引已就绪（页: ${s2.pages}，书: ${s2.books}）`;
                }
            }
        } catch {
            // ignore
        }
        
        // Check for URL parameters (for deep linking)
        this.checkUrlParams();
    }
    
    setupEventListeners() {
        // Handle window resize
        window.addEventListener('resize', () => {
            if (this.pdfViewer.currentPDF) {
                this.pdfViewer.updatePageInfo();
            }
        });
        
        // Handle beforeunload to save state
        window.addEventListener('beforeunload', () => {
            this.saveAppState();
        });
    }
    
    checkUrlParams() {
        const params = new URLSearchParams(window.location.search);
        const filePath = params.get('file');
        
        if (filePath) {
            // Try to open the file directly if specified in URL
            this.openFileFromPath(filePath);
        }
    }

    async removeBook(bookId) {
        const id = String(bookId || '').trim();
        if (!id) return;

        const book = this.bookManager.findBookById(id);
        const ok = await this.bookManager.removeBook(id);
        if (!ok) return;

        // Remove from search index
        this.searchEngine.removeBook(id);

        // Update UI list
        this.ui.updateBookList(this.bookManager.books);

        // If removing currently opened book, clear viewer
        if (this.ui.currentBookId === id) {
            this.ui.currentBookId = null;
            const container = document.getElementById('pdfContainer');
            if (container) {
                container.innerHTML = `
                    <div class="welcome-screen">
                        <i class="fas fa-book-reader"></i>
                        <h2>欢迎来到丹丘僧的书屋</h2>
                        <p>拖放PDF文件到此处或点击上方按钮导入文档</p>
                    </div>
                `;
            }
        }

        const name = book?.name ? `：${book.name}` : '';
        this.ui.showNotification(`已移除书籍${name}`, 'info');
    }
    
    async openFileFromPath(filePath) {
        try {
            // This is a simplified example - in a real app, you'd need to handle the file system access
            const fileHandle = await window.showOpenFilePicker({
                startIn: 'documents',
                types: [{
                    description: 'PDF Files',
                    accept: { 'application/pdf': ['.pdf'] }
                }],
                multiple: false
            });
            
            const file = await fileHandle[0].getFile();
            await this.openFile(file, fileHandle[0].name, fileHandle[0]);
            
        } catch (error) {
            console.error('Error opening file:', error);
            this.ui.showNotification('无法打开文件', 'error');
        }
    }
    
    async openFile(file, fileName, fileHandle = null) {
        try {
            // Check if file is already open
            const existingBook = this.bookManager.findBookByFile(file);
            if (existingBook) {
                // Attach runtime file (since persistence doesn't store File objects)
                await this.bookManager.attachFileToBook(existingBook.id, file);
                if (fileHandle) await this.bookManager.attachHandleToBook(existingBook.id, fileHandle);
                await this.ui.showBook(existingBook);

                // Always try to index if file is available (index may be empty after refresh)
                if (existingBook.file) {
                    await this.searchEngine.indexDocument(existingBook);
                    try {
                        const s2 = await this.searchEngine.getStats();
                        if (this._pageInfoEl) this._pageInfoEl.textContent = `索引已更新（页: ${s2.pages}，书: ${s2.books}）`;
                    } catch {
                        // ignore
                    }
                }
                return;
            }
            
            // Add to book manager
            const book = await this.bookManager.addBook(file, fileName);
            if (fileHandle) await this.bookManager.attachHandleToBook(book.id, fileHandle);
            
            // Update UI
            this.ui.updateBookList(this.bookManager.books);
            await this.ui.showBook(book);
            
            // Index for search
            console.log('[App] Starting indexDocument for:', book.name, 'file:', !!book.file);
            if (this._pageInfoEl) this._pageInfoEl.textContent = `正在建立索引: ${book.name}`;
            await this.searchEngine.indexDocument(book);
            console.log('[App] indexDocument finished');

            try {
                const s = await this.searchEngine.getStats();
                console.log('[App] Stats after index:', s);
                if (this._pageInfoEl) this._pageInfoEl.textContent = `索引已更新（页: ${s.pages}，书: ${s.books}）`;
            } catch (e) {
                console.error('[App] getStats error:', e);
            }
            
            // Save to IndexedDB
            await this.bookManager.saveBooks();
            
        } catch (error) {
            console.error('Error opening file:', error);
            this.ui.showNotification('打开文件时出错', 'error');
        }
    }
    
    saveAppState() {
        const state = {
            currentBook: this.pdfViewer.currentBook ? this.bookManager.getBookIndex(this.pdfViewer.currentBook) : null,
            currentPage: this.pdfViewer.currentPage,
            books: this.bookManager.books.map(book => ({
                name: book.name,
                lastOpened: book.lastOpened,
                fileHandle: book.fileHandle ? 'saved' : null
            }))
        };
        
        localStorage.setItem('appState', JSON.stringify(state));
    }
    
    loadAppState() {
        const savedState = localStorage.getItem('appState');
        if (!savedState) return;
        
        try {
            const state = JSON.parse(savedState);
            // Restore state here
        } catch (error) {
            console.error('Error loading app state:', error);
        }
    }
}

// Initialize the app when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});

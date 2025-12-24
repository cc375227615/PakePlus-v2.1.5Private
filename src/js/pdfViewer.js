// Minimal PDF viewer using pdfjs already loaded on window as pdfjsLib
export class PDFViewer {
    constructor() {
        this.currentBook = null;
        this.currentPDF = null;
        this.pdfDocument = null;
        this.scale = 1.55;

        this.onProgress = null;

        this._pageTextCache = new Map(); // key: `${bookId}:${page}` -> text
        this._renderedPages = new Set();
        this._observer = null;
        this._currentHighlightQuery = ''; // Current search query for highlighting

        this.pdfViewerEl = document.getElementById('pdfViewer');
        this.pdfContainer = document.getElementById('pdfContainer');
        this.pageInfo = document.getElementById('pageInfo');

        this._onScroll = this._onScroll.bind(this);
        if (this.pdfViewerEl) {
            this.pdfViewerEl.addEventListener('scroll', this._onScroll, { passive: true });
        }
    }

    async ensurePdfJsLoaded() {
        if (window.pdfjsLib?.getDocument) return;

        const loadScript = (src) => new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error(`Failed to load script: ${src}`));
            document.head.appendChild(s);
        });

        // Try primary CDN first, then fallback CDN
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js')
            .catch(() => loadScript('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.4.120/build/pdf.min.js'));

        if (!window.pdfjsLib?.getDocument) {
            throw new Error('pdfjsLib not loaded');
        }
    }

    async loadPDF(book) {
        if (!book?.file) throw new Error('No file on book');
        this.currentBook = book;
        this.currentPDF = book.file;

        await this.ensurePdfJsLoaded();

        const data = await book.file.arrayBuffer();

        // Configure worker src if available (best performance)
        if (window.pdfjsLib?.GlobalWorkerOptions) {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
        }

        // Some environments still fail to spawn workers; retry with worker disabled.
        try {
            this.pdfDocument = await window.pdfjsLib.getDocument({ data }).promise;
        } catch (err) {
            const msg = String(err?.message || err || '');
            const looksLikeWorkerIssue = /worker|Setting up fake worker failed|Failed to fetch|import/i.test(msg);
            if (!looksLikeWorkerIssue) throw err;
            this.pdfDocument = await window.pdfjsLib.getDocument({ data, disableWorker: true }).promise;
        }

        this._renderedPages.clear();
        this.pdfContainer.innerHTML = '';
        for (let i = 1; i <= this.pdfDocument.numPages; i++) {
            const page = await this.pdfDocument.getPage(i);
            // Get viewport - pdf.js handles rotation internally
            const viewport = page.getViewport({ scale: this.scale });
            
            const pageEl = document.createElement('div');
            pageEl.className = 'pdf-page';
            pageEl.dataset.pageNumber = String(i);
            // Set placeholder size based on actual page dimensions
            pageEl.style.width = `${viewport.width}px`;
            pageEl.style.height = `${viewport.height}px`;

            const canvas = document.createElement('canvas');
            canvas.className = 'pdf-canvas';
            pageEl.appendChild(canvas);

            this.pdfContainer.appendChild(pageEl);
        }

        this.setupLazyRender();

        // Restore scroll
        if (typeof book.lastScrollTop === 'number' && this.pdfViewerEl) {
            this.pdfViewerEl.scrollTop = book.lastScrollTop;
        }

        this.updatePageInfo();
    }

    setupLazyRender() {
        if (!this.pdfViewerEl) return;
        if (this._observer) {
            this._observer.disconnect();
            this._observer = null;
        }

        // Prefer IO for performance; fallback to eager render if unsupported
        if (!('IntersectionObserver' in window)) {
            // Render all (may be slow for huge PDFs)
            for (let i = 1; i <= (this.pdfDocument?.numPages || 0); i++) {
                this.renderPage(i);
            }
            return;
        }

        this._observer = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (!e.isIntersecting) continue;
                    const pageNumber = Number(e.target?.dataset?.pageNumber || '0');
                    if (!pageNumber) continue;
                    this.renderPage(pageNumber);
                }
            },
            {
                root: this.pdfViewerEl,
                rootMargin: '1200px 0px',
                threshold: 0.01
            }
        );

        const pages = this.pdfContainer.querySelectorAll('.pdf-page');
        pages.forEach((p) => this._observer.observe(p));
    }

    async renderPage(pageNumber) {
        if (!this.pdfDocument) return;
        if (this._renderedPages.has(pageNumber)) return;
        const page = await this.pdfDocument.getPage(pageNumber);

        const pageEl = this.pdfContainer.querySelector(`.pdf-page[data-page-number="${pageNumber}"]`);
        if (!pageEl) return;
        const canvas = pageEl.querySelector('canvas');
        if (!canvas) return;

        let textLayer = pageEl.querySelector('.textLayer');
        if (!textLayer) {
            textLayer = document.createElement('div');
            textLayer.className = 'textLayer';
            pageEl.appendChild(textLayer);
        }

        // Get viewport - pdf.js handles rotation internally via page.rotate
        // Just pass scale, pdf.js will apply the page's inherent rotation
        const viewport = page.getViewport({ scale: this.scale });
        const ctx = canvas.getContext('2d');
        const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));

        // Set CSS size (layout) and internal pixel size (clarity)
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.width = Math.ceil(viewport.width * dpr);
        canvas.height = Math.ceil(viewport.height * dpr);

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        await page.render({ canvasContext: ctx, viewport }).promise;

        // Selectable text layer for searchable PDFs
        try {
            // Clear previous text layer content
            textLayer.innerHTML = '';
            textLayer.style.width = `${viewport.width}px`;
            textLayer.style.height = `${viewport.height}px`;

            const textContent = await page.getTextContent();

            if (window.pdfjsLib?.renderTextLayer) {
                await window.pdfjsLib.renderTextLayer({
                    textContent,
                    container: textLayer,
                    viewport,
                    textDivs: [],
                    enhanceTextSelection: true
                }).promise;
            }
        } catch {
            // If text layer fails, keep rendered canvas only.
        }
        this._renderedPages.add(pageNumber);
    }

    async getPageText(pageNumber) {
        if (!this.pdfDocument || !this.currentBook) return '';
        const key = `${this.currentBook.id}:${pageNumber}`;
        const cached = this._pageTextCache.get(key);
        if (typeof cached === 'string') return cached;

        const page = await this.pdfDocument.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items.map((it) => it.str).join(' ');
        this._pageTextCache.set(key, text);
        return text;
    }

    async search(query, opts = {}) {
        const q = String(query || '').trim();
        if (!q || !this.pdfDocument) return [];

        const maxResults = Number(opts.maxResults || 80);
        const results = [];
        const qLower = q.toLowerCase();

        for (let page = 1; page <= this.pdfDocument.numPages; page++) {
            const text = await this.getPageText(page);
            const lower = text.toLowerCase();

            let idx = 0;
            while (idx >= 0) {
                idx = lower.indexOf(qLower, idx);
                if (idx === -1) break;

                const left = Math.max(0, idx - 24);
                const right = Math.min(text.length, idx + q.length + 36);
                const snippet = text.slice(left, right).replace(/\s+/g, ' ').trim();

                results.push({ page, snippet });
                if (results.length >= maxResults) return results;
                idx = idx + qLower.length;
            }
        }

        return results;
    }

    updatePageInfo() {
        if (!this.pageInfo) return;
        if (!this.pdfDocument) {
            this.pageInfo.textContent = '就绪';
            return;
        }
        const currentPage = this.getCurrentPageApprox();
        this.pageInfo.textContent = `第 ${currentPage} 页 / 共 ${this.pdfDocument.numPages} 页`;
    }

    getCurrentPageApprox() {
        if (!this.pdfViewerEl) return 1;
        const pages = Array.from(this.pdfContainer.querySelectorAll('.pdf-page'));
        if (!pages.length) return 1;

        const scrollTop = this.pdfViewerEl.scrollTop;
        let best = { page: 1, dist: Infinity };
        for (const el of pages) {
            const top = el.offsetTop;
            const dist = Math.abs(top - scrollTop);
            const p = Number(el.dataset.pageNumber || '1');
            if (dist < best.dist) best = { page: p, dist };
        }
        return best.page;
    }

    scrollToPage(pageNumber, highlightQuery = '') {
        const pageEl = this.pdfContainer.querySelector(`.pdf-page[data-page-number="${pageNumber}"]`);
        if (!pageEl || !this.pdfViewerEl) return;

        this.pdfViewerEl.scrollTo({ top: pageEl.offsetTop - 10, behavior: 'smooth' });
        pageEl.classList.add('highlight-animation');
        setTimeout(() => pageEl.classList.remove('highlight-animation'), 1600);
        
        // Highlight search query in text layer
        if (highlightQuery) {
            this._currentHighlightQuery = highlightQuery;
            // Ensure the page is rendered (textLayer exists) before highlighting.
            Promise.resolve()
                .then(() => this.renderPage(pageNumber))
                .then(() => {
                    // Wait 2 frames so textLayer DOM is populated
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            this.highlightTextInPage(pageNumber, highlightQuery);
                        });
                    });
                })
                .catch(() => {
                    // ignore
                });
        }
    }
    
    highlightTextInPage(pageNumber, query) {
        if (!query) return;
        const pageEl = this.pdfContainer.querySelector(`.pdf-page[data-page-number="${pageNumber}"]`);
        if (!pageEl) return;
        
        const textLayer = pageEl.querySelector('.textLayer');
        if (!textLayer) return;
        
        // Clear previous highlights
        this.clearHighlights();
        
        const q = query.toLowerCase();
        
        // Find and highlight matching spans in text layer
        const spans = textLayer.querySelectorAll('span');
        let firstMatch = null;
        
        spans.forEach(span => {
            const text = span.textContent || '';
            if (text.toLowerCase().includes(q)) {
                span.classList.add('search-highlight');
                if (!firstMatch) firstMatch = span;
            }
        });
        
        // Scroll to first match
        if (firstMatch) {
            firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
    
    clearHighlights() {
        this._currentHighlightQuery = '';
        this.pdfContainer.querySelectorAll('.search-highlight').forEach(el => {
            el.classList.remove('search-highlight');
        });
    }

    _onScroll() {
        if (this.currentBook && this.pdfViewerEl) {
            this.currentBook.lastScrollTop = this.pdfViewerEl.scrollTop;
            if (typeof this.onProgress === 'function') {
                this.onProgress({
                    bookId: this.currentBook.id,
                    lastScrollTop: this.currentBook.lastScrollTop
                });
            }
        }
        this.updatePageInfo();
    }
}

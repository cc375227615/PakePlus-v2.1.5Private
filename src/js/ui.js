export class UI {
    constructor(app) {
        this.app = app;
        this.currentBookId = null;

        this.sidebar = document.querySelector('.sidebar');
        this.resizer = document.getElementById('sidebarResizer');
        this.importBtn = document.getElementById('importBtn');
        this.fileInput = document.getElementById('fileInput');
        this.bookList = document.getElementById('bookList');
        this.bookCount = document.getElementById('bookCount');
        this.globalSearchResults = document.getElementById('globalSearchResults');

        this.pdfViewerEl = document.getElementById('pdfViewer');
        this.searchInput = document.getElementById('searchInput');
        this.searchPanel = document.getElementById('searchPanel');
        this.searchResults = document.getElementById('searchResults');
        this.closeSearchPanelBtn = document.getElementById('closeSearchPanel');

        this.dragCounter = 0;
    }

    init() {
        this.initDragAndDrop();
        this.initImport();
        this.initSidebarResize();
        this.initSearchPanel();
        this.initEyeCareToggle();

        // 默认护眼（或从 localStorage 恢复）
        const savedEyeCare = localStorage.getItem('zero_reader_eye_care');
        if (savedEyeCare === 'false') {
            document.body.classList.remove('eye-care');
        } else {
            document.body.classList.add('eye-care');
        }
    }

    initEyeCareToggle() {
        const btn = document.getElementById('eyeCareToggle');
        if (!btn) return;
        
        btn.addEventListener('click', () => {
            const isEyeCare = document.body.classList.toggle('eye-care');
            localStorage.setItem('zero_reader_eye_care', isEyeCare ? 'true' : 'false');
        });
    }

    initImport() {
        if (this.importBtn) {
            this.importBtn.addEventListener('click', async () => {
                // 优先使用 File System Access API（需要 https 或 localhost）
                const canUseFsApi = !!window.showOpenFilePicker && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');

                if (canUseFsApi) {
                    try {
                        const handles = await window.showOpenFilePicker({
                            multiple: true,
                            types: [{
                                description: 'Documents',
                                accept: {
                                    'application/pdf': ['.pdf'],
                                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']
                                }
                            }]
                        });

                        for (const h of handles) {
                            const f = await h.getFile();
                            await this.app.openFile(f, f.name, h);
                        }
                        return;
                    } catch (e) {
                        // fallback to input
                    }
                }

                if (this.fileInput) {
                    this.fileInput.value = '';
                    this.fileInput.click();
                }
            });
        }

        if (this.fileInput) {
            this.fileInput.addEventListener('change', async (e) => {
                const files = Array.from(e.target.files || []);
                for (const f of files) {
                    await this.app.openFile(f, f.name);
                }
            });
        }
    }

    initDragAndDrop() {
        const dropZone = document.body;
        const prevent = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, prevent, false);
        });

        const highlight = () => {
            this.dragCounter++;
            document.body.classList.add('drag-over');
        };

        const unhighlight = () => {
            this.dragCounter--;
            if (this.dragCounter <= 0) {
                this.dragCounter = 0;
                document.body.classList.remove('drag-over');
            }
        };

        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, highlight, false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, unhighlight, false);
        });

        dropZone.addEventListener('drop', async (e) => {
            const dt = e.dataTransfer;
            const files = Array.from(dt?.files || []);

            for (const f of files) {
                const n = (f.name || '').toLowerCase();
                if (f.type === 'application/pdf' || n.endsWith('.pdf') || n.endsWith('.docx') || n.endsWith('.doc')) {
                    await this.app.openFile(f, f.name);
                }
            }
        }, false);
    }

    async renderDocx(book) {
        const container = document.getElementById('pdfContainer');
        if (!container) return;

        if (!window.mammoth?.convertToHtml) {
            throw new Error('mammoth not loaded');
        }

        const arrayBuffer = await book.file.arrayBuffer();
        const res = await window.mammoth.convertToHtml({ arrayBuffer });
        const html = String(res?.value || '');
        container.innerHTML = `<div class="docx-view">${html}</div>`;
        if (this.pdfViewerEl) this.pdfViewerEl.scrollTop = 0;
    }

    clearDocxHighlights() {
        const container = document.querySelector('.docx-view');
        if (!container) return;
        container.querySelectorAll('mark.search-highlight').forEach((m) => {
            const text = document.createTextNode(m.textContent || '');
            m.replaceWith(text);
        });
        container.normalize();
    }

    highlightDocx(query) {
        const q = String(query || '').trim();
        if (!q) return;
        const container = document.querySelector('.docx-view');
        if (!container) return;

        this.clearDocxHighlights();

        const qLower = q.toLowerCase();
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                const parent = node.parentNode;
                if (!parent) return NodeFilter.FILTER_REJECT;
                if (parent.nodeName === 'SCRIPT' || parent.nodeName === 'STYLE') return NodeFilter.FILTER_REJECT;
                if (parent.nodeName === 'MARK' && parent.classList?.contains('search-highlight')) return NodeFilter.FILTER_REJECT;
                if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        let firstMark = null;
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);

        for (const node of nodes) {
            const text = node.nodeValue || '';
            const lower = text.toLowerCase();
            if (!lower.includes(qLower)) continue;

            const frag = document.createDocumentFragment();
            let lastIdx = 0;
            let idx = lower.indexOf(qLower);
            while (idx !== -1) {
                if (idx > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, idx)));
                const mark = document.createElement('mark');
                mark.className = 'search-highlight';
                mark.textContent = text.slice(idx, idx + q.length);
                if (!firstMark) firstMark = mark;
                frag.appendChild(mark);
                lastIdx = idx + q.length;
                idx = lower.indexOf(qLower, lastIdx);
            }
            if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
            node.parentNode.replaceChild(frag, node);
        }

        if (firstMark) {
            firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    initSidebarResize() {
        if (!this.sidebar || !this.resizer) return;

        let dragging = false;
        let startX = 0;
        let startWidth = 0;

        const minW = 240;
        const maxW = 520;

        const onMove = (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const next = Math.max(minW, Math.min(maxW, startWidth + dx));
            this.sidebar.style.width = `${next}px`;
        };

        const onUp = () => {
            if (!dragging) return;
            dragging = false;
            this.resizer.classList.remove('dragging');
            document.body.style.userSelect = '';
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            localStorage.setItem('zero_reader_sidebar_w', this.sidebar.style.width);
        };

        this.resizer.addEventListener('mousedown', (e) => {
            dragging = true;
            this.resizer.classList.add('dragging');
            startX = e.clientX;
            startWidth = this.sidebar.getBoundingClientRect().width;
            document.body.style.userSelect = 'none';
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });

        const saved = localStorage.getItem('zero_reader_sidebar_w');
        if (saved) this.sidebar.style.width = saved;
    }

    initSearchPanel() {
        if (this.closeSearchPanelBtn && this.searchPanel) {
            this.closeSearchPanelBtn.addEventListener('click', () => {
                this.searchPanel.classList.remove('visible');
            });
        }

        if (this.searchInput) {
            let t = null;
            const run = () => this.handleSearch(this.searchInput.value);
            this.searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.searchPanel) {
                    this.searchPanel.classList.remove('visible');
                }
                if (e.key === 'Enter') run();
            });

            this.searchInput.addEventListener('input', () => {
                clearTimeout(t);
                t = setTimeout(run, 220);
            });
        }
    }

    escapeRegex(string) {
        return String(string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    highlightText(text, query) {
        if (!query) return text;
        const re = new RegExp(`(${this.escapeRegex(query)})`, 'gi');
        return String(text).replace(re, '<span class="highlight">$1</span>');
    }

    async handleSearch(query) {
        const q = String(query || '').trim();
        if (!this.globalSearchResults || !this.bookList) return;

        if (!q) {
            this.globalSearchResults.hidden = true;
            this.globalSearchResults.innerHTML = '';
            this.bookList.hidden = false;
            return;
        }

        // Global search results shown in left sidebar
        this.bookList.hidden = true;
        this.globalSearchResults.hidden = false;
        this.globalSearchResults.innerHTML = '<div class="global-search-empty">正在搜索…</div>';

        try {
            const { results, skipped } = await this.app.searchEngine.searchGlobal(q, this.app.bookManager.books, { maxResults: 120 });
            if (!results.length) {
                const tip = skipped > 0 ? `（有 ${skipped} 本书因未重新授权文件而被跳过）` : '';
                let stats = '';
                try {
                    const s = await this.app.searchEngine.getStats();
                    stats = `（当前索引页: ${s.pages}，书: ${s.books}）`;
                } catch {
                    // ignore
                }
                this.globalSearchResults.innerHTML = `<div class="global-search-empty">未找到结果 ${tip} ${stats}</div>`;
                return;
            }

            this.globalSearchResults.innerHTML = results.map((r) => {
                const snippet = this.highlightText(r.snippet, q);
                return `
                    <div class="global-search-item" data-book-id="${r.bookId}" data-page="${r.page}">
                        <div class="global-search-book">
                            <span>${r.bookName}</span>
                            <span class="global-search-meta">第 ${r.page} 页</span>
                        </div>
                        <div class="global-search-snippet">${snippet}</div>
                    </div>
                `;
            }).join('');

            this.globalSearchResults.querySelectorAll('.global-search-item').forEach((el) => {
                el.addEventListener('click', async () => {
                    const sel = window.getSelection ? String(window.getSelection()?.toString() || '') : '';
                    if (sel && sel.trim().length > 0) return;
                    const bookId = el.getAttribute('data-book-id');
                    const page = Number(el.getAttribute('data-page') || '1');
                    const book = this.app.bookManager.findBookById(bookId);
                    if (!book) return;

                    // Open book if needed
                    await this.showBook(book);

                    // Wait a bit for PDF to be ready, then scroll with highlight
                    setTimeout(() => {
                        const name = String(book.name || '').toLowerCase();
                        const isDocx = name.endsWith('.docx') || book.file?.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                        if (isDocx) {
                            this.highlightDocx(q);
                            return;
                        }
                        this.app.pdfViewer.scrollToPage(page, q);
                    }, 100);
                });
            });
        } catch (e) {
            console.error(e);
            const msg = String(e?.message || e || '').slice(0, 140);
            this.globalSearchResults.innerHTML = `<div class="global-search-empty">搜索失败：${msg}</div>`;
        }
    }

    updateBookList(books) {
        if (!this.bookList) return;
        this.bookList.innerHTML = '';

        if (this.bookCount) {
            this.bookCount.textContent = String(books?.length || 0);
        }

        if (!books?.length) {
            const li = document.createElement('li');
            li.className = 'book-item';
            li.innerHTML = `<i class="fas fa-book"></i><span class="book-title">暂无书籍，导入 PDF 开始阅读</span>`;
            li.style.opacity = '0.7';
            this.bookList.appendChild(li);
            return;
        }

        for (const book of books) {
            const li = document.createElement('li');
            li.className = 'book-item';
            if (this.currentBookId === book.id) li.classList.add('active');

            li.innerHTML = `
                <i class="fas fa-book"></i>
                <span class="book-title" title="${book.name}">${book.name}</span>
                <button class="book-remove" title="移除" aria-label="移除">
                    <i class="fas fa-xmark"></i>
                </button>
            `;

            const removeBtn = li.querySelector('.book-remove');
            if (removeBtn) {
                removeBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                    const confirmed = window.confirm(`是否确认从书架移除「${book.name}」？`);
                    if (!confirmed) return;
                    try {
                        await this.app.removeBook(book.id);
                    } catch (err) {
                        console.error(err);
                    }
                }, true);
            }

            li.addEventListener('click', async () => {
                await this.showBook(book);
            });

            this.bookList.appendChild(li);
        }
    }

    async showBook(book) {
        try {
            // 书架持久化里不存 File，需要用户重新选择一次同名 PDF。
            // 这里不再“点了没反应”，而是给出明确动作。
            if (!book.file) {
                // Try restore from persisted handle (works on localhost/https with prior permission)
                try {
                    const handle = book.fileHandle || (await this.app.bookManager.getFileHandle(book.id));
                    if (handle) {
                        if (typeof handle.requestPermission === 'function') {
                            const p = await handle.requestPermission({ mode: 'read' });
                            if (p !== 'granted') throw new Error('permission not granted');
                        }
                        const file = await handle.getFile();
                        await this.app.bookManager.attachFileToBook(book.id, file);
                        await this.app.bookManager.attachHandleToBook(book.id, handle);
                    }
                } catch {
                    // ignore and fall back to manual selection
                }

                if (!book.file) {
                    this.showNotification('请重新选择该 PDF（出于浏览器安全限制，需重新授权或用“导入文档”授予权限）', 'info');
                    if (this.fileInput) {
                        this.fileInput.value = '';
                        this.fileInput.click();
                    }
                    return;
                }
            }

            this.currentBookId = book.id;
            this.updateBookList(this.app.bookManager.books);

            const name = String(book.name || '').toLowerCase();
            if (name.endsWith('.doc')) {
                this.showNotification('暂不支持 .doc（老格式），建议转换为 .docx 或 .pdf', 'info');
                return;
            }

            if (name.endsWith('.docx') || book.file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                await this.renderDocx(book);
                this.showNotification(`已打开：${book.name}`, 'info');
                return;
            }

            await this.app.pdfViewer.loadPDF(book);
            this.showNotification(`已打开：${book.name}`, 'info');
        } catch (e) {
            console.error(e);
            const msg = String(e?.message || e || '').slice(0, 160);
            this.showNotification(`打开失败：${msg || '未知错误'}`, 'error');
        }
    }

    showNotification(message, type = 'info') {
        const el = document.createElement('div');
        el.className = `notification ${type}`;
        el.textContent = message;
        document.body.appendChild(el);
        setTimeout(() => {
            el.classList.add('fade-out');
            setTimeout(() => el.remove(), 260);
        }, 1800);
    }
}

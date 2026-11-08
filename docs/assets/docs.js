/**
 * Interactive HTML Documentation Suite Script
 * p2p-multiple-groups
 */

(function () {
  'use strict';

  // Determine relative root from data-root attribute or document location
  const ROOT_PATH = document.documentElement.getAttribute('data-root') || './';

  // =========================================================================
  // 1. Theme Management
  // =========================================================================
  const THEME_STORAGE_KEY = 'p2p-docs-theme';

  function getPreferredTheme() {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === 'light' || savedTheme === 'dark') {
      return savedTheme;
    }
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);

    const toggleButtons = document.querySelectorAll('.theme-toggle-btn');
    toggleButtons.forEach((btn) => {
      btn.innerHTML = theme === 'dark' ? '☀️' : '🌙';
      btn.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
      btn.setAttribute('title', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
    });

    // Notify Mermaid if present
    if (window.mermaid) {
      try {
        window.mermaid.initialize({
          startOnLoad: true,
          theme: theme === 'dark' ? 'dark' : 'default',
          securityLevel: 'loose'
        });
      } catch (e) {
        // Ignore Mermaid re-init errors
      }
    }
  }

  function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || getPreferredTheme();
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme);
  }

  // Initialize theme immediately
  const initialTheme = getPreferredTheme();
  applyTheme(initialTheme);

  // =========================================================================
  // 2. Search Index Data
  // =========================================================================
  const SEARCH_DOCUMENTS = [
    {
      title: 'Documentation Portal & Hub',
      category: 'Overview',
      url: 'index.html',
      snippet: 'Welcome to the comprehensive technical documentation suite for p2p-multiple-groups. Hybrid two-tier overlay, Werift WebRTC, HRW election.',
      keywords: 'portal home index overview fasttrack webrtc architecture'
    },
    // Source Code & Syntax
    {
      title: '01. JS/TS & React 19 Syntax in Codebase (Tiếng Việt)',
      category: 'Code Guide',
      url: 'code-guide/01-js-ts-react-syntax-in-codebase.html',
      snippet: 'Bóc tách chi tiết cấu trúc cú pháp JavaScript, TypeScript, Node.js 24 và React 19 trong codebase: const/let, optional chaining, discriminated unions, promise queue serialization, type guards.',
      keywords: 'code syntax javascript typescript react19 hooks usestate useeffect usecallback useref promise queue serialization generics type guards'
    },
    {
      title: '02. Shared Contracts, Preload Bridge & Signaling Code (Tiếng Việt)',
      category: 'Code Guide',
      url: 'code-guide/02-shared-preload-and-signaling-code.html',
      snippet: 'Walkthrough chi tiết electron.vite.config.ts, shared contracts, p2p wire protocol, preload security bridge, signaling server, token bucket rate limiter, timingSafeEqual.',
      keywords: 'code shared contracts preload contextbridge signaling server websocket token bucket rate limiter timingsafeequal csp rfc5766 hmac'
    },
    {
      title: '03. Main Process & P2P Engine Core Walkthrough (Tiếng Việt)',
      category: 'Code Guide',
      url: 'code-guide/03-main-process-and-p2p-engine-code.html',
      snippet: 'Walkthrough chi tiết main process, IPC security 4 tầng, HRW election, SafeCredentialStore DPAPI/Keychain, library hashing, search index, transport pooling, transfers flow control, PeerEngine.',
      keywords: 'code main process p2p engine election hrw rendezvous hashing safecredentailstore library search index transport pooling transfers flow control'
    },
    {
      title: '04. React Renderer UI & Inquiry Test Q&A Bank (Tiếng Việt)',
      category: 'Code Guide',
      url: 'code-guide/04-renderer-ui-and-inquiry-qa.html',
      snippet: 'Walkthrough giao diện React 19, usePeerState hook, Swarm aggregation, bảng tra cứu 30+ vị trí code, và ngân hàng 32 câu hỏi vấn đáp chuyên sâu (Inquiry Test / Viva Defense).',
      keywords: 'code renderer react19 usepeerstate swarm search command palette dialog bang tra cuu code inquiry test van dap viva defense cau hoi'
    },
    // User Guide
    {
      title: "00. JS, TS & npm Fundamentals (Tiếng Việt)",
      category: "User Guide",
      url: "user-guide/00-js-ts-npm-fundamentals.html",
      snippet: "Giải thích căn bản dễ hiểu về JavaScript, TypeScript, Node.js, npm, package.json, tsconfig và chi tiết toàn bộ các lệnh CLI trong project.",
      keywords: "javascript typescript nodejs npm package.json tsconfig electron-vite commands scripts huong dan tieng viet"
    },
    {
      title: '01. Getting Started',
      category: 'User Guide',
      url: 'user-guide/01-getting-started.html',
      snippet: 'System requirements (Node >=24.12.0), setup scripts (npm run dev, start), UI workspace layout tour, and keyboard navigation shortcuts.',
      keywords: 'install setup node requirements dev start shortcuts command palette ctrl+k'
    },
    {
      title: '02. Network & Virtual Groups',
      category: 'User Guide',
      url: 'user-guide/02-network-and-groups.html',
      snippet: 'Virtual groups, canonical GroupKey, V1 vs V2 invitations, SafeStorage keychain credential persistence, privacy mode (relayOnly), and leave/forget.',
      keywords: 'network virtual groups groupkey invitation token keychain safestorage relayonly privacy'
    },
    {
      title: '03. Library & File Sharing',
      category: 'User Guide',
      url: 'user-guide/03-library-and-sharing.html',
      snippet: 'Shared Library screen, OS file picker, background SHA-256 fingerprinting pipeline, fine-grained group access grants, and instant dynamic revocation.',
      keywords: 'library file sharing sha-256 hashing grants revoke rescan'
    },
    {
      title: '04. Search & Discovery',
      category: 'User Guide',
      url: 'user-guide/04-search-and-discovery.html',
      snippet: 'Scoped multi-group search, Unicode NFKC token matching, boolean AND query semantics, supernode failover recovery, and swarm source aggregation.',
      keywords: 'search discovery query token boolean nfkc supernode sources'
    },
    {
      title: '05. Transfers & Flow Control',
      category: 'User Guide',
      url: 'user-guide/05-transfers-and-downloads.html',
      snippet: 'Active transfer monitor, 16 KiB chunks, 256 KiB window ACKs, Direct vs Relayed TURN routes, atomic staging via .tmp, and cancellation.',
      keywords: 'transfers downloads chunk flow control turn relay direct atomic tmp cancellation'
    },
    {
      title: '06. Signaling Server Operations',
      category: 'User Guide',
      url: 'user-guide/06-signaling-and-ops.html',
      snippet: 'Starting local signaling node (npm run signal:start), .env configuration reference, CLI invite generator (npm run signal:invite), and GET /healthz probe.',
      keywords: 'signaling server operations local invite .env healthz websocket'
    },
    {
      title: '07. Troubleshooting & FAQ',
      category: 'User Guide',
      url: 'user-guide/07-troubleshooting-and-faq.html',
      snippet: 'Error code encyclopedia (AUTH_FAILED, NO_SUPERNODE, UNREACHABLE), diagnosing symmetric NAT, headless Linux keychain recovery, and profile backups.',
      keywords: 'troubleshooting faq errors codes auth_failed unreachable symmetric nat linux keychain backup'
    },
    // Distributed Theory
    {
      title: '01. Distributed Topology Foundations',
      category: 'Theory',
      url: 'theory/01-distributed-topology.html',
      snippet: 'Historical evolution from Napster (O(1) index) and Gnutella (O(d^TTL) flooding) to Kazaa two-tier hybrid. Mathematical query scaling comparison matrix.',
      keywords: 'theory topology napster gnutella kazaa fasttrack supernodes complexity scaling'
    },
    {
      title: '02. Supernode Election & Consistent Hashing',
      category: 'Theory',
      url: 'theory/02-election-and-consistent-hashing.html',
      snippet: 'Deterministic candidate eligibility predicate, joinOrder strict total ordering, Rendezvous (HRW) consistent hashing, churn minimality proof (1/|S|).',
      keywords: 'theory election hrw rendezvous hashing consistent churn failover standby'
    },
    {
      title: '03. Virtual Overlays & Consensus',
      category: 'Theory',
      url: 'theory/03-virtual-overlays-and-consensus.html',
      snippet: 'Single-association transport pooling multiplexing over Werift WebRTC, authoritative monotonic revision leases (6000ms), and inverted search LRU cache.',
      keywords: 'theory virtual overlays multiplexing leases consensus inverted index lru cache'
    },
    {
      title: '04. NAT Traversal & WebRTC Architecture',
      category: 'Theory',
      url: 'theory/04-nat-traversal-and-webrtc.html',
      snippet: 'RFC 4787/3489 NAT types, symmetric NAT dilemma, ICE candidate gathering, dynamic RFC 5766 HMAC-SHA1 TURN tokens, Werift pure Node.js WebRTC.',
      keywords: 'theory nat traversal ice stun turn rfc 5766 hmac-sha1 werift webrtc sctp'
    },
    {
      title: '05. Flow Control & Cryptographic Integrity',
      category: 'Theory',
      url: 'theory/05-flow-control-and-integrity.html',
      snippet: '16 KiB chunks, 256 KiB sliding window ACKs, 512 KiB inflight cap, high/low watermark backpressure, on-the-fly streaming SHA-256 verification, atomic commit.',
      keywords: 'theory flow control backpressure sliding window sctp chunks sha-256 integrity'
    },
    {
      title: '06. Security Architecture & Threat Model',
      category: 'Theory',
      url: 'theory/06-security-and-threat-model.html',
      snippet: 'Zero-trust threat model, constant-time token comparison (timingSafeEqual), dynamic chunk grant checks, Chromium sandboxing, connect-src none CSP, validateSender.',
      keywords: 'theory security threat model constant-time timingSafeEqual sandbox csp validatesender'
    },
    // Architecture & Internals
    {
      title: '01. System Architecture Overview',
      category: 'Architecture',
      url: 'architecture/01-system-overview.html',
      snippet: 'Electron multi-process topology (Main vs Preload vs Sandboxed React 19 Renderer), IPC_CHANNELS registry, validateSender security invariant, 200ms throttle.',
      keywords: 'architecture system overview processes main preload renderer ipc contracts validatesender'
    },
    {
      title: '02. PeerEngine Lifecycle & State Management',
      category: 'Architecture',
      url: 'architecture/02-peer-engine-lifecycle.html',
      snippet: 'PeerEngine coordinator, GroupRuntime state data structure, policyQueue promise serializer, 2000ms watchdog monitoring loop, throttled state broadcasts.',
      keywords: 'architecture peerengine lifecycle groupruntime policyqueue watchdog state dispatch'
    },
    {
      title: '03. Wire Protocol Specification',
      category: 'Architecture',
      url: 'architecture/03-wire-protocol-specification.html',
      snippet: 'Formal message wire schemas for Signaling V2 (WebSocket), Overlay Control V2 (SCTP control channel), and Transfer Control V2 (binary file streaming).',
      keywords: 'architecture wire protocol specification schemas signaling control transfer v2'
    },
    {
      title: '04. Storage, Persistence & Migration',
      category: 'Architecture',
      url: 'architecture/04-storage-and-persistence.html',
      snippet: 'MultiGroupPeerStore V2 schema, atomic staging files with randomUUID, legacy V1 profile migration with backup safety, and SafeCredentialStore DPAPI/Keychain.',
      keywords: 'architecture storage persistence migration peerstore safestorage dpapi keychain backup'
    },
    // Operations & Infrastructure
    {
      title: '01. Cloud Deployment & Infrastructure',
      category: 'Operations',
      url: 'operations/01-cloud-deployment.html',
      snippet: 'Azure Ubuntu 22.04 VM production guide, Coturn turnserver.conf, systemd kazaa-signaling unit, Nginx reverse proxy, Certbot renew hook, and Render.com PaaS.',
      keywords: 'operations cloud deployment azure coturn systemd nginx certbot render turn'
    },
    {
      title: '02. Testing Architecture & Verification',
      category: 'Operations',
      url: 'operations/02-testing-and-verification.html',
      snippet: '4-tier automated test harness: Tier 1 Unit & Wire Codecs, Tier 2 Multi-Peer Integration, Tier 3 CDP Electron E2E, and Tier 4 Automated Visual Capture.',
      keywords: 'operations testing verification unit integration e2e cdp regression checklist'
    }
  ];

  // =========================================================================
  // 3. Client-Side Search Modal Implementation
  // =========================================================================
  let searchModalElement = null;
  let searchInputElement = null;
  let searchResultsElement = null;
  let selectedResultIndex = 0;
  let currentSearchResults = [];

  function createSearchModal() {
    if (searchModalElement) return;

    searchModalElement = document.createElement('div');
    searchModalElement.className = 'search-modal-backdrop';
    searchModalElement.setAttribute('role', 'dialog');
    searchModalElement.setAttribute('aria-modal', 'true');
    searchModalElement.setAttribute('aria-label', 'Search documentation');

    searchModalElement.innerHTML = `
      <div class="search-dialog" onclick="event.stopPropagation()">
        <div class="search-input-wrapper">
          <span class="search-input-icon">🔍</span>
          <input type="text" class="search-input" placeholder="Search documentation... (type / or Ctrl+K)" autocomplete="off" spellcheck="false" />
        </div>
        <ul class="search-results-list" role="listbox"></ul>
        <div class="search-dialog-footer">
          <div class="search-shortcuts-hints">
            <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
            <span><kbd>↵</kbd> Select</span>
            <span><kbd>Esc</kbd> Close</span>
          </div>
          <span>p2p-multiple-groups</span>
        </div>
      </div>
    `;

    document.body.appendChild(searchModalElement);

    searchInputElement = searchModalElement.querySelector('.search-input');
    searchResultsElement = searchModalElement.querySelector('.search-results-list');

    searchModalElement.addEventListener('click', closeSearchModal);

    searchInputElement.addEventListener('input', (e) => {
      performSearch(e.target.value.trim());
    });

    searchInputElement.addEventListener('keydown', handleSearchKeydown);
  }

  function openSearchModal() {
    createSearchModal();
    searchModalElement.classList.add('active');
    document.body.style.overflow = 'hidden';
    searchInputElement.value = '';
    performSearch('');
    setTimeout(() => searchInputElement.focus(), 50);
  }

  function closeSearchModal() {
    if (!searchModalElement) return;
    searchModalElement.classList.remove('active');
    document.body.style.overflow = '';
  }

  function performSearch(query) {
    if (!searchResultsElement) return;
    selectedResultIndex = 0;

    const lowerQuery = query.toLowerCase();
    const queryTokens = lowerQuery.split(/\s+/).filter(Boolean);

    if (queryTokens.length === 0) {
      // Show default top items
      currentSearchResults = SEARCH_DOCUMENTS.slice(0, 8);
    } else {
      currentSearchResults = SEARCH_DOCUMENTS.filter((doc) => {
        const textToMatch = `${doc.title} ${doc.category} ${doc.keywords} ${doc.snippet}`.toLowerCase();
        return queryTokens.every((token) => textToMatch.includes(token));
      });
    }

    renderSearchResults();
  }

  function renderSearchResults() {
    searchResultsElement.innerHTML = '';

    if (currentSearchResults.length === 0) {
      searchResultsElement.innerHTML = `
        <li style="padding: 1.5rem 1rem; text-align: center; color: var(--color-text-muted);">
          No documentation matches found.
        </li>
      `;
      return;
    }

    currentSearchResults.forEach((doc, index) => {
      const item = document.createElement('li');
      item.className = `search-result-item ${index === selectedResultIndex ? 'selected' : ''}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', index === selectedResultIndex ? 'true' : 'false');

      const targetHref = `${ROOT_PATH}${doc.url}`;

      item.innerHTML = `
        <div class="search-result-title">
          <span>${escapeHtml(doc.title)}</span>
          <span class="search-result-category">${escapeHtml(doc.category)}</span>
        </div>
        <div class="search-result-snippet">${escapeHtml(doc.snippet)}</div>
      `;

      item.addEventListener('click', () => {
        window.location.href = targetHref;
        closeSearchModal();
      });

      searchResultsElement.appendChild(item);
    });
  }

  function handleSearchKeydown(e) {
    if (e.key === 'Escape') {
      closeSearchModal();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (currentSearchResults.length > 0) {
        selectedResultIndex = (selectedResultIndex + 1) % currentSearchResults.length;
        updateSelectedResult();
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (currentSearchResults.length > 0) {
        selectedResultIndex = (selectedResultIndex - 1 + currentSearchResults.length) % currentSearchResults.length;
        updateSelectedResult();
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (currentSearchResults[selectedResultIndex]) {
        const doc = currentSearchResults[selectedResultIndex];
        window.location.href = `${ROOT_PATH}${doc.url}`;
        closeSearchModal();
      }
    }
  }

  function updateSelectedResult() {
    const items = searchResultsElement.querySelectorAll('.search-result-item');
    items.forEach((item, idx) => {
      if (idx === selectedResultIndex) {
        item.classList.add('selected');
        item.setAttribute('aria-selected', 'true');
        item.scrollIntoView({ block: 'nearest' });
      } else {
        item.classList.remove('selected');
        item.setAttribute('aria-selected', 'false');
      }
    });
  }

  // =========================================================================
  // 4. Code Block Copy to Clipboard & Language Headers
  // =========================================================================
  function setupCodeBlocks() {
    const codeBlocks = document.querySelectorAll('pre code');
    codeBlocks.forEach((codeEl) => {
      const preEl = codeEl.parentElement;
      if (preEl.parentElement.classList.contains('code-block-wrapper')) {
        return; // Already wrapped
      }

      // Infer language from class (e.g. language-typescript -> typescript)
      let lang = 'CODE';
      const classMatch = (codeEl.className || '').match(/language-([a-zA-Z0-9_-]+)/);
      if (classMatch) {
        lang = classMatch[1].toUpperCase();
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'code-block-wrapper';

      const header = document.createElement('div');
      header.className = 'code-header';
      header.innerHTML = `
        <span class="code-lang">${lang}</span>
        <button class="copy-btn" type="button" aria-label="Copy code to clipboard">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span>Copy</span>
        </button>
      `;

      preEl.parentNode.insertBefore(wrapper, preEl);
      wrapper.appendChild(header);
      wrapper.appendChild(preEl);

      const copyBtn = header.querySelector('.copy-btn');
      copyBtn.addEventListener('click', async () => {
        const textToCopy = codeEl.innerText;
        try {
          await navigator.clipboard.writeText(textToCopy);
          copyBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-success)">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            <span style="color: var(--color-success)">Copied!</span>
          `;
          setTimeout(() => {
            copyBtn.innerHTML = `
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span>Copy</span>
            `;
          }, 2000);
        } catch (err) {
          console.error('Failed to copy text', err);
        }
      });
    });
  }

  // =========================================================================
  // 5. Interactive Tab Interfaces
  // =========================================================================
  function setupTabs() {
    const tabContainers = document.querySelectorAll('.tabs-container');
    tabContainers.forEach((container) => {
      const navButtons = container.querySelectorAll('.tab-btn');
      const panes = container.querySelectorAll('.tab-pane');

      navButtons.forEach((btn, index) => {
        btn.addEventListener('click', () => {
          navButtons.forEach((b) => b.classList.remove('active'));
          panes.forEach((p) => p.classList.remove('active'));

          btn.classList.add('active');
          if (panes[index]) {
            panes[index].classList.add('active');
          }
        });
      });
    });
  }

  // =========================================================================
  // 6. Image Lightbox Overlay
  // =========================================================================
  let lightboxModalElement = null;

  function setupLightbox() {
    const images = document.querySelectorAll('article.docs-article img, figure.doc-image-figure img');
    if (images.length === 0) return;

    if (!lightboxModalElement) {
      lightboxModalElement = document.createElement('div');
      lightboxModalElement.className = 'lightbox-modal';
      lightboxModalElement.innerHTML = `
        <button class="lightbox-close" aria-label="Close zoomed image">&times;</button>
        <img class="lightbox-img" src="" alt="Enlarged screenshot" />
        <div class="lightbox-caption"></div>
      `;
      document.body.appendChild(lightboxModalElement);

      const closeBtn = lightboxModalElement.querySelector('.lightbox-close');
      const closeAction = () => {
        lightboxModalElement.classList.remove('active');
        document.body.style.overflow = '';
      };

      closeBtn.addEventListener('click', closeAction);
      lightboxModalElement.addEventListener('click', (e) => {
        if (e.target === lightboxModalElement) {
          closeAction();
        }
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && lightboxModalElement.classList.contains('active')) {
          closeAction();
        }
      });
    }

    images.forEach((img) => {
      img.addEventListener('click', () => {
        const modalImg = lightboxModalElement.querySelector('.lightbox-img');
        const modalCaption = lightboxModalElement.querySelector('.lightbox-caption');

        modalImg.src = img.src;
        modalImg.alt = img.alt || 'Documentation screenshot';

        // Find figcaption or title
        let captionText = img.alt || '';
        const parentFigure = img.closest('figure');
        if (parentFigure) {
          const figcaption = parentFigure.querySelector('figcaption');
          if (figcaption) {
            captionText = figcaption.innerText;
          }
        }
        modalCaption.innerText = captionText;

        lightboxModalElement.classList.add('active');
        document.body.style.overflow = 'hidden';
      });
    });
  }

  // =========================================================================
  // 7. Navigation Sidebar & Mobile Drawer
  // =========================================================================
  function setupSidebar() {
    const menuToggle = document.querySelector('.menu-toggle');
    const sidebar = document.querySelector('.docs-sidebar');

    if (menuToggle && sidebar) {
      menuToggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
      });

      document.addEventListener('click', (e) => {
        if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && !menuToggle.contains(e.target)) {
          sidebar.classList.remove('open');
        }
      });
    }

    // Mark current active nav item
    const currentPath = window.location.pathname;
    const navLinks = document.querySelectorAll('.nav-item a');
    navLinks.forEach((link) => {
      const linkHref = link.getAttribute('href');
      if (linkHref && currentPath.endsWith(linkHref.replace(/^(\.\/|\.\.\/)/, ''))) {
        link.parentElement.classList.add('active');
      }
    });
  }

  // =========================================================================
  // 8. Table of Contents Active Spy
  // =========================================================================
  function setupTocSpy() {
    const tocLinks = document.querySelectorAll('.toc-link');
    if (tocLinks.length === 0) return;

    const headingTargets = [];
    tocLinks.forEach((link) => {
      const href = link.getAttribute('href');
      if (href && href.startsWith('#')) {
        const target = document.getElementById(href.slice(1));
        if (target) {
          headingTargets.push({ link, target });
        }
      }
    });

    if (headingTargets.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            tocLinks.forEach((l) => l.classList.remove('active'));
            const match = headingTargets.find((item) => item.target === entry.target);
            if (match) {
              match.link.classList.add('active');
            }
          }
        });
      },
      {
        rootMargin: '-80px 0px -70% 0px',
        threshold: 0
      }
    );

    headingTargets.forEach((item) => observer.observe(item.target));
  }

  // =========================================================================
  // 9. Utilities & Global Shortcuts
  // =========================================================================
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function setupGlobalShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+K or Cmd+K or / (when not in an input/textarea)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openSearchModal();
      } else if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        openSearchModal();
      }
    });

    const searchTriggers = document.querySelectorAll('.search-trigger');
    searchTriggers.forEach((trigger) => {
      trigger.addEventListener('click', openSearchModal);
    });

    const themeToggleButtons = document.querySelectorAll('.theme-toggle-btn');
    themeToggleButtons.forEach((btn) => {
      btn.addEventListener('click', toggleTheme);
    });
  }

  // =========================================================================
  // DOM Ready Lifecycle Execution
  // =========================================================================
  document.addEventListener('DOMContentLoaded', () => {
    setupCodeBlocks();
    setupTabs();
    setupLightbox();
    setupSidebar();
    setupTocSpy();
    setupGlobalShortcuts();
  });
})();

/**
 * AirTransfer - High-Speed & Secure PC & iPhone Synchronizer
 */

// State
let myDeviceId = 'dev_' + Math.random().toString(36).substring(2, 9);
let myDeviceName = 'Устройство';
let myDeviceType = 'desktop';
let myAppPin = localStorage.getItem('airtransfer_pin') || '7777';
let defaultRecipient = localStorage.getItem('airtransfer_default_recipient') || 'Всем';
let knownDevices = new Set(['Всем']);

let activeFilter = 'all';
let allItems = [];
let ws = null;
let currentServerUrl = window.location.origin;
let qrCodeInstance = null;
let tunnelUrl = null;
let localUrl = null;
let currentModalMode = 'internet';

// Sound Effects via Web Audio API
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playChime() {
    try {
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        const now = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.28);
    } catch (e) {}
}

// Device Detection & Saved Name
function detectDevice() {
    const savedName = localStorage.getItem('airtransfer_device_name');
    const ua = navigator.userAgent;

    if (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) {
        myDeviceType = 'ios';
        myDeviceName = savedName || '📱 Мой iPhone';
    } else if (/Android/.test(ua)) {
        myDeviceType = 'android';
        myDeviceName = savedName || '🤖 Мой Android';
    } else if (/Macintosh|Mac OS X/.test(ua)) {
        myDeviceType = 'desktop';
        myDeviceName = savedName || '💻 Мой Mac';
    } else if (/Windows/.test(ua)) {
        myDeviceType = 'desktop';
        myDeviceName = savedName || '💻 Мой ПК';
    } else {
        myDeviceType = 'desktop';
        myDeviceName = savedName || '💻 Компьютер';
    }

    const badge = document.getElementById('deviceBadge');
    if (badge) {
        badge.textContent = `Вы: ${myDeviceName}`;
    }
}

// Toast Notifications
function showToast(message, icon = 'ℹ️') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 2800);
}

// Authenticated Fetch Helper
function authFetch(url, options = {}) {
    options.headers = options.headers || {};
    if (options.headers instanceof Headers) {
        options.headers.set('X-App-Pin', myAppPin);
    } else {
        options.headers['X-App-Pin'] = myAppPin;
    }
    return fetch(url, options);
}

// Format Helpers
function formatBytes(bytes, decimals = 1) {
    if (!bytes || bytes === 0) return '0 Байт';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Байт', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr.replace(' ', 'T'));
        const now = new Date();
        const isToday = d.toDateString() === now.toDateString();
        const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (isToday) return `Сегодня в ${time}`;
        return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} в ${time}`;
    } catch {
        return dateStr;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

function autoLinkText(text) {
    const escaped = escapeHtml(text);
    const urlPattern = /(https?:\/\/[^\s<]+)/g;
    return escaped.replace(urlPattern, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

// WebSocket Setup
function initWebSocket() {
    if (!myAppPin) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?pin=${encodeURIComponent(myAppPin)}`;

    try {
        if (ws) {
            ws.onclose = null;
            ws.close();
        }
    } catch (e) {}

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        ws.send(JSON.stringify({
            pin: myAppPin,
            device_id: myDeviceId,
            device_name: myDeviceName,
            device_type: myDeviceType
        }));
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleWsMessage(data);
        } catch (e) {
            console.error('WS Parse error', e);
        }
    };

    ws.onclose = () => {
        setTimeout(initWebSocket, 2500);
    };

    ws.onerror = (err) => {
        ws.close();
    };
}

function handleWsMessage(data) {
    if (data.type === 'auth_error') {
        showPinLockModal('Неверный PIN-код доступа');
    } else if (data.type === 'peers_update') {
        updatePeersList(data.peers);
    } else if (data.type === 'tunnel_ready') {
        tunnelUrl = data.tunnel_url;
        updateModalUrls();
        showToast('Интернет-доступ Cloudflare подключен!', '🌍');
    } else if (data.type === 'new_file') {
        const item = { ...data.item, kind: 'file' };
        addItemToFeed(item, true);
        playChime();
        showToast(`Новый файл: ${item.original_name}`, '📁');
    } else if (data.type === 'new_text') {
        const item = { ...data.item, kind: 'text' };
        addItemToFeed(item, true);
        playChime();
        showToast('Получен новый текст / заметка', '📝');
    } else if (data.type === 'delete_file') {
        removeItemFromFeed('file', data.id);
    } else if (data.type === 'delete_text') {
        removeItemFromFeed('text', data.id);
    } else if (data.type === 'clear_all') {
        allItems = [];
        renderFeed();
        showToast('История очищена', '🧹');
    }
}

// Update Active Devices & Target Selectors
function updatePeersList(peers) {
    const container = document.getElementById('devicesList');
    const peersCount = document.getElementById('peersCount');
    const targetSelect = document.getElementById('targetDeviceSelect');
    const settingsDefaultSelect = document.getElementById('settingsDefaultRecipient');

    if (!container) return;
    container.innerHTML = '';
    peersCount.textContent = `${peers.length} устр.`;

    const allChip = document.createElement('div');
    allChip.className = 'device-chip active';
    allChip.innerHTML = `<span class="chip-dot"></span><span class="chip-name">Общий поток (Всем)</span>`;
    container.appendChild(allChip);

    peers.forEach(peer => {
        const chip = document.createElement('div');
        chip.className = 'device-chip';
        const isMe = peer.name === myDeviceName;
        chip.innerHTML = `
            <span class="chip-dot"></span>
            <span class="chip-name">${escapeHtml(peer.name)} ${isMe ? '(Вы)' : ''}</span>
        `;
        container.appendChild(chip);

        if (!isMe && peer.name) {
            knownDevices.add(peer.name);
        }
    });

    // Populate Target Selectors
    if (targetSelect) {
        const currentVal = targetSelect.value || defaultRecipient;
        targetSelect.innerHTML = `<option value="Всем">🌐 Всем моим устройствам</option>`;
        knownDevices.forEach(dev => {
            if (dev !== 'Всем') {
                const opt = document.createElement('option');
                opt.value = dev;
                opt.textContent = `🎯 ${dev}`;
                targetSelect.appendChild(opt);
            }
        });
        targetSelect.value = currentVal;
    }

    if (settingsDefaultSelect) {
        settingsDefaultSelect.innerHTML = `<option value="Всем">🌐 Всем моим устройствам</option>`;
        knownDevices.forEach(dev => {
            if (dev !== 'Всем') {
                const opt = document.createElement('option');
                opt.value = dev;
                opt.textContent = `🎯 ${dev}`;
                settingsDefaultSelect.appendChild(opt);
            }
        });
        settingsDefaultSelect.value = defaultRecipient;
    }
}

// Feed Management
async function loadInitialData() {
    try {
        const [textsRes, filesRes] = await Promise.all([
            authFetch('/api/texts'),
            authFetch('/api/files')
        ]);

        if (textsRes.status === 401 || filesRes.status === 401) {
            showPinLockModal('Введите PIN-код для входа');
            return;
        }

        const texts = await textsRes.json();
        const files = await filesRes.json();

        const formattedTexts = texts.map(t => ({ ...t, kind: 'text' }));
        const formattedFiles = files.map(f => ({ ...f, kind: 'file' }));

        allItems = [...formattedTexts, ...formattedFiles].sort((a, b) => {
            return new Date(b.created_at) - new Date(a.created_at);
        });

        renderFeed();
    } catch (err) {
        console.error('Failed to load initial data', err);
    }
}

function addItemToFeed(item, highlight = false) {
    if (allItems.some(x => x.kind === item.kind && x.id === item.id)) return;
    allItems.unshift(item);
    renderFeed(highlight ? item : null);
}

function removeItemFromFeed(kind, id) {
    allItems = allItems.filter(x => !(x.kind === kind && x.id === id));
    renderFeed();
}

function renderFeed(highlightItem = null) {
    const container = document.getElementById('feedList');
    const badge = document.getElementById('totalItemsBadge');

    const filtered = allItems.filter(item => {
        if (activeFilter === 'files') return item.kind === 'file';
        if (activeFilter === 'texts') return item.kind === 'text';
        return true;
    });

    badge.textContent = filtered.length;

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📭</div>
                <p class="empty-text">История пуста. Отправьте файл или заметку!</p>
            </div>
        `;
        return;
    }

    container.innerHTML = '';
    filtered.forEach(item => {
        const el = item.kind === 'file' ? renderFileItem(item) : renderTextItem(item);
        if (highlightItem && highlightItem.kind === item.kind && highlightItem.id === item.id) {
            el.classList.add('highlight-new');
        }
        container.appendChild(el);
    });
}

function renderTextItem(item) {
    const div = document.createElement('div');
    div.className = 'feed-item text-item';
    div.id = `item-text-${item.id}`;

    const formattedTime = formatDate(item.created_at);
    const contentHtml = autoLinkText(item.content);
    const targetTag = (item.target_device && item.target_device !== 'Всем') 
        ? `<span class="target-badge">➔ Для: ${escapeHtml(item.target_device)}</span>` 
        : '';

    div.innerHTML = `
        <div class="item-meta">
            <span class="meta-sender">
                <span>📝</span>
                <span>От: <b>${escapeHtml(item.sender_device)}</b></span>
                ${targetTag}
            </span>
            <span class="meta-time">${formattedTime}</span>
        </div>
        <div class="text-item-body">
            ${item.title ? `<div class="text-item-title">${escapeHtml(item.title)}</div>` : ''}
            <div class="text-item-content">${contentHtml}</div>
        </div>
        <div class="item-actions">
            <button class="btn-action copy-text-btn" data-content="${encodeURIComponent(item.content)}">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                <span>Скопировать</span>
            </button>
            <button class="btn-action btn-delete" onclick="deleteText(${item.id})" title="Удалить">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
            </button>
        </div>
    `;

    const copyBtn = div.querySelector('.copy-text-btn');
    copyBtn.addEventListener('click', () => {
        copyToClipboard(item.content, copyBtn);
    });

    return div;
}

function renderFileItem(item) {
    const div = document.createElement('div');
    div.className = 'feed-item file-item';
    div.id = `item-file-${item.id}`;

    const formattedTime = formatDate(item.created_at);
    const sizeStr = formatBytes(item.file_size);
    const fileUrl = `/uploads/${encodeURIComponent(item.filename)}`;
    const downloadUrl = `/api/download/${encodeURIComponent(item.filename)}?pin=${encodeURIComponent(myAppPin)}`;

    const isImage = item.content_type.startsWith('image/');
    const isVideo = item.content_type.startsWith('video/');
    const isAudio = item.content_type.startsWith('audio/');

    const targetTag = (item.target_device && item.target_device !== 'Всем') 
        ? `<span class="target-badge">➔ Для: ${escapeHtml(item.target_device)}</span>` 
        : '';

    let previewHtml = '';
    if (isImage) {
        previewHtml = `<img src="${fileUrl}" class="file-preview-thumb" alt="${escapeHtml(item.original_name)}" onclick="openLightbox('${fileUrl}', 'image', '${escapeHtml(item.original_name)}', '${downloadUrl}')">`;
    } else if (isVideo) {
        previewHtml = `<div class="file-icon-placeholder" onclick="openLightbox('${fileUrl}', 'video', '${escapeHtml(item.original_name)}', '${downloadUrl}')" style="cursor:pointer">🎬</div>`;
    } else if (isAudio) {
        previewHtml = `<div class="file-icon-placeholder">🎵</div>`;
    } else {
        previewHtml = `<div class="file-icon-placeholder">📄</div>`;
    }

    let mediaInlineHtml = '';
    if (isVideo) {
        mediaInlineHtml = `
            <div class="inline-video-wrap">
                <video src="${fileUrl}" controls playsinline preload="metadata" class="inline-video-player"></video>
            </div>
        `;
    } else if (isAudio) {
        mediaInlineHtml = `
            <audio src="${fileUrl}" controls preload="metadata" class="inline-audio-player"></audio>
        `;
    }

    div.innerHTML = `
        <div class="item-meta">
            <span class="meta-sender">
                <span>📁</span>
                <span>От: <b>${escapeHtml(item.sender_device)}</b></span>
                ${targetTag}
            </span>
            <span class="meta-time">${formattedTime}</span>
        </div>
        <div class="file-item-body">
            ${previewHtml}
            <div class="file-details">
                <div class="file-name" title="${escapeHtml(item.original_name)}">${escapeHtml(item.original_name)}</div>
                <div class="file-subinfo">
                    <span>${sizeStr}</span>
                </div>
            </div>
        </div>
        ${mediaInlineHtml}
        <div class="item-actions">
            <a href="${downloadUrl}" class="btn-action" download="${escapeHtml(item.original_name)}">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                <span>Скачать</span>
            </a>
            <button class="btn-action btn-delete" onclick="deleteFile(${item.id})" title="Удалить">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
            </button>
        </div>
    `;

    return div;
}

// Actions
async function copyToClipboard(text, btnElement = null) {
    try {
        await navigator.clipboard.writeText(text);
        if (navigator.vibrate) navigator.vibrate(50);
        showToast('Текст скопирован в буфер!', '📋');
        if (btnElement) {
            const originalHtml = btnElement.innerHTML;
            btnElement.classList.add('copied');
            btnElement.innerHTML = `<span>✅ Скопировано!</span>`;
            setTimeout(() => {
                btnElement.classList.remove('copied');
                btnElement.innerHTML = originalHtml;
            }, 2000);
        }
    } catch (err) {
        showToast('Не удалось скопировать', '⚠️');
    }
}

async function deleteText(id) {
    if (!confirm('Удалить эту заметку?')) return;
    try {
        await authFetch(`/api/texts/${id}`, { method: 'DELETE' });
    } catch (e) {
        showToast('Ошибка при удалении', '❌');
    }
}

async function deleteFile(id) {
    if (!confirm('Удалить этот файл?')) return;
    try {
        await authFetch(`/api/files/${id}`, { method: 'DELETE' });
    } catch (e) {
        showToast('Ошибка при удалении', '❌');
    }
}

// Upload Handling
function uploadFiles(fileList) {
    if (!fileList || fileList.length === 0) return;

    const targetSelect = document.getElementById('targetDeviceSelect');
    const targetRecipient = targetSelect ? targetSelect.value : 'Всем';

    const formData = new FormData();
    for (let i = 0; i < fileList.length; i++) {
        formData.append('files', fileList[i]);
    }
    formData.append('sender_device', myDeviceName);
    formData.append('target_device', targetRecipient);
    formData.append('pin', myAppPin);

    const progressCard = document.getElementById('uploadProgressCard');
    const progressBar = document.getElementById('progressBarFill');
    const progressPercent = document.getElementById('progressPercent');
    const progressTitle = document.getElementById('progressFileName');

    const nameText = fileList.length === 1 ? fileList[0].name : `${fileList.length} файлов...`;
    progressTitle.textContent = `Отправка для [${targetRecipient}]: ${nameText}`;
    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';
    progressCard.style.display = 'block';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload', true);
    xhr.setRequestHeader('X-App-Pin', myAppPin);

    xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            progressBar.style.width = percent + '%';
            progressPercent.textContent = percent + '%';
        }
    };

    xhr.onload = () => {
        progressCard.style.display = 'none';
        if (xhr.status === 200) {
            showToast(`Успешно отправлено для ${targetRecipient}!`, '🚀');
            document.getElementById('fileInputAll').value = '';
            document.getElementById('fileInputMedia').value = '';
        } else if (xhr.status === 401) {
            showPinLockModal('Сессия истекла или неверный PIN');
        } else {
            showToast('Ошибка при отправке файла', '❌');
        }
    };

    xhr.onerror = () => {
        progressCard.style.display = 'none';
        showToast('Сетевая ошибка при отправке', '❌');
    };

    xhr.send(formData);
}

// Lightbox Modal
function openLightbox(url, type, name, downloadUrl) {
    const modal = document.getElementById('lightboxModal');
    const container = document.getElementById('lightboxMediaContainer');
    const title = document.getElementById('lightboxFileName');
    const downloadBtn = document.getElementById('lightboxDownloadBtn');

    title.textContent = name;
    downloadBtn.href = downloadUrl;
    downloadBtn.download = name;

    container.innerHTML = '';
    if (type === 'image') {
        const img = document.createElement('img');
        img.src = url;
        container.appendChild(img);
    } else if (type === 'video') {
        const video = document.createElement('video');
        video.src = url;
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        container.appendChild(video);
    }

    modal.style.display = 'flex';
}

function closeLightbox() {
    const modal = document.getElementById('lightboxModal');
    const container = document.getElementById('lightboxMediaContainer');
    container.innerHTML = '';
    modal.style.display = 'none';
}

// QR Code Modal & Server Info
async function setupQrModal() {
    const modal = document.getElementById('qrModal');
    const openBtn = document.getElementById('openQrBtn');
    const closeBtn = document.getElementById('closeQrBtn');
    const copyUrlBtn = document.getElementById('copyUrlBtn');
    const tabInternetMode = document.getElementById('tabInternetMode');
    const tabLocalMode = document.getElementById('tabLocalMode');
    const ipSelect = document.getElementById('ipSelect');

    let allIps = [];
    let port = 8000;

    try {
        const res = await authFetch('/api/info');
        const info = await res.json();
        allIps = info.all_ips || [window.location.hostname];
        port = info.port || 8000;
        if (info.tunnel_url) {
            tunnelUrl = info.tunnel_url;
        }
    } catch {
        allIps = [window.location.hostname];
    }

    localUrl = `http://${allIps[0]}:${port}`;

    if (allIps.length > 0) {
        ipSelect.innerHTML = '';
        allIps.forEach(ip => {
            const opt = document.createElement('option');
            opt.value = `http://${ip}:${port}`;
            opt.textContent = `${ip} ${ip.startsWith('192.168.') ? '(Основной Wi-Fi)' : ip.startsWith('172.20.') ? '(USB Модем iPhone)' : ''}`;
            ipSelect.appendChild(opt);
        });
        ipSelect.addEventListener('change', (e) => {
            localUrl = e.target.value;
            if (currentModalMode === 'local') {
                updateModalUrls();
            }
        });
    }

    tabInternetMode.addEventListener('click', () => {
        tabInternetMode.classList.add('active');
        tabLocalMode.classList.remove('active');
        currentModalMode = 'internet';
        updateModalUrls();
    });

    tabLocalMode.addEventListener('click', () => {
        tabLocalMode.classList.add('active');
        tabInternetMode.classList.remove('active');
        currentModalMode = 'local';
        updateModalUrls();
    });

    updateModalUrls();

    openBtn.addEventListener('click', () => {
        modal.style.display = 'flex';
        updateModalUrls();
    });

    closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
    });

    copyUrlBtn.addEventListener('click', () => {
        if (currentServerUrl && currentServerUrl.startsWith('http')) {
            copyToClipboard(currentServerUrl);
        }
    });
}

function updateModalUrls() {
    const urlText = document.getElementById('serverUrlText');
    const qrWrapper = document.getElementById('qrcodeWrapper');
    const ipSelectorWrap = document.getElementById('ipSelectorWrap');
    const stepInternetHelp = document.getElementById('stepInternetHelp');

    let activeUrl = '';
    if (currentModalMode === 'internet') {
        activeUrl = tunnelUrl || (window.location.protocol.startsWith('http') && !window.location.hostname.includes('localhost') && !window.location.hostname.includes('127.0.0.1') ? window.location.origin : 'Генерация защищенной ссылки Cloudflare...');
        ipSelectorWrap.style.display = 'none';
        if (stepInternetHelp) {
            stepInternetHelp.innerHTML = `
                <span class="step-number">1</span>
                <div class="step-desc">
                    <b>Отовсюду (4G / Wi-Fi):</b> Заходите с iPhone из любой точки мира через интернет!
                </div>
            `;
        }
    } else {
        activeUrl = localUrl || `http://${window.location.hostname}:8000`;
        ipSelectorWrap.style.display = 'block';
        if (stepInternetHelp) {
            stepInternetHelp.innerHTML = `
                <span class="step-number">1</span>
                <div class="step-desc">
                    <b>Локальная сеть:</b> iPhone и ПК должны быть в одном Wi-Fi (или подключены USB-кабелем).
                </div>
            `;
        }
    }

    urlText.textContent = activeUrl;
    currentServerUrl = activeUrl;

    if (activeUrl.startsWith('http')) {
        qrWrapper.innerHTML = '';
        qrCodeInstance = new QRCode(qrWrapper, {
            text: activeUrl,
            width: 200,
            height: 200,
            colorDark: "#000000",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.M
        });
    }
}

// PIN Security Modal
function showPinLockModal(customMessage = null) {
    const modal = document.getElementById('pinLockModal');
    const pinInput = document.getElementById('pinInput');
    const subtitle = modal.querySelector('.pin-lock-subtitle');

    if (customMessage) {
        subtitle.textContent = customMessage;
        subtitle.style.color = 'var(--accent-red)';
    }

    modal.style.display = 'flex';
    pinInput.value = '';
    pinInput.focus();
}

function hidePinLockModal() {
    const modal = document.getElementById('pinLockModal');
    modal.style.display = 'none';
}

function setupPinLock() {
    const form = document.getElementById('pinLockForm');
    const pinInput = document.getElementById('pinInput');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pin = pinInput.value.trim();
        if (!pin) return;

        try {
            const res = await fetch('/api/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin: pin })
            });

            if (res.ok) {
                myAppPin = pin;
                localStorage.setItem('airtransfer_pin', pin);
                hidePinLockModal();
                showToast('Вход успешно выполнен!', '🔓');
                initWebSocket();
                loadInitialData();
            } else {
                showToast('Неверный PIN-код!', '❌');
                pinInput.value = '';
                pinInput.focus();
            }
        } catch {
            showToast('Сетевая ошибка при проверке PIN', '❌');
        }
    });
}

// Settings Modal
function setupSettingsModal() {
    const modal = document.getElementById('settingsModal');
    const openBtn = document.getElementById('openSettingsBtn');
    const closeBtn = document.getElementById('closeSettingsBtn');
    const deviceNameInput = document.getElementById('settingsDeviceName');
    const defaultRecipientSelect = document.getElementById('settingsDefaultRecipient');
    const saveBtn = document.getElementById('btnSaveSettings');
    const changePinBtn = document.getElementById('btnChangePin');
    const oldPinInput = document.getElementById('settingsOldPin');
    const newPinInput = document.getElementById('settingsNewPin');

    openBtn.addEventListener('click', () => {
        deviceNameInput.value = myDeviceName;
        defaultRecipientSelect.value = defaultRecipient;
        modal.style.display = 'flex';
    });

    closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
    });

    // Save Settings
    saveBtn.addEventListener('click', () => {
        const newName = deviceNameInput.value.trim();
        if (newName) {
            myDeviceName = newName;
            localStorage.setItem('airtransfer_device_name', newName);
            document.getElementById('deviceBadge').textContent = `Вы: ${newName}`;
        }

        defaultRecipient = defaultRecipientSelect.value;
        localStorage.setItem('airtransfer_default_recipient', defaultRecipient);
        document.getElementById('targetDeviceSelect').value = defaultRecipient;

        modal.style.display = 'none';
        showToast('Настройки сохранены!', '✅');

        // Reconnect WebSocket with new device name
        initWebSocket();
    });

    // Change PIN
    changePinBtn.addEventListener('click', async () => {
        const oldPin = oldPinInput.value.trim();
        const newPin = newPinInput.value.trim();

        if (!oldPin || !newPin) {
            showToast('Заполните оба поля PIN-кода', '⚠️');
            return;
        }

        try {
            const res = await authFetch('/api/settings/pin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ old_pin: oldPin, new_pin: newPin })
            });

            if (res.ok) {
                myAppPin = newPin;
                localStorage.setItem('airtransfer_pin', newPin);
                oldPinInput.value = '';
                newPinInput.value = '';
                showToast('PIN-код успешно обновлен!', '🔐');
            } else {
                const err = await res.json();
                showToast(err.detail || 'Ошибка смены PIN', '❌');
            }
        } catch {
            showToast('Ошибка при отправке запроса', '❌');
        }
    });

    // Fast save default recipient button in the header
    const saveDefaultBtn = document.getElementById('saveDefaultRecipientBtn');
    saveDefaultBtn.addEventListener('click', () => {
        const targetSelect = document.getElementById('targetDeviceSelect');
        defaultRecipient = targetSelect.value;
        localStorage.setItem('airtransfer_default_recipient', defaultRecipient);
        showToast(`Получатель по умолчанию: ${defaultRecipient}`, '⭐️');
    });
}

// Setup Event Listeners
function setupEvents() {
    // Tabs
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const target = document.getElementById(btn.dataset.tab);
            if (target) target.classList.add('active');
        });
    });

    // Dropzone & File Pickers
    const dropzone = document.getElementById('dropzone');
    const fileInputAll = document.getElementById('fileInputAll');
    const fileInputMedia = document.getElementById('fileInputMedia');

    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('drag-over');
    });

    ['dragleave', 'dragend'].forEach(eventName => {
        dropzone.addEventListener(eventName, () => {
            dropzone.classList.remove('drag-over');
        });
    });

    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('drag-over');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            uploadFiles(e.dataTransfer.files);
        }
    });

    fileInputAll.addEventListener('change', (e) => {
        uploadFiles(e.target.files);
    });

    fileInputMedia.addEventListener('change', (e) => {
        uploadFiles(e.target.files);
    });

    // Paste event (Ctrl + V anywhere to paste image or files)
    window.addEventListener('paste', (e) => {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        let filesToUpload = [];
        for (let item of items) {
            if (item.kind === 'file') {
                const blob = item.getAsFile();
                if (blob) filesToUpload.push(blob);
            }
        }
        if (filesToUpload.length > 0) {
            e.preventDefault();
            uploadFiles(filesToUpload);
            showToast('Скриншот / файл из буфера отправляется!', '📋');
        }
    });

    // Text Form Submission
    const textForm = document.getElementById('textForm');
    const textTitle = document.getElementById('textTitle');
    const textContent = document.getElementById('textContent');
    const pasteClipboardBtn = document.getElementById('pasteClipboardBtn');

    textForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = textTitle.value.trim();
        const content = textContent.value.trim();
        if (!content) return;

        const targetSelect = document.getElementById('targetDeviceSelect');
        const targetRecipient = targetSelect ? targetSelect.value : 'Всем';

        try {
            const res = await authFetch('/api/texts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: title,
                    content: content,
                    sender_device: myDeviceName,
                    target_device: targetRecipient
                })
            });

            if (res.ok) {
                textContent.value = '';
                textTitle.value = '';
                showToast(`Заметка сохранена для [${targetRecipient}]!`, '📝');
            } else if (res.status === 401) {
                showPinLockModal('Сессия истекла или неверный PIN');
            } else {
                showToast('Ошибка при сохранении текста', '❌');
            }
        } catch (err) {
            showToast('Сетевая ошибка', '❌');
        }
    });

    // Ctrl + Enter shortcut
    textContent.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            textForm.requestSubmit();
        }
    });

    // Paste from clipboard button
    pasteClipboardBtn.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                textContent.value = (textContent.value ? textContent.value + '\n' : '') + text;
                showToast('Текст вставлен из буфера', '📋');
                textContent.focus();
            }
        } catch {
            showToast('Разрешите доступ к буферу обмена в браузере', '⚠️');
        }
    });

    // Filters
    const filterBtns = document.querySelectorAll('.filter-btn');
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFilter = btn.dataset.filter;
            renderFeed();
        });
    });

    // Clear History Button
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');
    clearHistoryBtn.addEventListener('click', async () => {
        if (!confirm('Вы уверены, что хотите полностью очистить всю историю и файлы?')) return;
        try {
            await authFetch('/api/clear-history', { method: 'POST' });
        } catch {
            showToast('Ошибка при очистке', '❌');
        }
    });

    // Lightbox modal close
    document.getElementById('closeLightboxBtn').addEventListener('click', closeLightbox);
    document.getElementById('lightboxModal').addEventListener('click', (e) => {
        if (e.target.id === 'lightboxModal') closeLightbox();
    });
}

// App Initialization
window.addEventListener('DOMContentLoaded', () => {
    detectDevice();
    setupPinLock();
    setupSettingsModal();
    setupEvents();
    setupQrModal();

    // Verify PIN before initial load
    fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: myAppPin })
    }).then(res => {
        if (res.ok) {
            initWebSocket();
            loadInitialData();
        } else {
            showPinLockModal();
        }
    }).catch(() => {
        showPinLockModal();
    });
});

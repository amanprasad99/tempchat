
// TempChat Hyper-Interactive Client Application
const socket = io();

// State variables
let currentUsername = localStorage.getItem("tempchat_username") || "";
let currentAvatar = localStorage.getItem("tempchat_avatar") || "";
let currentRoom = "";
let currentPassword = "";
let roomExpiresAt = 0;
let roomTimerInterval = null;
let isHost = false;
let replyTarget = null; // { id, username, text }
let pendingAttachment = null; // { fileUrl, fileName, fileSize, mediaType }
let soundEnabled = true;

// Helper query selector
const $ = (id) => document.getElementById(id);

// --- WEB AUDIO SOUND SYNTHESIZER ---
const AudioFX = {
    ctx: null,
    init() {
        if (!this.ctx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) this.ctx = new AudioContext();
        }
    },
    playPop() {
        if (!soundEnabled) return;
        this.init();
        if (!this.ctx) return;
        try {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = "sine";
            osc.frequency.setValueAtTime(600, this.ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(800, this.ctx.currentTime + 0.08);
            gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.08);
            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start();
            osc.stop(this.ctx.currentTime + 0.08);
        } catch (e) {
            console.error("Audio error", e);
        }
    },
    playReceive() {
        if (!soundEnabled) return;
        this.init();
        if (!this.ctx) return;
        try {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = "sine";
            osc.frequency.setValueAtTime(400, this.ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(600, this.ctx.currentTime + 0.12);
            gain.gain.setValueAtTime(0.2, this.ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.12);
            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start();
            osc.stop(this.ctx.currentTime + 0.12);
        } catch (e) {
            console.error("Audio error", e);
        }
    }
};

// --- TOAST SYSTEM ---
function showToast(message, iconClass = "fa-solid fa-circle-info") {
    const container = $("toastContainer");
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<i class="${iconClass}"></i> <span>${escapeHTML(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(-10px)";
        toast.style.transition = "all 0.3s ease";
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// --- UTILITY FUNCTIONS ---
function escapeHTML(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function formatTime(timestamp) {
    const d = new Date(timestamp || Date.now());
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatFileSize(bytes) {
    if (!bytes) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function generateRandomAvatar() {
    const seed = "user_" + Math.random().toString(36).substring(2, 9);
    currentAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${seed}`;
    $("userAvatarPreview").src = currentAvatar;
    localStorage.setItem("tempchat_avatar", currentAvatar);
}

// Format links inside messages
function renderMessageText(text) {
    const escaped = escapeHTML(text);
    const urlPattern = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
    return escaped.replace(urlPattern, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color: #a5b4fc; text-decoration: underline;">$1</a>');
}

// --- COUNTDOWN TIMER ---
function startCountdownTimer(expiresAt) {
    roomExpiresAt = expiresAt;
    if (roomTimerInterval) clearInterval(roomTimerInterval);

    function updateTimer() {
        const remaining = Math.max(0, Math.floor((roomExpiresAt - Date.now()) / 1000));
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        
        $("roomTimerDisplay").textContent = formatted;

        if (remaining <= 0) {
            clearInterval(roomTimerInterval);
            showToast("Passcode and room session have expired.", "fa-solid fa-hourglass-end");
            setTimeout(() => {
                leaveChatRoom();
            }, 2000);
        }
    }

    updateTimer();
    roomTimerInterval = setInterval(updateTimer, 1000);
}

// --- VIEW NAVIGATION ---
function showSection(sectionId) {
    ["authSection", "passwordSection", "roomSection"].forEach(id => {
        $(id).classList.toggle("hidden", id !== sectionId);
    });
}

// --- INIT AVATAR & URL PARAMETER ---
function initApp() {
    if (currentUsername) {
        $("createUsername").value = currentUsername;
        $("joinUsername").value = currentUsername;
    }

    if (!currentAvatar) {
        generateRandomAvatar();
    } else {
        $("userAvatarPreview").src = currentAvatar;
    }

    // Check URL query parameters for passcode (e.g., ?pin=123456)
    const urlParams = new URLSearchParams(window.location.search);
    const pinParam = urlParams.get("pin") || window.location.hash.replace("#", "");

    if (pinParam && /^\d{6}$/.test(pinParam)) {
        $("joinPassword").value = pinParam;
        switchTab("join");
        showToast("Passcode pre-filled from invite link!", "fa-solid fa-link");
    }
}

// --- TAB SWITCHER ---
function switchTab(tab) {
    if (tab === "create") {
        $("tabCreateBtn").classList.add("active");
        $("tabJoinBtn").classList.remove("active");
        $("createForm").classList.remove("hidden");
        $("joinForm").classList.add("hidden");
    } else {
        $("tabJoinBtn").classList.add("active");
        $("tabCreateBtn").classList.remove("active");
        $("joinForm").classList.remove("hidden");
        $("createForm").classList.add("hidden");
    }
}

$("tabCreateBtn").addEventListener("click", () => switchTab("create"));
$("tabJoinBtn").addEventListener("click", () => switchTab("join"));
$("randomizeAvatarBtn").addEventListener("click", generateRandomAvatar);

// --- CREATE ROOM EVENT WITH DURATION ---
$("createForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = $("createUsername").value.trim();
    const durationMinutes = $("createDuration").value;
    if (!username) return showToast("Please enter a nickname.", "fa-solid fa-triangle-exclamation");

    currentUsername = username;
    localStorage.setItem("tempchat_username", currentUsername);

    try {
        const res = await fetch("/create-room", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, durationMinutes })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.message || "Error creating room", "fa-solid fa-circle-exclamation");

        currentRoom = data.roomId;
        currentPassword = data.password;
        roomExpiresAt = data.expiresAt;
        isHost = true;

        // Display Passcode, Expiry Notice & QR Code
        $("generatedPassword").textContent = currentPassword;
        const durText = data.durationMinutes >= 60 ? (data.durationMinutes / 60) + " hours" : data.durationMinutes + " mins";
        $("passcodeExpiryNotice").innerHTML = `<i class="fa-regular fa-clock"></i> Valid for ${durText}`;

        const shareUrl = `${window.location.origin}${window.location.pathname}?pin=${currentPassword}`;
        $("shareableLinkInput").value = shareUrl;

        // Generate QR code
        $("qrcode").innerHTML = "";
        new QRCode($("qrcode"), {
            text: shareUrl,
            width: 128,
            height: 128,
            colorDark: "#1e1b4b",
            colorLight: "#ffffff"
        });

        showSection("passwordSection");
    } catch (err) {
        console.error(err);
        showToast("Server connection failed.", "fa-solid fa-triangle-exclamation");
    }
});

// --- COPY PASSCODE & SHARE LINK ---
$("copyPasscodeBtn").addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(currentPassword);
        showToast("Passcode copied to clipboard!", "fa-solid fa-copy");
    } catch (e) {
        showToast("Passcode: " + currentPassword);
    }
});

$("copyShareLinkBtn").addEventListener("click", async () => {
    const link = $("shareableLinkInput").value;
    try {
        await navigator.clipboard.writeText(link);
        showToast("Invite link copied!", "fa-solid fa-link");
    } catch (e) {
        showToast("Copy failed.");
    }
});

$("headerPinBadge").addEventListener("click", async () => {
    if (currentPassword) {
        await navigator.clipboard.writeText(currentPassword);
        showToast("Room passcode copied!", "fa-solid fa-key");
    }
});

$("shareRoomBtn").addEventListener("click", async () => {
    const shareUrl = `${window.location.origin}${window.location.pathname}?pin=${currentPassword}`;
    try {
        await navigator.clipboard.writeText(shareUrl);
        showToast("Invite link copied to clipboard!", "fa-solid fa-share-nodes");
    } catch (e) {
        showToast(shareUrl);
    }
});

// --- ENTER CHAT ROOM ---
$("startChatBtn").addEventListener("click", () => {
    joinChatSession();
});

// --- JOIN ROOM EVENT ---
$("joinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = $("joinUsername").value.trim();
    const password = $("joinPassword").value.trim();

    if (!username || !password) return showToast("Enter nickname and 6-digit passcode.");
    if (!/^\d{6}$/.test(password)) return showToast("Passcode must be 6 digits.");

    currentUsername = username;
    localStorage.setItem("tempchat_username", currentUsername);

    try {
        const res = await fetch("/join-room", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.message || "Could not join room.", "fa-solid fa-circle-exclamation");

        currentRoom = data.roomId;
        currentPassword = password;
        isHost = false;

        joinChatSession();
    } catch (err) {
        console.error(err);
        showToast("Server connection failed.");
    }
});

function joinChatSession() {
    showSection("roomSection");
    $("roomPasswordDisplay").textContent = currentPassword;
    $("sidebarRoomId").textContent = currentRoom.slice(0, 8) + "...";
    $("messages").innerHTML = "";

    socket.emit("join-room", {
        roomId: currentRoom,
        username: currentUsername,
        password: currentPassword,
        avatar: currentAvatar
    });
}

// --- SOUND TOGGLE ---
$("toggleSoundBtn").addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    const icon = $("toggleSoundBtn").querySelector("i");
    icon.className = soundEnabled ? "fa-solid fa-volume-high" : "fa-solid fa-volume-xmark";
    showToast(soundEnabled ? "Audio FX unmuted" : "Audio FX muted");
});

// --- MEMBERS SIDEBAR TOGGLE ---
$("toggleMembersBtn").addEventListener("click", () => {
    $("membersSidebar").classList.toggle("active");
});
$("closeSidebarBtn").addEventListener("click", () => {
    $("membersSidebar").classList.remove("active");
});

// --- SOCKET EVENTS ---
socket.on("room-history", (data) => {
    isHost = data.isHost;
    $("nukeBtn").classList.toggle("hidden", !isHost);

    if (data.expiresAt) {
        startCountdownTimer(data.expiresAt);
    }

    if (data.messages && Array.isArray(data.messages)) {
        data.messages.forEach(msg => appendMessage(msg));
    }
});

socket.on("host-assigned", () => {
    isHost = true;
    $("nukeBtn").classList.remove("hidden");
    showToast("You are now the room host!", "fa-solid fa-crown");
});

socket.on("chat-message", (msgObj) => {
    appendMessage(msgObj);
    if (msgObj.username === currentUsername) {
        AudioFX.playPop();
    } else {
        AudioFX.playReceive();
    }
});

socket.on("system-message", (data) => {
    appendSystemNotice(data.text);
});

socket.on("room-users", (data) => {
    $("membersCountBadge").textContent = data.totalCount;
    renderMembersList(data.users);
});

socket.on("user-typing", (data) => {
    const indicator = $("typingIndicator");
    const textEl = $("typingText");
    const otherTyping = (data.typingUsers || []).filter(u => u !== currentUsername);

    if (otherTyping.length > 0) {
        indicator.classList.remove("hidden");
        textEl.textContent = `${otherTyping.join(", ")} ${otherTyping.length > 1 ? "are" : "is"} typing...`;
    } else {
        indicator.classList.add("hidden");
    }
});

socket.on("reaction-updated", ({ messageId, reactions }) => {
    const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
    if (!msgEl) return;
    const reactionsContainer = msgEl.querySelector(".reactions-list");
    if (reactionsContainer) {
        reactionsContainer.innerHTML = renderReactionsHTML(messageId, reactions);
    }
});

socket.on("room-expired", (data) => {
    alert(data.message || "Room passcode has expired.");
    leaveChatRoom();
});

socket.on("room-nuked", (data) => {
    alert(data.message || "Room destroyed by host.");
    leaveChatRoom();
});

socket.on("room-error", (msg) => {
    showToast(msg, "fa-solid fa-circle-exclamation");
});

// Leave Room helper function
function leaveChatRoom() {
    socket.emit("leave-room");
    if (roomTimerInterval) clearInterval(roomTimerInterval);
    currentRoom = "";
    currentPassword = "";
    showSection("authSection");
}

// --- RENDER MESSAGES ---
function appendSystemNotice(text) {
    const div = document.createElement("div");
    div.className = "system-msg";
    div.innerHTML = `<i class="fa-solid fa-shield-halved"></i> ${escapeHTML(text)}`;
    $("messages").appendChild(div);
    scrollToBottom();
}

function appendMessage(msg) {
    const isOutgoing = msg.username === currentUsername;
    const row = document.createElement("div");
    row.className = `chat-msg-row ${isOutgoing ? "outgoing" : "incoming"}`;
    row.setAttribute("data-msg-id", msg.id);

    let replyHTML = "";
    if (msg.replyTo) {
        replyHTML = `
            <div class="quoted-reply">
                <strong><i class="fa-solid fa-reply"></i> ${escapeHTML(msg.replyTo.username)}</strong>
                <span>${escapeHTML(msg.replyTo.text)}</span>
            </div>
        `;
    }

    let attachmentHTML = "";
    if (msg.attachment) {
        const att = msg.attachment;
        if (att.mediaType === "image") {
            attachmentHTML = `
                <div class="attachment-card">
                    <img src="${att.fileUrl}" alt="${escapeHTML(att.fileName)}" class="attachment-img" onclick="openLightbox('${att.fileUrl}', '${escapeHTML(att.fileName)}')">
                </div>
            `;
        } else if (att.mediaType === "video") {
            attachmentHTML = `
                <div class="attachment-card">
                    <video src="${att.fileUrl}" controls class="attachment-video"></video>
                </div>
            `;
        } else if (att.mediaType === "audio") {
            attachmentHTML = `
                <div class="attachment-card">
                    <audio src="${att.fileUrl}" controls class="attachment-audio"></audio>
                </div>
            `;
        } else {
            attachmentHTML = `
                <div class="attachment-card">
                    <a href="${att.fileUrl}" download="${escapeHTML(att.fileName)}" class="attachment-file-box" target="_blank">
                        <i class="fa-solid fa-file-arrow-down"></i>
                        <div>
                            <strong>${escapeHTML(att.fileName)}</strong>
                            <div style="font-size: 11px; opacity: 0.8;">${formatFileSize(att.fileSize)}</div>
                        </div>
                    </a>
                </div>
            `;
        }
    }

    const reactionsHTML = renderReactionsHTML(msg.id, msg.reactions);

    row.innerHTML = `
        <img src="${msg.avatar || 'https://api.dicebear.com/7.x/bottts/svg?seed=User'}" alt="${escapeHTML(msg.username)}" class="msg-avatar">
        <div class="msg-content-wrapper">
            <div class="msg-meta">
                <span class="msg-username">${escapeHTML(msg.username)}</span>
                <span class="msg-time">${formatTime(msg.timestamp)}</span>
            </div>
            <div class="msg-bubble">
                ${replyHTML}
                <div>${renderMessageText(msg.text)}</div>
                ${attachmentHTML}
                <div class="msg-actions">
                    <button class="action-icon-btn" onclick="setReply('${msg.id}', '${escapeHTML(msg.username)}', '${escapeHTML(msg.text || 'Attachment')}')" title="Reply">
                        <i class="fa-solid fa-reply"></i>
                    </button>
                    <button class="action-icon-btn" onclick="toggleReaction('${msg.id}', '❤️')" title="React ❤️">❤️</button>
                    <button class="action-icon-btn" onclick="toggleReaction('${msg.id}', '👍')" title="React 👍">👍</button>
                    <button class="action-icon-btn" onclick="toggleReaction('${msg.id}', '🔥')" title="React 🔥">🔥</button>
                </div>
            </div>
            <div class="reactions-list">${reactionsHTML}</div>
        </div>
    `;

    $("messages").appendChild(row);
    scrollToBottom();
}

function renderReactionsHTML(msgId, reactions) {
    if (!reactions) return "";
    let html = "";
    for (const [emoji, users] of Object.entries(reactions)) {
        if (users && users.length > 0) {
            html += `<span class="reaction-pill" onclick="toggleReaction('${msgId}', '${emoji}')">${emoji} ${users.length}</span>`;
        }
    }
    return html;
}

window.toggleReaction = function(msgId, emoji) {
    socket.emit("message-reaction", { messageId: msgId, emoji });
};

window.setReply = function(id, username, text) {
    replyTarget = { id, username, text };
    $("replyAuthor").textContent = username;
    $("replyTextSnippet").textContent = text.length > 40 ? text.slice(0, 40) + "..." : text;
    $("replyBar").classList.remove("hidden");
    $("messageInput").focus();
};

$("cancelReplyBtn").addEventListener("click", () => {
    replyTarget = null;
    $("replyBar").classList.add("hidden");
});

function scrollToBottom() {
    const el = $("messages");
    el.scrollTop = el.scrollHeight;
}

// --- MEMBER SIDEBAR ---
function renderMembersList(users) {
    const container = $("membersList");
    container.innerHTML = "";
    users.forEach(u => {
        const item = document.createElement("div");
        item.className = "member-item";
        item.innerHTML = `
            <img src="${u.avatar}" class="member-avatar" alt="${escapeHTML(u.username)}">
            <span class="member-name">${escapeHTML(u.username)}</span>
            ${u.isHost ? '<span class="host-badge">HOST</span>' : ''}
        `;
        container.appendChild(item);
    });
}

// --- SEND MESSAGE & TYPING EVENTS ---
let typingTimeout = null;

$("messageInput").addEventListener("input", () => {
    socket.emit("typing-start");
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit("typing-stop");
    }, 2000);
});

function sendMessage() {
    const input = $("messageInput");
    const text = input.value.trim();

    if (!text && !pendingAttachment) return;

    const payload = {
        text,
        attachment: pendingAttachment,
        replyTo: replyTarget
    };

    socket.emit("chat-message", payload);

    input.value = "";
    pendingAttachment = null;
    replyTarget = null;
    $("attachmentBar").classList.add("hidden");
    $("replyBar").classList.add("hidden");
    socket.emit("typing-stop");
}

$("sendBtn").addEventListener("click", sendMessage);
$("messageInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        sendMessage();
    }
});

// --- FILE UPLOAD & DRAG & DROP ---
$("attachFileBtn").addEventListener("click", () => $("fileInput").click());

$("fileInput").addEventListener("change", async () => {
    const file = $("fileInput").files[0];
    if (file) handleFileUpload(file);
});

async function handleFileUpload(file) {
    if (file.size > 20 * 1024 * 1024) {
        return showToast("File limit is 20MB.", "fa-solid fa-triangle-exclamation");
    }

    const formData = new FormData();
    formData.append("file", file);

    showToast("Uploading file...", "fa-solid fa-cloud-arrow-up");

    try {
        const res = await fetch("/upload", {
            method: "POST",
            body: formData
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.message || "Upload failed.");

        pendingAttachment = {
            fileUrl: data.fileUrl,
            fileName: data.fileName,
            fileSize: data.fileSize,
            mediaType: data.mediaType
        };

        $("attachmentName").textContent = data.fileName;
        $("attachmentSize").textContent = formatFileSize(data.fileSize);
        $("attachmentBar").classList.remove("hidden");
        $("fileInput").value = "";
        showToast("File ready to send!", "fa-solid fa-paperclip");
    } catch (err) {
        console.error(err);
        showToast("File upload failed.");
    }
}

$("removeAttachmentBtn").addEventListener("click", () => {
    pendingAttachment = null;
    $("attachmentBar").classList.add("hidden");
});

// Drag and drop overlay
const dropNotice = $("dragDropNotice");
window.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (currentRoom) dropNotice.classList.remove("hidden");
});

window.addEventListener("dragleave", (e) => {
    if (e.clientX === 0 && e.clientY === 0) {
        dropNotice.classList.add("hidden");
    }
});

window.addEventListener("drop", (e) => {
    e.preventDefault();
    dropNotice.classList.add("hidden");
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFileUpload(e.dataTransfer.files[0]);
    }
});

// --- EMOJI PICKER ---
$("emojiToggleBtn").addEventListener("click", () => {
    $("emojiPicker").classList.toggle("hidden");
});

document.querySelectorAll(".emoji-grid span").forEach(span => {
    span.addEventListener("click", () => {
        $("messageInput").value += span.textContent;
        $("emojiPicker").classList.add("hidden");
        $("messageInput").focus();
    });
});

// Close emoji picker when clicking outside
document.addEventListener("click", (e) => {
    if (!e.target.closest(".emoji-picker-container")) {
        $("emojiPicker").classList.add("hidden");
    }
});

// --- LIGHTBOX ---
window.openLightbox = function(url, caption) {
    $("lightboxImg").src = url;
    $("lightboxCaption").textContent = caption;
    $("lightboxModal").classList.remove("hidden");
};

$("closeLightbox").addEventListener("click", () => {
    $("lightboxModal").classList.add("hidden");
});

// --- HOST NUKE ROOM ---
$("nukeBtn").addEventListener("click", () => {
    if (confirm("Are you sure you want to NUKE and destroy this chat room for all participants?")) {
        socket.emit("nuke-room");
    }
});

// --- LEAVE ROOM ---
$("leaveBtn").addEventListener("click", () => {
    leaveChatRoom();
    showToast("You left the chat room.", "fa-solid fa-right-from-bracket");
});

// Initialize App
initApp();
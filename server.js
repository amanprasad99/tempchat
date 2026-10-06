
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 25 * 1024 * 1024 // 25MB for socket payloads
});

const PORT = process.env.PORT || 4000;
const rooms = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Serve uploads statically so images, videos, audio & files are accessible
app.use("/uploads", express.static(uploadDir));

// Multer storage with extension preservation
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, `${uniqueSuffix}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 } // 20MB limit
});

// Helper to sanitize text
function sanitize(str) {
    if (typeof str !== "string") return "";
    return str.trim();
}

// Create room and generate a unique 6-digit passcode with Expiration TTL
app.post("/create-room", async (req, res) => {
    try {
        const username = sanitize(req.body.username);
        let durationMinutes = parseInt(req.body.durationMinutes, 10);

        if (!username || username.length > 30) {
            return res.status(400).json({ message: "Please enter a valid nickname (1-30 characters)." });
        }

        // Default to 60 minutes if invalid duration passed
        if (isNaN(durationMinutes) || durationMinutes < 1 || durationMinutes > 10080) {
            durationMinutes = 60;
        }

        let password;
        let exists;

        do {
            password = String(crypto.randomInt(100000, 1000000));
            exists = false;

            for (const room of rooms.values()) {
                if (await bcrypt.compare(password, room.passwordHash)) {
                    exists = true;
                    break;
                }
            }
        } while (exists);

        const roomId = crypto.randomUUID();
        const passwordHash = await bcrypt.hash(password, 10);
        const createdAt = Date.now();
        const expiresAt = createdAt + (durationMinutes * 60 * 1000);

        rooms.set(roomId, {
            id: roomId,
            passwordHash,
            createdAt,
            expiresAt,
            durationMinutes,
            hostSocketId: null,
            members: new Map(), // socketId -> { username, avatar, joinedAt, isHost }
            messages: [],       // Array of recent messages
            typingUsers: new Set()
        });

        res.json({ roomId, password, expiresAt, durationMinutes });
    } catch (error) {
        console.error("Create room error:", error);
        res.status(500).json({ message: "Could not create room." });
    }
});

// Find room using passcode
app.post("/join-room", async (req, res) => {
    try {
        const username = sanitize(req.body.username);
        const password = sanitize(req.body.password);

        if (!username || username.length > 30 || !/^\d{6}$/.test(password)) {
            return res.status(400).json({
                message: "Please enter your nickname and a valid 6-digit passcode."
            });
        }

        for (const [roomId, room] of rooms.entries()) {
            if (await bcrypt.compare(password, room.passwordHash)) {
                // Check if passcode has expired
                if (Date.now() > room.expiresAt) {
                    return res.status(410).json({
                        message: "This room passcode has expired."
                    });
                }
                return res.json({ roomId });
            }
        }

        res.status(404).json({
            message: "Room not found. Please check your 6-digit passcode."
        });
    } catch (error) {
        console.error("Join room error:", error);
        res.status(500).json({ message: "Could not join room." });
    }
});

// File upload endpoint with rich metadata
app.post("/upload", upload.single("file"), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: "No file was selected." });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    const mimeType = req.file.mimetype || "";
    let mediaType = "file";

    if (mimeType.startsWith("image/")) mediaType = "image";
    else if (mimeType.startsWith("video/")) mediaType = "video";
    else if (mimeType.startsWith("audio/")) mediaType = "audio";

    res.json({
        fileUrl,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        mediaType,
        mimeType
    });
});

// Helper to broadcast room members list
function broadcastMemberList(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    const memberList = Array.from(room.members.values()).map(m => ({
        username: m.username,
        avatar: m.avatar,
        isHost: m.isHost,
        joinedAt: m.joinedAt
    }));

    io.to(roomId).emit("room-users", {
        users: memberList,
        totalCount: memberList.length
    });
}

// Background Task: Clean up expired rooms every 10 seconds
setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms.entries()) {
        if (now >= room.expiresAt) {
            io.to(roomId).emit("room-expired", {
                message: "Room timer expired. This session has ended and all messages have been destroyed."
            });
            io.in(roomId).socketsLeave(roomId);
            rooms.delete(roomId);
            console.log(`🧹 Room ${roomId} expired and wiped.`);
        }
    }
}, 10000);

// Socket chat events
io.on("connection", (socket) => {
    socket.on("join-room", async ({ roomId, username, password, avatar } = {}) => {
        const room = rooms.get(roomId);
        if (!room || !username || !password) {
            socket.emit("room-error", "Invalid room session.");
            return;
        }

        if (Date.now() > room.expiresAt) {
            socket.emit("room-error", "This room passcode has expired.");
            return;
        }

        const validPassword = await bcrypt.compare(password, room.passwordHash);
        if (!validPassword) {
            socket.emit("room-error", "Incorrect passcode for this room.");
            return;
        }

        // Leave previous room if needed
        const previousRoomId = socket.data.roomId;
        if (previousRoomId && previousRoomId !== roomId) {
            socket.leave(previousRoomId);
            const prevRoom = rooms.get(previousRoomId);
            if (prevRoom) {
                prevRoom.members.delete(socket.id);
                prevRoom.typingUsers.delete(socket.id);
                broadcastMemberList(previousRoomId);
            }
        }

        socket.join(roomId);
        const cleanName = String(username).slice(0, 30).trim();
        const userAvatar = avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(cleanName)}`;

        const isHost = room.members.size === 0;
        if (isHost) {
            room.hostSocketId = socket.id;
        }

        const memberInfo = {
            socketId: socket.id,
            username: cleanName,
            avatar: userAvatar,
            isHost,
            joinedAt: Date.now()
        };

        room.members.set(socket.id, memberInfo);

        socket.data.roomId = roomId;
        socket.data.username = cleanName;
        socket.data.avatar = userAvatar;
        socket.data.isHost = isHost;

        // Send existing room history & expiration timestamp to newly joined member
        socket.emit("room-history", {
            messages: room.messages,
            isHost,
            roomId,
            expiresAt: room.expiresAt,
            durationMinutes: room.durationMinutes
        });

        // Broadcast user joined
        socket.to(roomId).emit("system-message", {
            text: `${cleanName} joined the temp chat.`,
            timestamp: Date.now()
        });

        broadcastMemberList(roomId);
    });

    socket.on("chat-message", (data) => {
        const roomId = socket.data.roomId;
        const username = socket.data.username;
        const avatar = socket.data.avatar;

        if (!roomId || !rooms.has(roomId)) return;
        const room = rooms.get(roomId);

        if (Date.now() > room.expiresAt) {
            socket.emit("room-error", "Room passcode has expired.");
            return;
        }

        let text = "";
        let attachment = null;
        let replyTo = null;

        if (typeof data === "string") {
            text = data.trim();
        } else if (typeof data === "object" && data !== null) {
            text = sanitize(data.text);
            attachment = data.attachment || null;
            replyTo = data.replyTo || null;
        }

        if (!text && !attachment) return;
        if (text.length > 3000) return;

        const messageObj = {
            id: crypto.randomUUID(),
            socketId: socket.id,
            username,
            avatar,
            text,
            attachment,
            replyTo,
            reactions: {}, // { emoji: [usernames] }
            timestamp: Date.now()
        };

        // Buffer recent 100 messages
        room.messages.push(messageObj);
        if (room.messages.length > 100) room.messages.shift();

        // Clear typing status when message sent
        room.typingUsers.delete(socket.id);
        io.to(roomId).emit("user-typing", {
            typingUsers: Array.from(room.typingUsers).map(id => room.members.get(id)?.username).filter(Boolean)
        });

        io.to(roomId).emit("chat-message", messageObj);
    });

    // Typing Status
    socket.on("typing-start", () => {
        const roomId = socket.data.roomId;
        if (!roomId || !rooms.has(roomId)) return;
        const room = rooms.get(roomId);

        room.typingUsers.add(socket.id);
        socket.to(roomId).emit("user-typing", {
            typingUsers: Array.from(room.typingUsers).map(id => room.members.get(id)?.username).filter(Boolean)
        });
    });

    socket.on("typing-stop", () => {
        const roomId = socket.data.roomId;
        if (!roomId || !rooms.has(roomId)) return;
        const room = rooms.get(roomId);

        room.typingUsers.delete(socket.id);
        socket.to(roomId).emit("user-typing", {
            typingUsers: Array.from(room.typingUsers).map(id => room.members.get(id)?.username).filter(Boolean)
        });
    });

    // Message Reaction
    socket.on("message-reaction", ({ messageId, emoji }) => {
        const roomId = socket.data.roomId;
        const username = socket.data.username;
        if (!roomId || !rooms.has(roomId) || !messageId || !emoji) return;

        const room = rooms.get(roomId);
        const msg = room.messages.find(m => m.id === messageId);
        if (!msg) return;

        if (!msg.reactions) msg.reactions = {};
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

        const index = msg.reactions[emoji].indexOf(username);
        if (index > -1) {
            msg.reactions[emoji].splice(index, 1);
            if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
        } else {
            msg.reactions[emoji].push(username);
        }

        io.to(roomId).emit("reaction-updated", {
            messageId,
            reactions: msg.reactions
        });
    });

    // Host Nuke Room
    socket.on("nuke-room", () => {
        const roomId = socket.data.roomId;
        if (!roomId || !rooms.has(roomId)) return;
        const room = rooms.get(roomId);

        if (socket.id !== room.hostSocketId) {
            socket.emit("room-error", "Only the host can nuke this room.");
            return;
        }

        io.to(roomId).emit("room-nuked", {
            message: "The host has terminated and wiped this room."
        });

        // Clean up socket room and room map
        io.in(roomId).socketsLeave(roomId);
        rooms.delete(roomId);
    });

    // Leave Room
    socket.on("leave-room", () => {
        const roomId = socket.data.roomId;
        const username = socket.data.username;
        const room = rooms.get(roomId);

        if (room) {
            room.members.delete(socket.id);
            room.typingUsers.delete(socket.id);

            socket.to(roomId).emit("system-message", {
                text: `${username || "Someone"} left the chat.`,
                timestamp: Date.now()
            });

            if (room.members.size === 0) {
                rooms.delete(roomId);
            } else {
                // Transfer host if host left
                if (room.hostSocketId === socket.id) {
                    const firstMember = room.members.values().next().value;
                    if (firstMember) {
                        firstMember.isHost = true;
                        room.hostSocketId = firstMember.socketId;
                        io.to(firstMember.socketId).emit("host-assigned");
                    }
                }
                broadcastMemberList(roomId);
            }
        }

        if (roomId) socket.leave(roomId);
        delete socket.data.roomId;
        delete socket.data.username;
        delete socket.data.avatar;
    });

    socket.on("disconnect", () => {
        const roomId = socket.data.roomId;
        const username = socket.data.username;
        const room = rooms.get(roomId);

        if (!room) return;

        room.members.delete(socket.id);
        room.typingUsers.delete(socket.id);

        socket.to(roomId).emit("system-message", {
            text: `${username || "Someone"} disconnected.`,
            timestamp: Date.now()
        });

        if (room.members.size === 0) {
            rooms.delete(roomId);
        } else {
            if (room.hostSocketId === socket.id) {
                const firstMember = room.members.values().next().value;
                if (firstMember) {
                    firstMember.isHost = true;
                    room.hostSocketId = firstMember.socketId;
                    io.to(firstMember.socketId).emit("host-assigned");
                }
            }
            broadcastMemberList(roomId);
        }
    });
});

server.listen(PORT, () => {
    console.log(`⚡ TempChat Server running on http://localhost:${PORT}`);
});
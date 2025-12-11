require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const crypto = require("crypto");

// ---------------- FIREBASE INIT ----------------
const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!serviceAccountBase64) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_WPP_BASE64");

const serviceJson = JSON.parse(Buffer.from(serviceAccountBase64, "base64").toString("utf8"));

admin.initializeApp({
    credential: admin.credential.cert(serviceJson)
});

const db = admin.firestore();

// ---------------- APP INIT ----------------
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8000;

// ---------------- GLOBAL STORE FOR CLIENTS ----------------
const clients = {}; // userId -> WhatsApp Client

// ---------------- ENCRYPTION HELPER (SAME AS AI PROCESSOR) ----------------
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // 64 hex chars

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
        "aes-256-gcm",
        Buffer.from(ENCRYPTION_KEY, "hex"),
        iv
    );

    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag().toString("hex");

    return {
        encryptedBody: encrypted,
        iv: iv.toString("hex"),
        authTag
    };
}

// ---------------- CREATE CLIENT ----------------
async function createWhatsAppClient(userId, sessionName) {
    if (clients[userId]) return clients[userId]; // Already exists

    const client = new Client({
        puppeteer: { headless: true },
        authStrategy: new LocalAuth({ clientId: sessionName }),
    });

    clients[userId] = client;

    // ---------- QR EVENT ----------
    client.on("qr", async qr => {
        console.log(`QR for ${userId}`);

        // Convert QR to image (png base64)
        const qrImage = await qrcode.toDataURL(qr);

        // Upload to Firestore (whatsapp_sessions)
        await db.collection("whatsapp_sessions").doc(userId).set({
            sessionName,
            qr: qrImage,
            status: "qr",
            updatedAt: admin.firestore.Timestamp.now()
        }, { merge: true });

        console.log("QR uploaded in Firestore:", userId);
    });

    // ---------- READY EVENT ----------
    client.on("ready", async () => {
        console.log(`WhatsApp READY for userId = ${userId}`);

        await db.collection("whatsapp_sessions").doc(userId).set({
            status: "ready",
            qr: "",
            updatedAt: admin.firestore.Timestamp.now()
        }, { merge: true });
    });

    // ---------- MESSAGE EVENT ----------
    client.on("message", async (msg) => {
        try {
            console.log("Incoming message from:", msg.from, "UserId:", userId);

            const encryptedObj = encrypt(msg.body);

            await db.collection("raw_messages").add({
                from: msg.from,
                to: "agent",
                userId,
                messageBody: msg.body,
                encryptedBody: encryptedObj.encryptedBody,
                iv: encryptedObj.iv,
                authTag: encryptedObj.authTag,
                timestamp: admin.firestore.Timestamp.now(),
                processed: false,
                processing: false,
                replyPending: true,
                direction: "inbound"
            });

            console.log("Message stored & ready for AI:", msg.body);

        } catch (e) {
            console.error("Error saving inbound message:", e);
        }
    });

    // ---------- SEND OUTBOUND MESSAGES WHEN Firestore TRIGGERS ----------
    db.collection("raw_messages")
        .where("replyPending", "==", true)
        .where("userId", "==", userId)
        .onSnapshot(async snapshot => {
            for (const doc of snapshot.docs) {
                const data = doc.data();

                // ONLY send messages where `from == agent` OR auto replies produced by AI
                if (!data.to || !data.autoReplyText) continue;

                const chatId = data.to;
                const text = data.autoReplyText;

                try {
                    await client.sendMessage(chatId, text);
                    console.log("Sent outbound message:", text);

                    await doc.ref.update({
                        replyPending: false,
                        sentAt: admin.firestore.Timestamp.now()
                    });

                } catch (err) {
                    console.error("Failed sending message:", err.message);
                }
            }
        });

    client.initialize();
    return client;
}

// ---------------- REST API ----------------

// Create a new WhatsApp session
app.post("/create-session", async (req, res) => {
    const { userId } = req.body;

    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const sessionName = `session-${userId}`;

    await createWhatsAppClient(userId, sessionName);

    return res.json({ success: true, message: "Session initializing…" });
});

// Get WhatsApp QR
app.get("/qr/:userId", async (req, res) => {
    const { userId } = req.params;

    const doc = await db.collection("whatsapp_sessions").doc(userId).get();

    if (!doc.exists) return res.json({ qr: null, status: "no-session" });

    const data = doc.data();
    return res.json({
        qr: data.qr || null,
        status: data.status || "unknown"
    });
});

// Manual send (for debugging)
app.post("/send", async (req, res) => {
    const { userId, number, message } = req.body;

    if (!clients[userId]) return res.status(400).json({ error: "Session not active" });

    try {
        await clients[userId].sendMessage(`${number}@c.us`, message);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// App Start
app.listen(PORT, () => console.log(`WhatsApp server running on port ${PORT}`));

// web-whatsapp.js
// ZareaAI — Multi-user WhatsApp backend (Flood-Proof v6)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Client, LocalAuth } = require("whatsapp-web.js");
const admin = require("firebase-admin");

const PORT = process.env.PORT || 4000;
const RAW_MESSAGES_COLLECTION = "raw_messages";
const clients = {}; // { userId: clientInstance }

// -------------------------
// 🔥 FIREBASE INITIALIZATION
// -------------------------
let db;
let rawMessagesCollection;

async function initializeFirebase() {
  try {
    const base64Key = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!base64Key) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_BASE64");

    const decoded = Buffer.from(base64Key, "base64").toString("utf-8");
    const serviceAccount = JSON.parse(decoded);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    db = admin.firestore();
    rawMessagesCollection = db.collection(RAW_MESSAGES_COLLECTION);

    console.log("🔥 Firebase Admin Initialized");
  } catch (error) {
    console.error("❌ Firebase Init Error:", error.message);
    process.exit(1);
  }
}

// -------------------------
// 🔥 UPDATE WHATSAPP SESSION STATUS
// -------------------------
async function updateFirestoreStatus(userId, data) {
  try {
    if (!db) return;
    const doc = db.collection("whatsapp_sessions").doc(userId);
    await doc.set({ ...data, userId }, { merge: true });
    console.log(`✅ Updated session status → ${userId}`);
  } catch (err) {
    console.error("⚠️ Firestore Update Error:", err);
  }
}

// -------------------------
// 🔥 SAVE RAW MESSAGE
// -------------------------
async function saveRawMessage(msg, userId) {
  try {
    const data = {
      timestamp: admin.firestore.Timestamp.now(),
      userId,
      from: msg.from,
      to: msg.to,
      body: msg.body || null,
      type: msg.type,
      phoneNumber: msg.from.split("@")[0],
      wwebId: msg.id._serialized,
      isGroup: false, // ALWAYS false because group filtering done above
      processed: false,
      isLead: null,
      replyPending: false,
      autoReplyText: null,
    };

    const docRef = await rawMessagesCollection.add(data);
    console.log(`📩 [${userId}] Saved message → ${docRef.id.substring(0, 8)}...`);
  } catch (err) {
    console.error(`❌ Error saving message for ${userId}:`, err);
  }
}

// -------------------------
// 🤖 AI REPLY EXECUTOR WATCHER
// -------------------------
function startAiReplyExecutor() {
  if (!db) return;

  const q = db.collection(RAW_MESSAGES_COLLECTION).where("replyPending", "==", true);

  console.log("🤖 AI Reply Executor Started");

  q.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (!["added", "modified"].includes(change.type)) return;

      const doc = change.doc;
      const d = doc.data();

      if (!d.autoReplyText || !d.from || !d.userId) return;

      const client = clients[d.userId];
      if (!client) return;

      try {
        await client.sendMessage(d.from, d.autoReplyText);

        await doc.ref.update({
          replyPending: false,
          replySentAt: admin.firestore.Timestamp.now(),
        });

        console.log(`🤖 [${d.userId}] AI reply sent → ${doc.id}`);
      } catch (err) {
        console.error(`❌ Error sending AI reply (${doc.id}):`, err.message);
      }
    });
  });
}

// -------------------------
// 🔥 BULLETPROOF MESSAGE HANDLER
// -------------------------
async function handleInboundMessage(msg, userId) {
  try {
    const jid = msg.from || "";
    const body = msg.body?.trim() || "";

    // 1️⃣ BLOCK GROUPS / COMMUNITIES / CHANNELS / BROADCAST
    const isGroupLike =
      msg.isGroup ||
      jid.endsWith("@g.us") || // group
      jid.includes("community") ||
      jid.includes("@broadcast") ||
      jid.includes("newsletter") ||
      jid.includes("@temp");

    if (isGroupLike) {
      console.log(`🚫 [${userId}] Ignored GROUP-like → ${jid}`);
      return;
    }

    // 2️⃣ IGNORE SELF-MESSAGES (WhatsApp echo)
    if (msg.fromMe) {
      console.log(`⚠️ Ignored echo from self`);
      return;
    }

    // 3️⃣ IGNORE EMPTY / EMOJI / SPAMMY BODY
    if (!body || body.length < 1) {
      console.log(`⚠️ Ignored empty body`);
      return;
    }

    // 4️⃣ OPTIONAL: ignore media types
    if (["sticker", "location", "audio", "video", "image"].includes(msg.type)) {
      console.log(`⚠️ Skipped media message type=${msg.type}`);
      return;
    }

    // 5️⃣ VALID HUMAN DIRECT MESSAGE → SAVE
    await saveRawMessage(msg, userId);
  } catch (err) {
    console.error("❌ Inbound Handler Error:", err);
  }
}

// -------------------------
// 🔥 CLIENT EVENT LISTENERS
// -------------------------
function setupClientListeners(client, userId) {
  client.on("qr", (qr) => {
    updateFirestoreStatus(userId, {
      qr,
      connected: false,
      status: "awaiting_scan",
    });
    console.log(`🤖 [${userId}] QR Generated`);
  });

  client.on("ready", () => {
    const phone = client.info.wid.user;
    updateFirestoreStatus(userId, {
      qr: null,
      connected: true,
      status: "active",
      phoneNumber: phone,
    });
    console.log(`🎉 [${userId}] WhatsApp Ready (${phone})`);
  });

  client.on("message", async (msg) => {
    await handleInboundMessage(msg, userId);
  });

  client.on("disconnected", (reason) => {
    console.log(`🛑 [${userId}] Disconnected → ${reason}`);
    updateFirestoreStatus(userId, {
      connected: false,
      status: "disconnected",
    });
    delete clients[userId];
  });

  client.on("auth_failure", () => {
    updateFirestoreStatus(userId, {
      connected: false,
      status: "auth_failed",
    });
    console.log(`⚠️ [${userId}] AUTH FAILED`);
  });
}

// -------------------------
// 🔥 CREATE WHATSAPP CLIENT
// -------------------------
async function createClient(userId) {
  if (clients[userId]) return clients[userId];

  const fs = require("fs");
  const AUTH_PATH = process.env.WWEBJS_AUTH_DIR || "/app/data/.wwebjs_auth";

  if (!fs.existsSync(AUTH_PATH)) {
    fs.mkdirSync(AUTH_PATH, { recursive: true });
  }

  fs.chmodSync(AUTH_PATH, 0o777);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: userId,
      dataPath: AUTH_PATH,
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
      ],
    },
  });

  setupClientListeners(client, userId);

  try {
    await client.initialize();
    console.log(`🚀 Initialized WhatsApp → ${userId}`);
  } catch (err) {
    console.error(`❌ Error initializing client (${userId}):`, err);
    updateFirestoreStatus(userId, {
      status: "init_failed",
    });
  }

  clients[userId] = client;
  return client;
}

// -------------------------
// 🌍 EXPRESS SERVER
// -------------------------
const app = express();
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json());

// Start WhatsApp client
app.post("/start-whatsapp", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  await createClient(userId);
  res.json({ message: `Client started for ${userId}` });
});

// Disconnect client
app.post("/disconnect", async (req, res) => {
  const { userId } = req.body;
  if (!clients[userId]) return res.status(400).json({ error: "Not running" });

  await clients[userId].logout();
  delete clients[userId];

  res.json({ message: `Client ${userId} disconnected.` });
});

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ZareaAI WhatsApp Backend Running",
    activeClients: Object.keys(clients).length,
    timestamp: new Date().toISOString(),
  });
});

// -------------------------
// 🚀 FINAL INIT
// -------------------------
(async () => {
  await initializeFirebase();
  startAiReplyExecutor();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🌍 Server Running on port ${PORT}`);
  });
})();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'db.json');
let db = { users: {}, messages: [], updates: [] };

function loadDB() {
    if (fs.existsSync(DB_FILE)) {
        try {
            db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            for (let u in db.users) { db.users[u].online = false; }
        } catch (e) {
            console.error("Error reading DB, resetting.");
            resetDB();
        }
    } else {
        saveDB();
    }
}

function saveDB() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch(e) {
        console.error("Failed to write DB:", e);
    }
}

function resetDB() {
    db = { users: {}, messages: [], updates: [] };
    saveDB();
}

function generatePIN() {
    return Math.random().toString(16).substring(2, 10).toUpperCase();
}

function broadcastState() {
    const payload = JSON.stringify({
        type: 'STATE_UPDATE',
        users: db.users,
        messages: db.messages,
        updates: db.updates
    });
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

loadDB();

// Wipe Database Endpoint
app.post('/api/reset', (req, res) => {
    resetDB();
    broadcastState();
    res.json({ success: true, message: 'Database wiped successfully.' });
});

// Authentication & Registration API
app.post('/api/login', (req, res) => {
    const username = (req.body.username || '').trim();
    const authHash = req.body.authHash;
    const pubKey = req.body.pubKey;
    const statusMsg = req.body.statusMessage || 'Available';
    const avatar = req.body.avatar || '';

    if (!username || !authHash || !pubKey) {
        return res.status(400).json({ error: 'Username, password hash, and public key required' });
    }

    if (!db.users[username]) {
        // Register New User
        const pin = generatePIN();
        db.users[username] = {
            username,
            authHash,
            pubKey,
            pin,
            statusMessage: statusMsg,
            avatar,
            online: true,
            contacts: []
        };
        db.updates.unshift({
            id: Date.now(),
            user: username,
            text: `Joined network! (PIN: ${pin})`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
    } else {
        // Authenticate User
        if (db.users[username].authHash !== authHash) {
            return res.status(401).json({ error: 'Invalid credentials for ' + username });
        }
        db.users[username].online = true;
        db.users[username].pubKey = pubKey; // Refresh ECDH Session Key
        if (avatar) db.users[username].avatar = avatar;
        if (statusMsg && statusMsg !== db.users[username].statusMessage) {
            db.users[username].statusMessage = statusMsg;
            db.updates.unshift({
                id: Date.now(),
                user: username,
                text: `changed status to: "${statusMsg}"`,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        }
    }

    saveDB();
    broadcastState();
    res.json({ success: true, user: db.users[username] });
});

// Add Contact API
app.post('/api/add-contact', (req, res) => {
    const { username, pin } = req.body;
    const targetPin = (pin || '').trim().toUpperCase();

    if (!db.users[username]) return res.status(404).json({ error: 'User not found' });

    let targetUser = null;
    for (let u in db.users) {
        if (db.users[u].pin === targetPin) {
            targetUser = u;
            break;
        }
    }

    if (!targetUser) return res.status(404).json({ error: 'Invalid BBM PIN' });
    if (targetUser === username) return res.status(400).json({ error: 'Cannot add yourself' });

    if (!db.users[username].contacts.includes(targetUser)) db.users[username].contacts.push(targetUser);
    if (!db.users[targetUser].contacts.includes(username)) db.users[targetUser].contacts.push(username);

    saveDB();
    broadcastState();
    res.json({ success: true, added: targetUser });
});

// Polling Sync Fallback
app.get('/api/sync', (req, res) => {
    const { username } = req.query;
    if (username && db.users[username]) {
        db.users[username].online = true;
    }
    res.json({ users: db.users, messages: db.messages, updates: db.updates });
});

// Real-Time Encrypted WebSocket Relay
wss.on('connection', (ws) => {
    let currentUser = null;

    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);

            if (data.type === 'AUTH') {
                currentUser = data.username;
                if (db.users[currentUser]) {
                    db.users[currentUser].online = true;
                }
                broadcastState();
            } else if (data.type === 'SEND_MSG') {
                const msg = {
                    id: Date.now() + Math.random(),
                    sender: currentUser,
                    target: data.target,
                    ciphertext: data.ciphertext,
                    iv: data.iv,
                    isPing: !!data.isPing,
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    status: (db.users[data.target] && db.users[data.target].online) ? 'delivered' : 'sent'
                };
                db.messages.push(msg);
                saveDB();
                broadcastState();
            } else if (data.type === 'MARK_READ') {
                db.messages.forEach(m => {
                    if (m.target === currentUser && m.sender === data.sender && m.status !== 'read') {
                        m.status = 'read';
                    }
                });
                saveDB();
                broadcastState();
            }
        } catch (e) {
            console.error("WS Message Error:", e);
        }
    });

    ws.on('close', () => {
        if (currentUser && db.users[currentUser]) {
            db.users[currentUser].online = false;
            saveDB();
            broadcastState();
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[BBM Zero-Knowledge E2EE Engine] Running on port ${PORT}`);
});

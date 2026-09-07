const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Zero-Knowledge State (Server stores NO plaintext passwords or messages)
const state = {
    users: {},     // { username: { pin, pubKey, authHash, online, statusMessage, contacts: [] } }
    messages: [],  // [{ id, sender, target, ciphertext, iv, isPing, timestamp, status }]
    updates: []
};

function generatePIN() {
    return Math.random().toString(16).substring(2, 10).toUpperCase();
}

function broadcastState() {
    const payload = JSON.stringify({
        type: 'STATE_UPDATE',
        users: state.users,
        messages: state.messages,
        updates: state.updates
    });
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

// Authentication & Registration API
app.post('/api/login', (req, res) => {
    const { username, authHash, pubKey, statusMessage } = req.body;

    if (!username || !authHash || !pubKey) {
        return res.status(400).json({ error: 'Username, password hash, and public key required' });
    }

    if (!state.users[username]) {
        // Register User
        const pin = generatePIN();
        state.users[username] = {
            username,
            authHash,
            pubKey,
            pin,
            statusMessage: statusMessage || 'Available',
            online: true,
            contacts: []
        };
        state.updates.unshift({
            id: Date.now(),
            user: username,
            text: `Joined network (PIN: ${pin})`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
    } else {
        // Authenticate
        if (state.users[username].authHash !== authHash) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        state.users[username].online = true;
        state.users[username].pubKey = pubKey; // Refresh ECDH key session
        if (statusMessage) state.users[username].statusMessage = statusMessage;
    }

    broadcastState();
    res.json({ success: true, user: state.users[username] });
});

// Contact Pairing API
app.post('/api/add-contact', (req, res) => {
    const { username, pin } = req.body;
    const targetPin = (pin || '').trim().toUpperCase();

    if (!state.users[username]) return res.status(404).json({ error: 'User not found' });

    const targetUser = Object.keys(state.users).find(u => state.users[u].pin === targetPin);
    if (!targetUser) return res.status(404).json({ error: 'Invalid BBM PIN' });
    if (targetUser === username) return res.status(400).json({ error: 'Cannot add yourself' });

    if (!state.users[username].contacts.includes(targetUser)) state.users[username].contacts.push(targetUser);
    if (!state.users[targetUser].contacts.includes(username)) state.users[targetUser].contacts.push(username);

    broadcastState();
    res.json({ success: true, added: targetUser });
});

// Real-Time Encrypted WebSocket Relay
wss.on('connection', (ws) => {
    let currentUser = null;

    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);

            if (data.type === 'AUTH') {
                currentUser = data.username;
                if (state.users[currentUser]) state.users[currentUser].online = true;
                broadcastState();
            } else if (data.type === 'SEND_MSG') {
                // Relay encrypted payload (Zero-Knowledge)
                const msg = {
                    id: Date.now(),
                    sender: currentUser,
                    target: data.target,
                    ciphertext: data.ciphertext,
                    iv: data.iv,
                    isPing: !!data.isPing,
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    status: state.users[data.target]?.online ? 'delivered' : 'sent'
                };
                state.messages.push(msg);
                broadcastState();
            } else if (data.type === 'MARK_READ') {
                state.messages.forEach(m => {
                    if (m.target === currentUser && m.sender === data.sender) {
                        m.status = 'read';
                    }
                });
                broadcastState();
            }
        } catch (e) {
            console.error('WebSocket Error:', e);
        }
    });

    ws.on('close', () => {
        if (currentUser && state.users[currentUser]) {
            state.users[currentUser].online = false;
            broadcastState();
        }
    });
});

// Render Environment Binding
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[BBM Engine] Running on port ${PORT}`);
});

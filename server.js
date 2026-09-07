// server.js - Ultimate BBM Engine (ES5 Compliant Backend)
var express = require('express');
var http = require('http');
var WebSocket = require('ws');
var path = require('path');
var fs = require('fs');

var app = express();
var server = http.createServer(app);
var wss = new WebSocket.Server({ server: server });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

var DB_FILE = path.join(__dirname, 'db.json');
var db = { users: {}, messages: [], updates: [] };

function loadDB() {
    if (fs.existsSync(DB_FILE)) {
        try {
            db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            for (var u in db.users) { db.users[u].online = false; }
        } catch (e) {
            console.error("Error reading DB, resetting.");
            resetDB();
        }
    } else {
        saveDB();
    }
}

function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function resetDB() {
    db = { users: {}, messages: [], updates: [] };
    saveDB();
}

function generatePIN() {
    return Math.random().toString(16).substr(2, 8).toUpperCase();
}

function broadcastState() {
    var payload = JSON.stringify({
        type: 'STATE_UPDATE',
        users: db.users,
        messages: db.messages,
        updates: db.updates
    });
    wss.clients.forEach(function(client) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

loadDB();

// Reset DB API (For recovery when locked out)
app.post('/api/reset', function(req, res) {
    resetDB();
    broadcastState();
    res.json({ success: true, message: 'Database wiped successfully.' });
});

// Login / Register API
app.post('/api/login', function(req, res) {
    var username = (req.body.username || '').trim();
    var password = (req.body.password || '').trim();
    var statusMsg = req.body.statusMessage || 'Available';
    var avatar = req.body.avatar || '';

    if (!username || !password) {
        return res.status(400).json({ error: 'Username & Password required' });
    }

    if (!db.users[username]) {
        // Register new user
        var userPin = generatePIN();
        db.users[username] = {
            username: username,
            password: password,
            pin: userPin,
            statusMessage: statusMsg,
            avatar: avatar,
            online: true,
            contacts: []
        };
        db.updates.unshift({
            id: Date.now(),
            user: username,
            text: 'Is now a contact! (PIN: ' + userPin + ')',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
    } else {
        // Auth existing user
        if (db.users[username].password !== password) {
            return res.status(401).json({ error: 'Incorrect password for ' + username });
        }
        db.users[username].online = true;
        if (avatar) db.users[username].avatar = avatar;
        if (statusMsg && statusMsg !== db.users[username].statusMessage) {
            db.users[username].statusMessage = statusMsg;
            db.updates.unshift({
                id: Date.now(),
                user: username,
                text: 'changed status to: "' + statusMsg + '"',
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        }
    }

    saveDB();
    broadcastState();
    res.json({ success: true, user: db.users[username] });
});

// Add Contact by PIN
app.post('/api/add-contact', function(req, res) {
    var username = req.body.username;
    var targetPin = (req.body.pin || '').trim().toUpperCase();

    if (!db.users[username]) return res.status(404).json({ error: 'User not found' });

    var targetUser = null;
    for (var u in db.users) {
        if (db.users[u].pin === targetPin) {
            targetUser = u;
            break;
        }
    }

    if (!targetUser) return res.status(404).json({ error: 'Invalid BBM PIN' });
    if (targetUser === username) return res.status(400).json({ error: 'Cannot add yourself' });

    if (db.users[username].contacts.indexOf(targetUser) === -1) {
        db.users[username].contacts.push(targetUser);
    }
    if (db.users[targetUser].contacts.indexOf(username) === -1) {
        db.users[targetUser].contacts.push(username);
    }

    saveDB();
    broadcastState();
    res.json({ success: true, added: targetUser });
});

// Polling Sync Fallback for Curve 9360
app.get('/api/sync', function(req, res) {
    var username = req.query.username;
    if (username && db.users[username]) {
        db.users[username].online = true;
    }
    res.json({ users: db.users, messages: db.messages, updates: db.updates });
});

// WebSocket Handler
wss.on('connection', function(ws) {
    var currentUser = null;

    ws.on('message', function(raw) {
        try {
            var data = JSON.parse(raw);

            if (data.type === 'AUTH') {
                currentUser = data.username;
                if (db.users[currentUser]) {
                    db.users[currentUser].online = true;
                }
                broadcastState();
            } else if (data.type === 'SEND_MSG') {
                var msg = {
                    id: Date.now(),
                    sender: currentUser,
                    target: data.target,
                    text: data.text,
                    image: data.image || '',
                    isPing: data.isPing || false,
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    status: (db.users[data.target] && db.users[data.target].online) ? 'delivered' : 'sent'
                };
                db.messages.push(msg);
                saveDB();
                broadcastState();
            } else if (data.type === 'BROADCAST') {
                // BBM Broadcast message to all contacts
                var contacts = db.users[currentUser] ? db.users[currentUser].contacts : [];
                for (var i = 0; i < contacts.length; i++) {
                    db.messages.push({
                        id: Date.now() + i,
                        sender: currentUser,
                        target: contacts[i],
                        text: '[BROADCAST] ' + data.text,
                        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                        status: 'sent'
                    });
                }
                saveDB();
                broadcastState();
            } else if (data.type === 'MARK_READ') {
                for (var j = 0; j < db.messages.length; j++) {
                    var m = db.messages[j];
                    if (m.target === currentUser && m.sender === data.sender && m.status !== 'read') {
                        m.status = 'read';
                    }
                }
                saveDB();
                broadcastState();
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', function() {
        if (currentUser && db.users[currentUser]) {
            db.users[currentUser].online = false;
            saveDB();
            broadcastState();
        }
    });
});

var PORT = 8080;
server.listen(PORT, '0.0.0.0', function() {
    console.log('[BBM Engine v5] Running on http://0.0.0.0:' + PORT);
});

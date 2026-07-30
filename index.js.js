const express = require('express');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'apex_trading_secret_key_2026';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// SQLite Database Setup
const db = new sqlite3.Database('./apextrading.db', (err) => {
    if (err) console.error('Database connection error:', err.message);
    else console.log('Apex Trading DB Connected.');
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            real_balance REAL DEFAULT 0.00,
            demo_balance REAL DEFAULT 10000.00,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT CHECK(type IN ('DEPOSIT', 'WITHDRAWAL')) NOT NULL,
            amount REAL NOT NULL,
            status TEXT DEFAULT 'COMPLETED',
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    `);
});

// Middleware for Auth
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access token required' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    });
}

// REST Endpoints
app.post('/api/auth/signup', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(
            `INSERT INTO users (username, email, password) VALUES (?, ?, ?)`,
            [username, email, hashedPassword],
            function (err) {
                if (err) return res.status(400).json({ error: 'Username or email already exists' });
                const token = jwt.sign({ id: this.lastID, username, email }, JWT_SECRET, { expiresIn: '7d' });
                res.status(201).json({
                    token,
                    user: { id: this.lastID, username, email, real_balance: 0.00, demo_balance: 10000.00 }
                });
            }
        );
    } catch (e) {
        res.status(500).json({ error: 'Server error during registration' });
    }
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'Invalid credentials' });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                real_balance: user.real_balance,
                demo_balance: user.demo_balance
            }
        });
    });
});

app.get('/api/user/profile', authenticateToken, (req, res) => {
    db.get(`SELECT id, username, email, real_balance, demo_balance, created_at FROM users WHERE id = ?`, [req.user.id], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found' });
        res.json({ user });
    });
});

app.delete('/api/user/delete-account', authenticateToken, (req, res) => {
    db.serialize(() => {
        db.run(`DELETE FROM transactions WHERE user_id = ?`, [req.user.id]);
        db.run(`DELETE FROM users WHERE id = ?`, [req.user.id], function (err) {
            if (err) return res.status(500).json({ error: 'Failed to delete account' });
            res.json({ message: 'Account permanently deleted' });
        });
    });
});

app.post('/api/wallet/deposit', authenticateToken, (req, res) => {
    const { amount } = req.body;
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) return res.status(400).json({ error: 'Invalid deposit amount' });

    db.run(`UPDATE users SET real_balance = real_balance + ? WHERE id = ?`, [numAmount, req.user.id], function (err) {
        if (err) return res.status(500).json({ error: 'Deposit failed' });
        
        db.run(`INSERT INTO transactions (user_id, type, amount) VALUES (?, 'DEPOSIT', ?)`, [req.user.id, numAmount]);
        db.get(`SELECT real_balance FROM users WHERE id = ?`, [req.user.id], (e, row) => {
            res.json({ message: 'Deposit successful', real_balance: row.real_balance });
        });
    });
});

app.post('/api/wallet/withdraw', authenticateToken, (req, res) => {
    const { amount } = req.body;
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) return res.status(400).json({ error: 'Invalid withdrawal amount' });

    db.get(`SELECT real_balance FROM users WHERE id = ?`, [req.user.id], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found' });
        if (user.real_balance < numAmount) return res.status(400).json({ error: 'Insufficient real balance' });

        db.run(`UPDATE users SET real_balance = real_balance - ? WHERE id = ?`, [numAmount, req.user.id], function (err) {
            if (err) return res.status(500).json({ error: 'Withdrawal failed' });

            db.run(`INSERT INTO transactions (user_id, type, amount) VALUES (?, 'WITHDRAWAL', ?)`, [req.user.id, numAmount]);
            db.get(`SELECT real_balance FROM users WHERE id = ?`, [req.user.id], (e, row) => {
                res.json({ message: 'Withdrawal successful', real_balance: row.real_balance });
            });
        });
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`Apex Trading Server running on http://localhost:${PORT}`);
});
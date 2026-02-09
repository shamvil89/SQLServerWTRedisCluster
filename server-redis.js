require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const Redis = require('ioredis');

const app = express();
app.use(express.json());

const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    port: parseInt(process.env.DB_PORT),
    options: {
        encrypt: true,
        trustServerCertificate: true
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

// For Redis Cluster, use: new Redis.Cluster(['host:port', ...])
// For this demo, we'll try to connect to the nodes defined in .env
// If standard Redis, just use new Redis(port, host)
const redisNodes = process.env.REDIS_NODES ? process.env.REDIS_NODES.split(',') : [];
let redis;

if (redisNodes.length > 1) {
    console.log('Connecting to Redis Cluster...');
    redis = new Redis.Cluster(redisNodes);
} else {
    console.log('Connecting to Single Redis Node...');
    redis = new Redis(); // Defaults to localhost:6379
}

redis.on('error', (err) => console.error('Redis Client Error', err));
redis.on('connect', () => console.log('Connected to Redis'));

let pool;

async function startServer() {
    try {
        pool = await sql.connect(dbConfig);
        console.log('Connected to SQL Server');

        app.post('/ingest', async (req, res) => {
            try {
                const payload = JSON.stringify(req.body);
                // High-speed write to Redis List
                await redis.rpush('traffic_queue', payload);
                res.status(201).send('Queued');
            } catch (err) {
                console.error(err);
                res.status(500).send('Error');
            }
        });

        // Preload all rows from SQL into Redis at startup
        console.log('Preloading TrafficLogs into Redis...');
        const allRows = await pool.request()
            .query('SELECT id, payload, created_at FROM TrafficLogs');
        const rows = allRows.recordset;

        if (rows.length > 0) {
            const pipeline = redis.pipeline();
            for (const row of rows) {
                pipeline.set(`{logs}:${row.id}`, JSON.stringify(row));
            }
            await pipeline.exec();
        }

        const minId = rows.length > 0 ? rows[0].id : 1;
        const maxId = rows.length > 0 ? rows[rows.length - 1].id : 1;
        console.log(`Preloaded ${rows.length} rows into Redis (ID range: ${minId} - ${maxId})`);

        // PATCH /logs updates in Redis immediately, queues SQL update for the worker
        app.patch('/logs', async (req, res) => {
            try {
                const randomId = Math.floor(Math.random() * (maxId - minId + 1)) + minId;
                const cacheKey = `{logs}:${randomId}`;

                // Update Redis cache immediately
                const cached = await redis.get(cacheKey);
                if (cached) {
                    const updated = cached.replace(/test_load/g, 'test_loaded');
                    await redis.set(cacheKey, updated);
                }

                // Queue the SQL update for the worker to process later
                await redis.rpush('update_queue', JSON.stringify({ id: randomId }));

                res.status(200).send('Updated');
            } catch (err) {
                console.error(err);
                res.status(500).send('Error');
            }
        });

        // GET /logs reads entirely from Redis - no SQL on each request
        app.get('/logs', async (req, res) => {
            try {
                const randomId = Math.floor(Math.random() * (maxId - minId + 1)) + minId;
                const data = await redis.get(`{logs}:${randomId}`);
                if (data) {
                    return res.json(JSON.parse(data));
                }
                res.json({});
            } catch (err) {
                console.error(err);
                res.status(500).send('Error');
            }
        });

        const PORT = 3001; // Running on different port
        app.listen(PORT, () => {
            console.log(`Redis-backed Server listening on port ${PORT}`);
        });

    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

startServer();

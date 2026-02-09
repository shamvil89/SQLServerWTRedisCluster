require('dotenv').config();
const express = require('express');
const sql = require('mssql');

const app = express();
app.use(express.json());

const config = {
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

let pool;

async function startServer() {
    try {
        pool = await sql.connect(config);
        console.log('Connected to SQL Server');

        app.post('/ingest', async (req, res) => {
            try {
                const payload = JSON.stringify(req.body);
                // Simulate bottleneck: Direct synchronous insert
                await pool.request()
                    .input('payload', sql.NVarChar(sql.MAX), payload)
                    .query('INSERT INTO TrafficLogs (payload) VALUES (@payload)');
                
                res.status(201).send('Recorded');
            } catch (err) {
                console.error(err);
                res.status(500).send('Error');
            }
        });

        // Get ID range once at startup for random lookups
        const range = await pool.request()
            .query('SELECT MIN(id) AS minId, MAX(id) AS maxId FROM TrafficLogs');
        let { minId, maxId } = range.recordset[0];
        minId = minId || 1;
        maxId = maxId || 1;
        console.log(`ID range: ${minId} - ${maxId}`);

        app.patch('/logs', async (req, res) => {
            try {
                const randomId = Math.floor(Math.random() * (maxId - minId + 1)) + minId;
                await pool.request()
                    .input('id', sql.Int, randomId)
                    .query("UPDATE TrafficLogs SET payload = REPLACE(payload, 'test_load', 'test_loaded') WHERE id = @id");
                res.status(200).send('Updated');
            } catch (err) {
                console.error(err);
                res.status(500).send('Error');
            }
        });

        app.get('/logs', async (req, res) => {
            try {
                const randomId = Math.floor(Math.random() * (maxId - minId + 1)) + minId;
                const result = await pool.request()
                    .input('id', sql.Int, randomId)
                    .query('SELECT id, payload, created_at FROM TrafficLogs WHERE id = @id');
                res.json(result.recordset);
            } catch (err) {
                console.error(err);
                res.status(500).send('Error');
            }
        });

        const PORT = 3000;
        app.listen(PORT, () => {
            console.log(`Server listening on port ${PORT}`);
        });

    } catch (err) {
        console.error('Failed to connect to database:', err);
        process.exit(1);
    }
}

startServer();

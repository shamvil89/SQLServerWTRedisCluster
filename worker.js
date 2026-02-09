require('dotenv').config();
const sql = require('mssql');
const Redis = require('ioredis');

const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    port: parseInt(process.env.DB_PORT),
    options: {
        encrypt: true,
        trustServerCertificate: true
    }
};

const redisNodes = process.env.REDIS_NODES ? process.env.REDIS_NODES.split(',') : [];
let redis;

if (redisNodes.length > 1) {
    redis = new Redis.Cluster(redisNodes);
} else {
    redis = new Redis();
}

const BATCH_SIZE = 100;
const POLLING_INTERVAL = 100; // ms

async function startWorker() {
    try {
        const pool = await sql.connect(config);
        console.log('Worker connected to SQL Server');

        const processQueue = async () => {
            try {
                // Fetch up to BATCH_SIZE items
                // Note: lpop with count is available in Redis 6.2+. 
                // If using older redis, we might need a loop or pipeline.
                // We'll assume a loop/pipeline for compatibility or just standard lpop.
                
                // Using a pipeline to pop multiple items atomically-ish
                const pipeline = redis.pipeline();
                for(let i=0; i<BATCH_SIZE; i++) {
                    pipeline.lpop('traffic_queue');
                }
                const results = await pipeline.exec();
                
                // Filter out nulls (empty queue)
                const items = results.map(r => r[1]).filter(item => item !== null);

                if (items.length > 0) {
                    console.log(`Processing batch of ${items.length} items...`);
                    
                    // Bulk Insert
                    const table = new sql.Table('TrafficLogs');
                    table.create = false;
                    table.columns.add('payload', sql.NVarChar(sql.MAX), { nullable: true });
                    
                    items.forEach(item => {
                        table.rows.add(item);
                    });

                    const request = new sql.Request(pool);
                    await request.bulk(table);
                    
                    console.log('Batch inserted successfully.');
                    
                    // If we found a full batch, try again immediately
                    if (items.length === BATCH_SIZE) {
                        setImmediate(processQueue);
                        return;
                    }
                }
            } catch (err) {
                console.error('Worker error:', err);
            }
            
            // Wait before checking again
            setTimeout(processQueue, POLLING_INTERVAL);
        };

        const processUpdateQueue = async () => {
            try {
                const pipeline = redis.pipeline();
                for (let i = 0; i < BATCH_SIZE; i++) {
                    pipeline.lpop('update_queue');
                }
                const results = await pipeline.exec();

                const items = results.map(r => r[1]).filter(item => item !== null);

                if (items.length > 0) {
                    console.log(`Processing ${items.length} updates...`);

                    for (const item of items) {
                        const { id } = JSON.parse(item);
                        await pool.request()
                            .input('id', sql.Int, id)
                            .query("UPDATE TrafficLogs SET payload = REPLACE(payload, 'test_load', 'test_loaded') WHERE id = @id");
                    }

                    console.log('Updates applied successfully.');

                    if (items.length === BATCH_SIZE) {
                        setImmediate(processUpdateQueue);
                        return;
                    }
                }
            } catch (err) {
                console.error('Update worker error:', err);
            }

            setTimeout(processUpdateQueue, POLLING_INTERVAL);
        };

        processQueue();
        processUpdateQueue();

    } catch (err) {
        console.error('Failed to start worker:', err);
    }
}

startWorker();

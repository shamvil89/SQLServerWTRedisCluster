require('dotenv').config();
const sql = require('mssql');

const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    port: parseInt(process.env.DB_PORT),
    options: {
        encrypt: true, // Use this if you're on Windows Azure
        trustServerCertificate: true // Change to true for local dev / self-signed certs
    }
};

async function setup() {
    try {
        console.log(`Connecting to database ${config.database} on ${config.server}...`);
        const pool = await sql.connect(config);

        console.log('Dropping table if exists...');
        await pool.request().query(`
            IF OBJECT_ID('dbo.TrafficLogs', 'U') IS NOT NULL
                DROP TABLE dbo.TrafficLogs
        `);

        console.log('Creating table TrafficLogs...');
        await pool.request().query(`
            CREATE TABLE TrafficLogs (
                id INT IDENTITY(1,1) PRIMARY KEY,
                payload NVARCHAR(MAX),
                created_at DATETIME DEFAULT GETDATE()
            )
        `);

        console.log('Table created successfully.');
        await pool.close();
    } catch (err) {
        console.error('Error setting up database:', err);
        process.exit(1);
    }
}

setup();

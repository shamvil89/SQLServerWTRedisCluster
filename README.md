# Redis Cluster vs SQL Server Bottleneck Demo

This project demonstrates how a Redis Cluster can act as a high-speed write buffer to alleviate database bottlenecks during high-volume ingestion.

## Prerequisites

1.  **Node.js** (Installed)
2.  **SQL Server** (Local or Docker)
3.  **Redis Cluster** (Docker recommended)
4.  **Docker Desktop** (with WSL2 backend enabled)

## Setup

All commands below are meant to be run in **PowerShell** on Windows.

1.  **Configure Database:**
    Edit `.env` and set your SQL Server credentials.
    ```powershell
    notepad .env
    ```

2.  **Initialize Database:**
    Creates the `TrafficLogs` table.
    ```powershell
    node setup-db.js
    ```

3.  **Start Redis Cluster:**
    Using Docker Desktop (ensure WSL2 integration is enabled in Docker Desktop settings):
    ```powershell
    docker compose up -d redis-cluster
    ```
    *Wait about 30 seconds for the cluster to initialize.*

4.  **Disable Redis Protected Mode (required on Windows/Docker Desktop):**
    The Redis nodes run in protected mode by default, which blocks connections from the Windows host. Disable it on all 6 nodes:
    ```powershell
    docker exec redis-cluster-demo bash -c 'for port in 7000 7001 7002 7003 7004 7005; do redis-cli -p $port CONFIG SET protected-mode no; done'
    ```
    *You need to run this each time the container is recreated.*

5.  **Install Dependencies:**
    ```powershell
    npm install
    ```

## Configuring Benchmarks

All benchmark scripts are defined in `package.json` under `"scripts"`. The key autocannon flags are:

| Flag | Description | Example |
|------|-------------|---------|
| `-c` | Number of concurrent connections | `-c 100` |
| `-d` | Duration in seconds | `-d 10` |
| `-m` | HTTP method | `-m POST`, `-m PATCH` |
| `-b` | Request body (JSON string) | `-b '{"data":"test_load"}'` |
| `-H` | Request header | `-H "Content-Type: application/json"` |
| `-p` | Number of pipelining requests per connection | `-p 10` |
| `-w` | Number of worker threads | `-w 4` |
| `-t` | Connection timeout in seconds | `-t 30` |
| `-R` | Max requests per second (rate limiting) | `-R 5000` |
| `-a` | Total number of requests to send (instead of duration) | `-a 10000` |
| `-l` | Print latency table at the end | `-l` |
| `-j` | Output results as JSON | `-j` |
| `--on-port` | Start a command when autocannon begins | `--on-port "node server.js"` |

To adjust parameters, edit the scripts in `package.json`. For example, to run with 500 connections for 30 seconds, change `-c 100 -d 10` to `-c 500 -d 30` in the relevant script.

**Available benchmark scripts:**

| Script | Method | Target | Server |
|--------|--------|--------|--------|
| `npm run bench:slow` | POST | `/ingest` | Slow (port 3000) |
| `npm run bench:redis` | POST | `/ingest` | Redis (port 3001) |
| `npm run bench:get-slow` | GET | `/logs` | Slow (port 3000) |
| `npm run bench:get-redis` | GET | `/logs` | Redis (port 3001) |
| `npm run bench:patch-slow` | PATCH | `/logs` | Slow (port 3000) |
| `npm run bench:patch-redis` | PATCH | `/logs` | Redis (port 3001) |

## Scenario 1: The Bottleneck (Direct SQL)

In this scenario, the API waits for the SQL INSERT to complete before responding.

1.  **Start the Slow Server:**
    ```powershell
    node server-slow.js
    ```

2.  **Run Benchmark (New Terminal):**
    Simulate 100 concurrent connections (`-c 100`) for 10 seconds (`-d 10`), sending POST requests with a JSON body to the slow server.
    ```powershell
    npm run bench:slow
    ```
    *This runs: `autocannon -c 100 -d 10 -m POST -b '{"data":"test_load"}' -H "Content-Type: application/json" http://localhost:3000/ingest`*

    **Observe:** Low requests/sec, high latency.

## Scenario 2: The Solution (Redis Buffer)

In this scenario, the API pushes to Redis and responds immediately. A background worker batches writes to SQL.

1.  **Start the Fast Server:**
    ```powershell
    node server-redis.js
    ```

2.  **Start the Worker (New Terminal):**
    ```powershell
    node worker.js
    ```

3.  **Run Benchmark:**
    Same parameters as above (100 connections, 10 seconds, POST), but targeting the Redis-backed server.
    ```powershell
    npm run bench:redis
    ```
    *This runs: `autocannon -c 100 -d 10 -m POST -b '{"data":"test_load"}' -H "Content-Type: application/json" http://localhost:3001/ingest`*

    **Observe:** massively higher requests/sec, near-zero latency.

## Scenario 3: Read Performance (GET / SELECT)

Both servers expose a `GET /logs` endpoint that returns a random row from `TrafficLogs` by primary key. The slow server queries SQL every time; the Redis server reads directly from preloaded Redis keys.

1.  **Benchmark the Slow Server (Direct SQL SELECT):**
    With the slow server running (`node server-slow.js`):
    ```powershell
    npm run bench:get-slow
    ```
    *This runs: `autocannon -c 100 -d 10 http://localhost:3000/logs`*

    **Observe:** Every request hits SQL Server directly.

2.  **Benchmark the Redis Server (Cached Reads):**
    With the Redis server running (`node server-redis.js`):
    ```powershell
    npm run bench:get-redis
    ```
    *This runs: `autocannon -c 100 -d 10 http://localhost:3001/logs`*

    **Observe:** Most requests are served from Redis cache, resulting in significantly higher throughput and lower latency.

## Scenario 4: Update Performance (PATCH / UPDATE)

Both servers expose a `PATCH /logs` endpoint that picks a random row and replaces `test_load` with `test_loaded` in its payload. The slow server runs the UPDATE against SQL directly; the Redis server updates the Redis cache immediately and queues the SQL update for background processing.

1.  **Benchmark the Slow Server (Direct SQL UPDATE):**
    With the slow server running (`node server-slow.js`):
    ```powershell
    npm run bench:patch-slow
    ```
    *This runs: `autocannon -c 100 -d 10 -m PATCH http://localhost:3000/logs`*

    **Observe:** Every request blocks on a SQL UPDATE.

2.  **Benchmark the Redis Server (Redis + Queued UPDATE):**
    With the Redis server running (`node server-redis.js`):
    ```powershell
    npm run bench:patch-redis
    ```
    *This runs: `autocannon -c 100 -d 10 -m PATCH http://localhost:3001/logs`*

    **Observe:** Updates are applied to Redis instantly and the SQL write is deferred, resulting in much higher throughput.

## Notes

- **Data Persistence:** The `worker.js` ensures data eventually reaches SQL Server. It processes both the insert queue (`traffic_queue`) and the update queue (`update_queue`).
- **Scaling:** Redis Cluster allows you to scale writes horizontally across multiple nodes, whereas a single SQL Server instance eventually hits a hard write limit.

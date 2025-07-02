# HexBet API Setup

This API indexes events from a Roulette EVM smart contract using TypeORM and Express.

## Prerequisites

- Node.js (v18+)
- Access to an Ethereum RPC endpoint

## Installation

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables:
Create a `.env` file with the following variables:

```env
# Server Configuration
PORT=3000

# Database Configuration (SQLite)
DB_PATH=./hexbet.db

# Blockchain Configuration
RPC_URL=https://your-rpc-endpoint.com
CONTRACT_ADDRESS=0x4f270A38E2802f06FB3e8b88c1cd260C9AD7C167  # Optional - defaults to Roulette contract

# Environment
NODE_ENV=development
```

3. The SQLite database will be automatically created when you first run the application.

## Database Tables

The application will automatically create the following tables in the SQLite database:

- `bet_placed` - Stores BetPlaced events
- `bet_settled` - Stores BetSettled events  
- `bet_expired` - Stores BetExpired events
- `winnings_claimed` - Stores WinningsClaimed events

The SQLite database file will be created at `./hexbet.db` (or the path specified in `DB_PATH`).

## Running the Application

```bash
npm start
```

The SQLite database will be automatically created and initialized when you first run the application. The **continuous indexer will start automatically** and begin indexing events from the deployment block (25865165).

### Automatic Indexing

The indexer runs continuously in the background and:
- Starts from the deployment block automatically
- Polls for new blocks every 5 seconds
- Processes blocks in chunks of 100
- Maintains state of the last indexed block
- Handles errors gracefully and continues running

## API Endpoints

- `GET /status` - Health check endpoint
- `GET /latest-block` - Get the latest block number

### Continuous Indexer Endpoints

- `GET /indexer/status` - Get indexer status and progress
- `POST /indexer/start` - Start the continuous indexer
- `POST /indexer/stop` - Stop the continuous indexer
- `POST /indexer/backfill` - Backfill from a specific block
  - Body: `{ "fromBlock": 25865165 }` (optional, defaults to deployment block)

### Legacy Endpoints (for manual control)

- `POST /index-events` - Index events from a block range
  - Body: `{ "fromBlock": 1000, "toBlock": 2000 }`
- `POST /backfill-from-deployment` - Backfill all events from deployment
- `POST /backfill-recent` - Backfill recent blocks
  - Body: `{ "blocksBack": 1000 }` (optional, defaults to 1000)
- `POST /backfill-range` - Backfill specific block range
  - Body: `{ "fromBlock": 1000, "toBlock": 2000 }`
- `POST /test-deployment` - Test indexing around deployment block

## Event Indexing

The application indexes the following events from the Roulette contract:

- **BetPlaced**: When a user places a bet
- **BetSettled**: When a bet is settled with results
- **BetExpired**: When a bet expires
- **WinningsClaimed**: When a user claims their winnings

## Usage Example

1. Start the server (indexer starts automatically):
```bash
npm start
```

2. Check indexer status:
```bash
curl http://localhost:3000/indexer/status
```

3. If you need to backfill from deployment:
```bash
curl -X POST http://localhost:3000/indexer/backfill
```

4. Control the indexer:
```bash
# Stop the indexer
curl -X POST http://localhost:3000/indexer/stop

# Start the indexer
curl -X POST http://localhost:3000/indexer/start
```

5. Get the latest block number:
```bash
curl http://localhost:3000/latest-block
``` 
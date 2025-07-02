import { log } from "@sayukixbt/log";
import { loadEnv } from "./utils/loadEnv";
import express from "express";
import "reflect-metadata";
import { AppDataSource } from "./config/database";
import { EventIndexer } from "./services/EventIndexer";
import { BackfillService } from "./services/BackfillService";
import { ContinuousIndexer } from "./services/ContinuousIndexer";
import { ROULETTE_ADDRESS } from "./constants/blockchain";

// load the environment variables
loadEnv();

async function main() {
    const app = express();
    const PORT = process.env.PORT || 3000;

    // Initialize database connection
    try {
        await AppDataSource.initialize();
        log.info("Database connection established");
    } catch (error) {
        log.error("Error connecting to database:", error instanceof Error ? error.message : String(error));
        process.exit(1);
    }

    // Initialize event indexer if RPC URL is provided
    let eventIndexer: EventIndexer | null = null;
    let backfillService: BackfillService | null = null;
    let continuousIndexer: ContinuousIndexer | null = null;
    
    if (process.env.RPC_URL) {
        log.info(`RPC_URL: ${process.env.RPC_URL}`);
        log.info(`ROULETTE_ADDRESS constant: ${ROULETTE_ADDRESS}`);
        log.info(`CONTRACT_ADDRESS env var: ${process.env.CONTRACT_ADDRESS || 'not set'}`);
        
        // Use environment variable only if it's not the zero address
        const envContractAddress = process.env.CONTRACT_ADDRESS;
        const contractAddress = (envContractAddress && envContractAddress !== "0x0000000000000000000000000000000000000000") 
            ? envContractAddress 
            : ROULETTE_ADDRESS;
        
        log.info(`Using contract address: ${contractAddress}`);
        
        eventIndexer = new EventIndexer(
            process.env.RPC_URL,
            contractAddress
        );
        backfillService = new BackfillService(eventIndexer);
        continuousIndexer = new ContinuousIndexer(eventIndexer);
        log.info(`Event indexer, backfill service, and continuous indexer initialized for contract: ${contractAddress}`);
    } else {
        log.warn("RPC_URL not provided - event indexing will be disabled");
    }

    // Middleware
    app.use(express.json());

    // Start continuous indexer automatically
    if (continuousIndexer) {
        log.info("🚀 Starting continuous indexer automatically...");
        continuousIndexer.start().catch(error => {
            log.error("Failed to start continuous indexer:", error instanceof Error ? error.message : String(error));
        });
    }

    // Status endpoint
    app.get('/status', (req, res) => {
        res.status(200).json({ status: 'OK', message: 'Server is running' });
    });

    // Index events endpoint
    app.post('/index-events', async (req, res) => {
        if (!eventIndexer) {
            res.status(400).json({ 
                error: 'Event indexer not configured. Set RPC_URL and CONTRACT_ADDRESS environment variables.' 
            });
            return;
        }

        try {
            const { fromBlock, toBlock } = req.body;
            
            if (!fromBlock || !toBlock) {
                res.status(400).json({ 
                    error: 'fromBlock and toBlock are required' 
                });
                return;
            }

            await eventIndexer.indexEvents(parseInt(fromBlock), parseInt(toBlock));
            res.json({ success: true, message: 'Events indexed successfully' });
        } catch (error) {
            log.error("Error indexing events:", error instanceof Error ? error.message : String(error));
            res.status(500).json({ error: 'Failed to index events' });
        }
    });

    // Get latest block endpoint
    app.get('/latest-block', async (req, res) => {
        if (!eventIndexer) {
            res.status(400).json({ 
                error: 'Event indexer not configured' 
            });
            return;
        }

        try {
            const latestBlock = await eventIndexer.getLatestBlockNumber();
            res.json({ latestBlock });
        } catch (error) {
            log.error("Error getting latest block:", error instanceof Error ? error.message : String(error));
            res.status(500).json({ error: 'Failed to get latest block' });
        }
    });

    // Backfill from deployment endpoint
    app.post('/backfill-from-deployment', async (req, res) => {
        if (!backfillService) {
            res.status(400).json({ 
                error: 'Backfill service not configured' 
            });
            return;
        }

        try {
            // Start backfill in background
            backfillService.backfillFromDeployment().catch(error => {
                log.error("Backfill error:", error instanceof Error ? error.message : String(error));
            });
            
            res.json({ 
                success: true, 
                message: 'Backfill from deployment started in background' 
            });
        } catch (error) {
            log.error("Error starting backfill:", error instanceof Error ? error.message : String(error));
            res.status(500).json({ error: 'Failed to start backfill' });
        }
    });

    // Backfill recent blocks endpoint
    app.post('/backfill-recent', async (req, res) => {
        if (!backfillService) {
            res.status(400).json({ 
                error: 'Backfill service not configured' 
            });
            return;
        }

        try {
            const { blocksBack = 1000 } = req.body;
            
            // Start backfill in background
            backfillService.backfillRecentBlocks(blocksBack).catch(error => {
                log.error("Backfill error:", error instanceof Error ? error.message : String(error));
            });
            
            res.json({ 
                success: true, 
                message: `Backfill of recent ${blocksBack} blocks started in background` 
            });
        } catch (error) {
            log.error("Error starting backfill:", error instanceof Error ? error.message : String(error));
            res.status(500).json({ error: 'Failed to start backfill' });
        }
    });

    // Backfill specific range endpoint
    app.post('/backfill-range', async (req, res) => {
        if (!backfillService) {
            res.status(400).json({ 
                error: 'Backfill service not configured' 
            });
            return;
        }

        try {
            const { fromBlock, toBlock } = req.body;
            
            if (!fromBlock || !toBlock) {
                res.status(400).json({ 
                    error: 'fromBlock and toBlock are required' 
                });
                return;
            }

            // Start backfill in background
            backfillService.backfillEvents(parseInt(fromBlock), parseInt(toBlock)).catch(error => {
                log.error("Backfill error:", error instanceof Error ? error.message : String(error));
            });
            
            res.json({ 
                success: true, 
                message: `Backfill from block ${fromBlock} to ${toBlock} started in background` 
            });
        } catch (error) {
            log.error("Error starting backfill:", error instanceof Error ? error.message : String(error));
            res.status(500).json({ error: 'Failed to start backfill' });
        }
    });

    // Test deployment block endpoint
    app.post('/test-deployment', async (req, res) => {
        if (!eventIndexer) {
            res.status(400).json({ 
                error: 'Event indexer not configured' 
            });
            return;
        }

        try {
            const { ROULETTE_DEPLOYMENT_BLOCK } = await import('./constants/blockchain');
            const testFromBlock = ROULETTE_DEPLOYMENT_BLOCK;
            const testToBlock = ROULETTE_DEPLOYMENT_BLOCK + 100; // Test 100 blocks after deployment
            
            log.info(`🧪 Testing deployment block range: ${testFromBlock}-${testToBlock}`);
            
            // Test indexing in foreground to see results immediately
            await eventIndexer.indexEvents(testFromBlock, testToBlock);
            
            res.json({ 
                success: true, 
                message: `Test completed for blocks ${testFromBlock}-${testToBlock}` 
            });
        } catch (error) {
            log.error("Error testing deployment:", error instanceof Error ? error.message : String(error));
            res.status(500).json({ error: 'Failed to test deployment' });
        }
    });

    // Test recent blocks endpoint
    app.post('/test-recent', async (req, res) => {
        if (!eventIndexer) {
            res.status(400).json({ 
                error: 'Event indexer not configured' 
            });
            return;
        }

        try {
            const latestBlock = await eventIndexer.getLatestBlockNumber();
            const testFromBlock = latestBlock - 1000; // Test last 1000 blocks
            const testToBlock = latestBlock;
            
            log.info(`🧪 Testing recent block range: ${testFromBlock}-${testToBlock}`);
            
            // Test indexing in foreground to see results immediately
            await eventIndexer.indexEvents(testFromBlock, testToBlock);
            
            res.json({ 
                success: true, 
                message: `Test completed for blocks ${testFromBlock}-${testToBlock}` 
            });
        } catch (error) {
            log.error("Error testing recent blocks:", error instanceof Error ? error.message : String(error));
            res.status(500).json({ error: 'Failed to test recent blocks' });
        }
    });

    // Continuous indexer control endpoints
    app.get('/indexer/status', async (req, res) => {
        if (!continuousIndexer) {
            res.status(400).json({ 
                error: 'Continuous indexer not configured' 
            });
            return;
        }

        try {
            const status = await continuousIndexer.getStatus();
            res.json(status);
        } catch (error) {
            log.error("Error getting indexer status:", error instanceof Error ? error.message : String(error));
            res.status(500).json({ error: 'Failed to get indexer status' });
        }
    });

    app.post('/indexer/start', async (req, res) => {
        if (!continuousIndexer) {
            res.status(400).json({ 
                error: 'Continuous indexer not configured' 
            });
            return;
        }

        try {
            await continuousIndexer.start();
            res.json({ 
                success: true, 
                message: 'Continuous indexer started' 
            });
        } catch (error) {
            log.error("Error starting indexer:", error instanceof Error ? error.message : String(error));
            res.status(500).json({ error: 'Failed to start indexer' });
        }
    });

    app.post('/indexer/stop', async (req, res) => {
        if (!continuousIndexer) {
            res.status(400).json({ 
                error: 'Continuous indexer not configured' 
            });
            return;
        }

        try {
            await continuousIndexer.stop();
            res.json({ 
                success: true, 
                message: 'Continuous indexer stopped' 
            });
        } catch (error) {
            log.error("Error stopping indexer:", error instanceof Error ? error.message : String(error));
            res.status(500).json({ error: 'Failed to stop indexer' });
        }
    });

    app.post('/indexer/backfill', async (req, res) => {
        if (!continuousIndexer) {
            res.status(400).json({ 
                error: 'Continuous indexer not configured' 
            });
            return;
        }

        try {
            const { fromBlock } = req.body;
            const { ROULETTE_DEPLOYMENT_BLOCK } = await import('./constants/blockchain');
            const startBlock = fromBlock || ROULETTE_DEPLOYMENT_BLOCK;
            
            // Start backfill in background
            continuousIndexer.backfillFromBlock(startBlock).catch(error => {
                log.error("Backfill error:", error instanceof Error ? error.message : String(error));
            });
            
            res.json({ 
                success: true, 
                message: `Backfill from block ${startBlock} started in background` 
            });
        } catch (error) {
            log.error("Error starting backfill:", error instanceof Error ? error.message : String(error));
            res.status(500).json({ error: 'Failed to start backfill' });
        }
    });

    // Debug endpoint to test contract connection
    app.get('/debug/contract', async (req, res) => {
        if (!eventIndexer) {
            res.status(400).json({ 
                error: 'Event indexer not configured' 
            });
            return;
        }

        try {
            const contract = eventIndexer['contract'];
            const provider = eventIndexer['provider'];
            
            // Test basic contract calls
            const latestBlock = await provider.getBlockNumber();
            const contractAddress = await contract.getAddress();
            
            // Try to get some basic contract info
            const { ROULETTE_DEPLOYMENT_BLOCK } = await import('./constants/blockchain');
            const contractInfo: Record<string, unknown> = {
                address: contractAddress,
                latestBlock,
                deploymentBlock: ROULETTE_DEPLOYMENT_BLOCK,
                provider: (provider as { connection?: { url: string } }).connection?.url || 'unknown'
            };

            // Test if we can call a simple view function
            try {
                const bettingToken = await contract.bettingToken();
                (contractInfo as Record<string, unknown>).bettingToken = bettingToken;
            } catch (error) {
                log.warn("Could not call bettingToken():", error instanceof Error ? error.message : String(error));
            }

            res.json({
                success: true,
                contractInfo,
                message: 'Contract connection test completed'
            });
        } catch (error) {
            log.error("Error testing contract:", error instanceof Error ? error.message : String(error));
            res.status(500).json({ 
                error: 'Failed to test contract',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    // Start server
    app.listen(PORT, () => {
        log.info(`Server is running on port ${PORT}`);
    });
}

main();

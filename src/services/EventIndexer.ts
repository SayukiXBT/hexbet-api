/* eslint-disable @typescript-eslint/no-explicit-any */
import { ethers } from "ethers";
import { AppDataSource } from "../config/database";
import { BetPlaced } from "../entities/BetPlaced";
import { BetSettled } from "../entities/BetSettled";
import { BetExpired } from "../entities/BetExpired";
import { WinningsClaimed } from "../entities/WinningsClaimed";
import { log } from "@sayukixbt/log";
import { ROULETTE_ADDRESS } from "../constants/blockchain";

// Import the ABI
import rouletteABI from "../abi/Roulette.json";

export class EventIndexer {
    private provider: ethers.Provider;
    private contract: ethers.Contract;
    private betPlacedRepository = AppDataSource.getRepository(BetPlaced);
    private betSettledRepository = AppDataSource.getRepository(BetSettled);
    private betExpiredRepository = AppDataSource.getRepository(BetExpired);
    private winningsClaimedRepository = AppDataSource.getRepository(WinningsClaimed);
    private chunkSize: number = 100; // Use 100 blocks per chunk for all queries
    private maxRetries: number = 5;
    private baseDelay: number = 1000; // 1 second base delay

    constructor(
        rpcUrl: string,
        contractAddress: string = ROULETTE_ADDRESS
    ) {
        log.info(`🔗 Initializing EventIndexer with RPC: ${rpcUrl}`);
        this.provider = new ethers.JsonRpcProvider(rpcUrl);
        this.contract = new ethers.Contract(contractAddress, rouletteABI.abi, this.provider);
        log.info(`EventIndexer initialized for contract: ${contractAddress}`);
        
        // Test the connection
        this.testConnection();
    }

    async indexEvents(fromBlock: number, toBlock: number) {
        try {
            log.info(`Indexing events from block ${fromBlock} to ${toBlock}`);

            // Index BetPlaced events
            await this.indexBetPlacedEvents(fromBlock, toBlock);

            // Index BetSettled events
            await this.indexBetSettledEvents(fromBlock, toBlock);

            // Index BetExpired events
            await this.indexBetExpiredEvents(fromBlock, toBlock);

            // Index WinningsClaimed events
            await this.indexWinningsClaimedEvents(fromBlock, toBlock);

            log.info(`Successfully indexed events from block ${fromBlock} to ${toBlock}`);
        } catch (error) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            log.error("Error indexing events:", error as any);
            throw error;
        }
    }

    private async indexBetPlacedEvents(fromBlock: number, toBlock: number) {
        log.info(`🔍 Querying BetPlaced events from block ${fromBlock} to ${toBlock}`);
        
        try {
            // Test the filter first
            const filter = this.contract.filters.BetPlaced();
            
            const events = await this.retryWithBackoff(async () => {
                return await this.contract.queryFilter(filter, fromBlock, toBlock);
            });

            log.info(`Found ${events.length} BetPlaced events in block range ${fromBlock}-${toBlock}`);

            // Log first few events for debugging
            if (events.length > 0) {
                log.info(events);
            }

            let indexedCount = 0;
            for (const event of events) {
                if ('args' in event && event.args) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const args = event.args as any;
                    const existing = await this.betPlacedRepository.findOne({
                        where: {
                            user: args.user,
                            betIndex: args.betIndex.toString(),
                            transactionHash: event.transactionHash
                        }
                    });

                    if (!existing) {
                        const betPlaced = new BetPlaced();
                        betPlaced.user = args.user;
                        betPlaced.betIndex = args.betIndex.toString();
                        betPlaced.guess = args.guess.toString(); // Convert BigInt to string
                        betPlaced.wager = args.wager.toString();
                        betPlaced.targetBlock = args.targetBlock.toString();
                        betPlaced.transactionHash = event.transactionHash;
                        betPlaced.blockNumber = event.blockNumber;

                        await this.betPlacedRepository.save(betPlaced);
                        indexedCount++;
                        log.info(`✅ Indexed BetPlaced event: User ${args.user} bet ${args.betIndex} guess ${args.guess.toString()} for ${args.wager.toString()} tokens`);
                    } else {
                        log.debug(`⏭️  Skipped existing BetPlaced event: ${event.transactionHash}`);
                    }
                }
            }
            
            if (indexedCount > 0) {
                log.info(`📊 Indexed ${indexedCount} new BetPlaced events`);
            }
        } catch (error) {
            log.error(`❌ Error querying BetPlaced events:`, error instanceof Error ? error.message : String(error));
            throw error;
        }
    }

    private async indexBetSettledEvents(fromBlock: number, toBlock: number) {
        const events = await this.retryWithBackoff(async () => {
            return await this.contract.queryFilter(
                this.contract.filters.BetSettled(),
                fromBlock,
                toBlock
            );
        });

        log.info(`Found ${events.length} BetSettled events in block range ${fromBlock}-${toBlock}`);

        let indexedCount = 0;
        for (const event of events) {
            if ('args' in event && event.args) {
                const args = event.args as any;
                const existing = await this.betSettledRepository.findOne({
                    where: {
                        user: args.user,
                        betIndex: args.betIndex.toString(),
                        transactionHash: event.transactionHash
                    }
                });

                if (!existing) {
                    const betSettled = new BetSettled();
                    betSettled.user = args.user;
                    betSettled.betIndex = args.betIndex.toString();
                    betSettled.won = args.won;
                    betSettled.firstHex = args.firstHex.toString(); // Convert BigInt to string
                    betSettled.secondHex = args.secondHex.toString(); // Convert BigInt to string
                    betSettled.payout = args.payout.toString();
                    betSettled.transactionHash = event.transactionHash;
                    betSettled.blockNumber = event.blockNumber;

                    await this.betSettledRepository.save(betSettled);
                    indexedCount++;
                    const result = args.won ? "WON" : "LOST";
                    log.info(`🎯 Indexed BetSettled event: User ${args.user} ${result} bet ${args.betIndex} - Hex: ${args.firstHex.toString()},${args.secondHex.toString()} - Payout: ${args.payout.toString()} tokens`);
                } else {
                    log.debug(`⏭️  Skipped existing BetSettled event: ${event.transactionHash}`);
                }
            }
        }
        
        if (indexedCount > 0) {
            log.info(`📊 Indexed ${indexedCount} new BetSettled events`);
        }
    }

    private async indexBetExpiredEvents(fromBlock: number, toBlock: number) {
        const events = await this.retryWithBackoff(async () => {
            return await this.contract.queryFilter(
                this.contract.filters.BetExpired(),
                fromBlock,
                toBlock
            );
        });

        for (const event of events) {
            if ('args' in event && event.args) {
                const args = event.args as any;
                const existing = await this.betExpiredRepository.findOne({
                    where: {
                        betId: args.betId.toString(),
                        transactionHash: event.transactionHash
                    }
                });

                if (!existing) {
                    const betExpired = new BetExpired();
                    betExpired.betId = args.betId.toString();
                    betExpired.user = args.user;
                    betExpired.amount = args.amount.toString();
                    betExpired.betType = args.betType.toString(); // Convert BigInt to string
                    betExpired.transactionHash = event.transactionHash;
                    betExpired.blockNumber = event.blockNumber;

                    await this.betExpiredRepository.save(betExpired);
                    log.debug(`⏰ Indexed BetExpired event: User ${args.user} bet ${args.betId} type ${args.betType.toString()} expired - Refund: ${args.amount.toString()} tokens`);
                }
            }
        }
    }

    private async indexWinningsClaimedEvents(fromBlock: number, toBlock: number) {
        const events = await this.retryWithBackoff(async () => {
            return await this.contract.queryFilter(
                this.contract.filters.WinningsClaimed(),
                fromBlock,
                toBlock
            );
        });

        for (const event of events) {
            if ('args' in event && event.args) {
                const args = event.args as any;
                const existing = await this.winningsClaimedRepository.findOne({
                    where: {
                        user: args.user,
                        transactionHash: event.transactionHash
                    }
                });

                if (!existing) {
                    const winningsClaimed = new WinningsClaimed();
                    winningsClaimed.user = args.user;
                    winningsClaimed.amount = args.amount.toString();
                    winningsClaimed.transactionHash = event.transactionHash;
                    winningsClaimed.blockNumber = event.blockNumber;

                    await this.winningsClaimedRepository.save(winningsClaimed);
                    log.debug(`Indexed WinningsClaimed event: ${event.transactionHash}`);
                }
            }
        }
    }

    async getLatestBlockNumber(): Promise<number> {
        return await this.retryWithBackoff(async () => {
            return await this.provider.getBlockNumber();
        });
    }

    private async testConnection(): Promise<void> {
        try {
            log.info("🔍 Testing RPC connection...");
            const network = await this.provider.getNetwork();
            const latestBlock = await this.provider.getBlockNumber();
            log.info(`✅ RPC connection successful! Network: ${network.name} (chainId: ${network.chainId}), Latest block: ${latestBlock}`);
            
            // Test querying all events from the contract
            log.info("🔍 Testing event querying...");
            const allEvents = await this.contract.queryFilter("*", latestBlock - 100, latestBlock);
            log.info(`📊 Found ${allEvents.length} total events in last 100 blocks`);
            
            if (allEvents.length > 0) {
                const firstEvent = allEvents[0];
                log.info(`📋 Sample event:`, {
                    name: 'eventName' in firstEvent ? firstEvent.eventName : 'unknown',
                    blockNumber: firstEvent.blockNumber,
                    transactionHash: firstEvent.transactionHash
                });
            }
        } catch (error) {
            log.error(`❌ RPC connection failed:`, error instanceof Error ? error.message : String(error));
            throw error;
        }
    }

    async backfillFromBlock(fromBlock: number): Promise<void> {
        log.info(`🔄 Starting backfill from block ${fromBlock}`);
        
        const latestBlock = await this.getLatestBlockNumber();
        const totalBlocks = latestBlock - fromBlock + 1;
        
        log.info(`📊 Backfilling ${totalBlocks} blocks from ${fromBlock} to ${latestBlock}`);

        let processedBlocks = 0;
        const chunkSize = 100; // Use 100 blocks per chunk for backfill

        for (let block = fromBlock; block <= latestBlock; block += chunkSize) {
            const chunkEnd = Math.min(block + chunkSize - 1, latestBlock);

            try {
                log.info(`🔄 Backfilling chunk: blocks ${block}-${chunkEnd}`);
                await this.indexEvents(block, chunkEnd);
                
                processedBlocks += (chunkEnd - block + 1);
                const progress = ((processedBlocks / totalBlocks) * 100).toFixed(2);
                
                log.info(`✅ Backfill progress: ${progress}% (${processedBlocks}/${totalBlocks} blocks)`);
                
                // Update the last indexed block
                await this.updateLastIndexedBlock(chunkEnd);
                
                // Small delay to avoid overwhelming RPC
                await this.delay(100);
                
            } catch (error) {
                log.error(`❌ Error backfilling blocks ${block}-${chunkEnd}:`, error instanceof Error ? error.message : String(error));
                throw error;
            }
        }

        log.info(`🎉 Backfill completed! Last indexed block: ${latestBlock}`);
    }

    // Persistence methods for last indexed block
    async getLastIndexedBlock(): Promise<number> {
        try {
            // Create a simple table to store the last indexed block
            await AppDataSource.query(`
                CREATE TABLE IF NOT EXISTS indexing_state (
                    id INTEGER PRIMARY KEY,
                    last_indexed_block INTEGER NOT NULL,
                    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            const result = await AppDataSource.query(
                'SELECT last_indexed_block FROM indexing_state WHERE id = 1'
            ) as Array<{ last_indexed_block: number }>;
            
            if (result && result.length > 0) {
                return result[0].last_indexed_block;
            }
            
            // Return deployment block if no state exists
            const { ROULETTE_DEPLOYMENT_BLOCK } = await import('../constants/blockchain');
            return ROULETTE_DEPLOYMENT_BLOCK - 1;
        } catch (error) {
            log.error('Error getting last indexed block:', error as any);
            const { ROULETTE_DEPLOYMENT_BLOCK } = await import('../constants/blockchain');
            return ROULETTE_DEPLOYMENT_BLOCK - 1;
        }
    }

    async updateLastIndexedBlock(blockNumber: number): Promise<void> {
        try {
            await AppDataSource.query(`
                INSERT OR REPLACE INTO indexing_state (id, last_indexed_block, last_updated)
                VALUES (1, ?, CURRENT_TIMESTAMP)
            `, [blockNumber] as any);
            
            log.debug(`💾 Updated last indexed block to ${blockNumber}`);
        } catch (error) {
            log.error('Error updating last indexed block:', error as any);
        }
    }

    // Retry logic with exponential backoff
    private async retryWithBackoff<T>(operation: () => Promise<T>): Promise<T> {
        let lastError: Error;
        
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                
                // Check if it's a timeout error
                const isTimeout = lastError.message.includes('timeout') || 
                                lastError.message.includes('Request timeout') ||
                                (lastError as any).code === 30;
                
                if (isTimeout && attempt < this.maxRetries) {
                    const delay = this.baseDelay * Math.pow(2, attempt - 1);
                    log.warn(`⏰ RPC timeout on attempt ${attempt}, retrying in ${delay}ms...`);
                    await this.delay(delay);
                    continue;
                }
                
                // For non-timeout errors or max retries reached, throw immediately
                throw lastError;
            }
        }
        
        throw lastError!;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
} 
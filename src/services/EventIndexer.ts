/* eslint-disable @typescript-eslint/no-explicit-any */
import { ethers } from "ethers";
import { AppDataSource } from "../config/database";
import { BetPlaced } from "../entities/BetPlaced";
import { BetSettled } from "../entities/BetSettled";
import { BetExpired } from "../entities/BetExpired";
import { WinningsClaimed } from "../entities/WinningsClaimed";
import { Spin } from "../entities/Spin";
import { log } from "@sayukixbt/log";
import { ROULETTE_ADDRESS } from "../constants/blockchain";
import { DualProvider } from "./DualProvider";

// Import the ABI
import rouletteABI from "../abi/Roulette.json";

export class EventIndexer {
    private dualProvider: DualProvider;
    private contract: ethers.Contract;
    private betPlacedRepository = AppDataSource.getRepository(BetPlaced);
    private betSettledRepository = AppDataSource.getRepository(BetSettled);
    private betExpiredRepository = AppDataSource.getRepository(BetExpired);
    private winningsClaimedRepository =
        AppDataSource.getRepository(WinningsClaimed);
    private spinRepository = AppDataSource.getRepository(Spin);
    private chunkSize: number = 10; // Reduced from 100 to avoid DRPC batch limits
    private maxRetries: number = 5;
    private baseDelay: number = 1000; // 1 second base delay
    private onNewSpin?: (spin: Spin) => void; // Callback for new spin events
    private onSpinUpdated?: (spin: Spin) => void; // Callback for spin update events

    constructor(
        archiveRpcUrl: string,
        localRpcUrl: string,
        contractAddress: string = ROULETTE_ADDRESS,
        onNewSpin?: (spin: Spin) => void,
        onSpinUpdated?: (spin: Spin) => void,
    ) {
        log.info(`🔗 Initializing EventIndexer with dual RPC setup`);
        this.dualProvider = new DualProvider(archiveRpcUrl, localRpcUrl);

        // Initialize contract with archive provider (will be updated per request)
        this.contract = new ethers.Contract(
            contractAddress,
            rouletteABI.abi,
            this.dualProvider.getArchiveProvider(),
        );

        this.onNewSpin = onNewSpin;
        this.onSpinUpdated = onSpinUpdated;
        log.info(`EventIndexer initialized for contract: ${contractAddress}`);

        // Test the connections
        this.testConnection();
    }

    async indexEvents(fromBlock: number, toBlock: number) {
        try {
            log.info(`Indexing events from block ${fromBlock} to ${toBlock}`);

            // Index BetPlaced events
            await this.indexBetPlacedEvents(fromBlock, toBlock);
            await this.delay(500); // Increased delay to prevent batching

            // Index BetSettled events
            await this.indexBetSettledEvents(fromBlock, toBlock);
            await this.delay(500); // Increased delay to prevent batching

            // Index BetExpired events
            await this.indexBetExpiredEvents(fromBlock, toBlock);
            await this.delay(500); // Increased delay to prevent batching

            // Index WinningsClaimed events
            await this.indexWinningsClaimedEvents(fromBlock, toBlock);
            await this.delay(500); // Increased delay to prevent batching

            log.info(
                `Successfully indexed events from block ${fromBlock} to ${toBlock}`,
            );
        } catch (error) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            log.error("Error indexing events:", error as any);
            throw error;
        }
    }

    private async indexBetPlacedEvents(fromBlock: number, toBlock: number) {
        log.info(
            `🔍 Querying BetPlaced events from block ${fromBlock} to ${toBlock}`,
        );

        try {
            // Get the appropriate provider for this block range
            const provider = await this.dualProvider.getProviderForBlockRange(
                fromBlock,
                toBlock,
            );

            const contract = new ethers.Contract(
                this.contract.target,
                rouletteABI.abi,
                provider,
            );

            // Test the filter first
            const filter = contract.filters.BetPlaced();

            const events = await this.retryWithBackoff(async () => {
                return await contract.queryFilter(filter, fromBlock, toBlock);
            });

            log.info(
                `Found ${events.length} BetPlaced events in block range ${fromBlock}-${toBlock}`,
            );

            // Log first few events for debugging
            if (events.length > 0) {
                // log.info(events);
            }

            // Group events by transactionHash
            const eventsByTx: Record<string, any[]> = {};
            for (const event of events) {
                if ("args" in event && event.args) {
                    const tx = event.transactionHash;
                    if (!eventsByTx[tx]) eventsByTx[tx] = [];
                    eventsByTx[tx].push(event);
                }
            }

            let indexedCount = 0;
            for (const tx in eventsByTx) {
                const txEvents = eventsByTx[tx];
                let spin: Spin | null = null;
                let spinUser = null;
                let spinTargetBlock = null;
                for (const event of txEvents) {
                    const args = event.args as any;
                    const existing = await this.betPlacedRepository.findOne({
                        where: {
                            user: args.user,
                            betIndex: args.betIndex.toString(),
                            transactionHash: event.transactionHash,
                        },
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

                        // Update or create spin record, but suppress emit
                        spin = await this.updateSpinFromBetPlaced(args, true);
                        spinUser = args.user;
                        spinTargetBlock = args.targetBlock.toString();
                        indexedCount++;
                        log.info(
                            `✅ Indexed BetPlaced event: User ${args.user} bet ${args.betIndex} guess ${args.guess.toString()} for ${args.wager.toString()} tokens`,
                        );
                    } else {
                        log.debug(
                            `⏭️  Skipped existing BetPlaced event: ${event.transactionHash}`,
                        );
                    }
                }
                // After all events for this tx, emit new:spin ONCE if spin was created/updated
                if (spin && spinUser && spinTargetBlock) {
                    if (this.onNewSpin) this.onNewSpin(spin);
                }
            }

            if (indexedCount > 0) {
                log.info(`📊 Indexed ${indexedCount} new BetPlaced events`);
            }
        } catch (error) {
            log.error(
                `❌ Error querying BetPlaced events:`,
                error instanceof Error ? error.message : String(error),
            );
            throw error;
        }
    }

    private async indexBetSettledEvents(fromBlock: number, toBlock: number) {
        log.info(
            `🔍 Querying BetSettled events from block ${fromBlock} to ${toBlock}`,
        );

        try {
            // Get the appropriate provider for this block range
            const provider = await this.dualProvider.getProviderForBlockRange(
                fromBlock,
                toBlock,
            );
            const contract = new ethers.Contract(
                this.contract.target,
                rouletteABI.abi,
                provider,
            );

            const events = await this.retryWithBackoff(async () => {
                return await contract.queryFilter(
                    contract.filters.BetSettled(),
                    fromBlock,
                    toBlock,
                );
            });

            log.info(
                `Found ${events.length} BetSettled events in block range ${fromBlock}-${toBlock}`,
            );

            let indexedCount = 0;
            for (const event of events) {
                if ("args" in event && event.args) {
                    const args = event.args as any;
                    const existing = await this.betSettledRepository.findOne({
                        where: {
                            user: args.user,
                            betIndex: args.betIndex.toString(),
                            transactionHash: event.transactionHash,
                        },
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

                        // Update spin record with settlement info
                        await this.updateSpinFromBetSettled(args, event);

                        indexedCount++;
                        const result = args.won ? "WON" : "LOST";
                        log.info(
                            `🎯 Indexed BetSettled event: User ${args.user} ${result} bet ${args.betIndex} - Hex: ${args.firstHex.toString()},${args.secondHex.toString()} - Payout: ${args.payout.toString()} tokens`,
                        );
                    } else {
                        log.debug(
                            `⏭️  Skipped existing BetSettled event: ${event.transactionHash}`,
                        );
                    }
                }
            }

            if (indexedCount > 0) {
                log.info(`📊 Indexed ${indexedCount} new BetSettled events`);
            }
        } catch (error) {
            log.error(
                `❌ Error querying BetSettled events:`,
                error instanceof Error ? error.message : String(error),
            );
            throw error;
        }
    }

    private async indexBetExpiredEvents(fromBlock: number, toBlock: number) {
        log.info(
            `🔍 Querying BetExpired events from block ${fromBlock} to ${toBlock}`,
        );

        try {
            // Get the appropriate provider for this block range
            const provider = await this.dualProvider.getProviderForBlockRange(
                fromBlock,
                toBlock,
            );

            const contract = new ethers.Contract(
                this.contract.target,
                rouletteABI.abi,
                provider,
            );

            const events = await this.retryWithBackoff(async () => {
                return await contract.queryFilter(
                    contract.filters.BetExpired(),
                    fromBlock,
                    toBlock,
                );
            });

            for (const event of events) {
                if ("args" in event && event.args) {
                    const args = event.args as any;
                    const existing = await this.betExpiredRepository.findOne({
                        where: {
                            betId: args.betId.toString(),
                            transactionHash: event.transactionHash,
                        },
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
                        log.info(
                            `⏰ Indexed BetExpired event: User ${args.user} bet ${args.betId} type ${args.betType.toString()} expired - Refund: ${args.amount.toString()} tokens`,
                        );

                        // Update the corresponding spin to mark it as expired
                        await this.updateSpinFromBetExpired(args);
                    }
                }
            }
        } catch (error) {
            log.error(
                `❌ Error querying BetExpired events:`,
                error instanceof Error ? error.message : String(error),
            );
            throw error;
        }
    }

    private async indexWinningsClaimedEvents(
        fromBlock: number,
        toBlock: number,
    ) {
        log.info(
            `🔍 Querying WinningsClaimed events from block ${fromBlock} to ${toBlock}`,
        );

        try {
            // Get the appropriate provider for this block range
            const provider = await this.dualProvider.getProviderForBlockRange(
                fromBlock,
                toBlock,
            );

            const contract = new ethers.Contract(
                this.contract.target,
                rouletteABI.abi,
                provider,
            );

            const events = await this.retryWithBackoff(async () => {
                return await contract.queryFilter(
                    contract.filters.WinningsClaimed(),
                    fromBlock,
                    toBlock,
                );
            });

            for (const event of events) {
                if ("args" in event && event.args) {
                    const args = event.args as any;
                    const existing =
                        await this.winningsClaimedRepository.findOne({
                            where: {
                                user: args.user,
                                transactionHash: event.transactionHash,
                            },
                        });

                    if (!existing) {
                        const winningsClaimed = new WinningsClaimed();
                        winningsClaimed.user = args.user;
                        winningsClaimed.amount = args.amount.toString();
                        winningsClaimed.transactionHash = event.transactionHash;
                        winningsClaimed.blockNumber = event.blockNumber;

                        await this.winningsClaimedRepository.save(
                            winningsClaimed,
                        );
                        log.debug(
                            `Indexed WinningsClaimed event: ${event.transactionHash}`,
                        );
                    }
                }
            }
        } catch (error) {
            log.error(
                `❌ Error querying WinningsClaimed events:`,
                error instanceof Error ? error.message : String(error),
            );
            throw error;
        }
    }

    // Spin management methods
    private async updateSpinFromBetPlaced(
        args: any,
        suppressEmit: boolean = false,
    ): Promise<Spin | null> {
        try {
            const user = args.user;
            const targetBlock = args.targetBlock.toString();
            const betIndex = args.betIndex.toString();
            const guess = args.guess.toString();
            const wager = args.wager.toString();

            // Use a more robust approach to handle race conditions
            // First try to find existing spin
            let spin = await this.spinRepository.findOne({
                where: { user, targetBlock },
            });

            if (!spin) {
                // Create new spin
                spin = new Spin();
                spin.user = user;
                spin.targetBlock = targetBlock;
                spin.totalWager = "0";
                spin.betIndexes = [];
                spin.guesses = [];
                spin.wagers = [];
                spin.isSettled = false;
            }

            // Add this bet to the spin
            const guessIndex = spin.guesses.findIndex((g) => g === guess);
            if (guessIndex !== -1) {
                // Already have a bet for this guess, sum the wager
                spin.wagers[guessIndex] = (
                    BigInt(spin.wagers[guessIndex]) + BigInt(wager)
                ).toString();
            } else {
                // New guess for this spin
                spin.betIndexes.push(betIndex);
                spin.guesses.push(guess);
                spin.wagers.push(wager);
            }

            // Update total wager
            const currentTotal = BigInt(spin.totalWager);
            const newWager = BigInt(wager);
            spin.totalWager = (currentTotal + newWager).toString();

            // Update timestamp
            spin.updatedAt = new Date();

            // Use a try-catch approach to handle the unique constraint
            let savedSpin: Spin;
            try {
                savedSpin = await this.spinRepository.save(spin);
            } catch (saveError) {
                // If save fails due to unique constraint, try to find and update the existing spin
                if (
                    saveError instanceof Error &&
                    saveError.message.includes("UNIQUE constraint failed")
                ) {
                    log.debug(
                        `🔄 Spin already exists, updating existing spin for user ${user} target block ${targetBlock}`,
                    );

                    // Find the existing spin and update it
                    const existingSpin = await this.spinRepository.findOne({
                        where: { user, targetBlock },
                    });

                    if (existingSpin) {
                        // Update the existing spin with the new bet
                        const guessIndex = existingSpin.guesses.findIndex(
                            (g) => g === guess,
                        );
                        if (guessIndex !== -1) {
                            existingSpin.wagers[guessIndex] = (
                                BigInt(existingSpin.wagers[guessIndex]) +
                                BigInt(wager)
                            ).toString();
                        } else {
                            existingSpin.betIndexes.push(betIndex);
                            existingSpin.guesses.push(guess);
                            existingSpin.wagers.push(wager);
                        }

                        existingSpin.totalWager = (
                            BigInt(existingSpin.totalWager) + BigInt(wager)
                        ).toString();
                        existingSpin.updatedAt = new Date();

                        savedSpin =
                            await this.spinRepository.save(existingSpin);
                    } else {
                        throw saveError; // Re-throw if we can't find the existing spin
                    }
                } else {
                    throw saveError; // Re-throw if it's not a unique constraint error
                }
            }

            log.debug(
                `🔄 Updated spin for user ${user} target block ${targetBlock} - total wager: ${savedSpin.totalWager}`,
            );

            // Trigger callback for new spin if provided
            if (!suppressEmit && this.onNewSpin) {
                this.onNewSpin(savedSpin);
            }

            return savedSpin;
        } catch (error) {
            log.error(
                `❌ Error updating spin from BetPlaced:`,
                error instanceof Error ? error.message : String(error),
            );
            return null;
        }
    }

    private async updateSpinFromBetExpired(args: any): Promise<void> {
        try {
            const user = args.user;
            const betId = args.betId.toString();

            // Find the BetPlaced event to get the target block
            const betPlaced = await this.betPlacedRepository.findOne({
                where: {
                    user,
                    betIndex: betId,
                },
            });

            if (!betPlaced) {
                log.warn(
                    `⚠️ Could not find BetPlaced event for expired bet ${betId} by user ${user}`,
                );
                return;
            }

            const targetBlock = betPlaced.targetBlock;

            // Find the corresponding spin
            const spin = await this.spinRepository.findOne({
                where: { user, targetBlock },
            });

            if (!spin) {
                log.warn(
                    `⚠️ Could not find spin for expired bet ${betId} by user ${user} target block ${targetBlock}`,
                );
                return;
            }

            // Mark the spin as expired
            spin.isExpired = true;
            spin.updatedAt = new Date();
            await this.spinRepository.save(spin);

            log.info(
                `⏰ Marked spin as expired for user ${user} target block ${targetBlock} due to BetExpired event for bet ${betId}`,
            );

            // Trigger callback for spin update if provided
            if (this.onSpinUpdated) {
                this.onSpinUpdated(spin);
            }
        } catch (error) {
            log.error(
                `❌ Error updating spin from BetExpired:`,
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private async updateSpinFromBetSettled(
        args: any,
        event: any,
    ): Promise<void> {
        try {
            const user = args.user;
            const betIndex = args.betIndex.toString();
            const won = args.won;
            const firstHex = args.firstHex.toString();
            const secondHex = args.secondHex.toString();
            const payout = args.payout.toString();

            // First, find the BetPlaced event to get the target block
            const betPlaced = await this.betPlacedRepository.findOne({
                where: {
                    user,
                    betIndex,
                },
            });

            if (!betPlaced) {
                log.warn(
                    `⚠️ Could not find BetPlaced event for settled bet: user ${user}, bet index ${betIndex}`,
                );
                return;
            }

            // Now find the spin using user and target block
            const spin = await this.spinRepository.findOne({
                where: {
                    user,
                    targetBlock: betPlaced.targetBlock,
                },
            });

            if (spin) {
                // Update spin with settlement info
                spin.isSettled = true;
                spin.won = won;
                spin.firstHex = firstHex;
                spin.secondHex = secondHex;
                spin.totalPayout = payout;
                spin.settlementTransactionHash = event.transactionHash;
                spin.settlementBlockNumber = event.blockNumber;
                spin.updatedAt = new Date();

                await this.spinRepository.save(spin);
                log.debug(
                    `🎯 Updated spin settlement for user ${user} target block ${betPlaced.targetBlock} - won: ${won}, payout: ${payout}`,
                );

                // Trigger callback for spin update if provided
                if (this.onSpinUpdated) {
                    this.onSpinUpdated(spin);
                }
            } else {
                log.warn(
                    `⚠️ Could not find spin for settled bet: user ${user}, bet index ${betIndex}, target block ${betPlaced.targetBlock}`,
                );
            }
        } catch (error) {
            log.error(
                `❌ Error updating spin from BetSettled:`,
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    async getLatestBlockNumber(): Promise<number> {
        return await this.retryWithBackoff(async () => {
            const blockNumber = await this.dualProvider.getLatestBlockNumber();
            log.debug(`📊 Latest block number: ${blockNumber}`);
            return blockNumber;
        });
    }

    private async testConnection(): Promise<void> {
        try {
            log.info("🔍 Testing RPC connections...");
            await this.dualProvider.testConnections();

            // Test querying all events from the contract
            log.info("🔍 Testing event querying...");
            const latestBlock = await this.dualProvider.getLatestBlockNumber();
            const allEvents = await this.contract.queryFilter(
                "*",
                latestBlock - 100,
                latestBlock,
            );
            log.info(
                `📊 Found ${allEvents.length} total events in last 100 blocks`,
            );

            if (allEvents.length > 0) {
                const firstEvent = allEvents[0];
                log.info(`📋 Sample event:`, {
                    name:
                        "eventName" in firstEvent
                            ? firstEvent.eventName
                            : "unknown",
                    blockNumber: firstEvent.blockNumber,
                    transactionHash: firstEvent.transactionHash,
                });
            }
        } catch (error) {
            log.error(
                `❌ RPC connection failed:`,
                error instanceof Error ? error.message : String(error),
            );
            throw error;
        }
    }

    async backfillFromBlock(fromBlock: number): Promise<void> {
        log.info(`🔄 Starting backfill from block ${fromBlock}`);

        const latestBlock = await this.getLatestBlockNumber();
        const totalBlocks = latestBlock - fromBlock + 1;

        log.info(
            `📊 Backfilling ${totalBlocks} blocks from ${fromBlock} to ${latestBlock}`,
        );

        let processedBlocks = 0;
        const chunkSize = 100; // Use 100 blocks per chunk for backfill

        for (let block = fromBlock; block <= latestBlock; block += chunkSize) {
            const chunkEnd = Math.min(block + chunkSize - 1, latestBlock);

            try {
                log.info(`🔄 Backfilling chunk: blocks ${block}-${chunkEnd}`);
                await this.indexEvents(block, chunkEnd);

                processedBlocks += chunkEnd - block + 1;
                const progress = (
                    (processedBlocks / totalBlocks) *
                    100
                ).toFixed(2);

                log.info(
                    `✅ Backfill progress: ${progress}% (${processedBlocks}/${totalBlocks} blocks)`,
                );

                // Update the last indexed block
                await this.updateLastIndexedBlock(chunkEnd);

                // Small delay to avoid overwhelming RPC
                await this.delay(100);
            } catch (error) {
                log.error(
                    `❌ Error backfilling blocks ${block}-${chunkEnd}:`,
                    error instanceof Error ? error.message : String(error),
                );
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

            const result = (await AppDataSource.query(
                "SELECT last_indexed_block FROM indexing_state WHERE id = 1",
            )) as Array<{ last_indexed_block: number }>;

            if (result && result.length > 0) {
                return result[0].last_indexed_block;
            }

            // Return deployment block if no state exists
            const { ROULETTE_DEPLOYMENT_BLOCK } = await import(
                "../constants/blockchain"
            );
            return ROULETTE_DEPLOYMENT_BLOCK - 1;
        } catch (error) {
            log.error("Error getting last indexed block:", error as any);
            const { ROULETTE_DEPLOYMENT_BLOCK } = await import(
                "../constants/blockchain"
            );
            return ROULETTE_DEPLOYMENT_BLOCK - 1;
        }
    }

    async updateLastIndexedBlock(blockNumber: number): Promise<void> {
        try {
            await AppDataSource.query(
                `
                INSERT OR REPLACE INTO indexing_state (id, last_indexed_block, last_updated)
                VALUES (1, ?, CURRENT_TIMESTAMP)
            `,
                [blockNumber] as any,
            );

            log.debug(`💾 Updated last indexed block to ${blockNumber}`);
        } catch (error) {
            log.error("Error updating last indexed block:", error as any);
        }
    }

    // Retry logic with exponential backoff
    private async retryWithBackoff<T>(operation: () => Promise<T>): Promise<T> {
        let lastError: Error;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError =
                    error instanceof Error ? error : new Error(String(error));

                // Check if it's a timeout error
                const isTimeout =
                    lastError.message.includes("timeout") ||
                    lastError.message.includes("Request timeout") ||
                    (lastError as any).code === 30;

                // Check if it's an "Unknown block" error (code 26)
                const isUnknownBlock =
                    (lastError as any).code === 26 ||
                    lastError.message.includes("Unknown block") ||
                    lastError.message.includes("unknown block");

                if (isTimeout && attempt < this.maxRetries) {
                    const delay = this.baseDelay * Math.pow(2, attempt - 1);
                    log.warn(
                        `⏰ RPC timeout on attempt ${attempt}, retrying in ${delay}ms...`,
                    );
                    await this.delay(delay);
                    continue;
                }

                // For "Unknown block" errors, retry with longer delays as the RPC might be catching up
                if (isUnknownBlock && attempt < this.maxRetries) {
                    const delay = this.baseDelay * Math.pow(3, attempt - 1); // Longer delays for unknown block errors
                    log.warn(
                        `🔍 Unknown block error on attempt ${attempt}, RPC might be catching up. Retrying in ${delay}ms...`,
                    );
                    await this.delay(delay);
                    continue;
                }

                // For non-retryable errors or max retries reached, throw immediately
                throw lastError;
            }
        }

        throw lastError!;
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

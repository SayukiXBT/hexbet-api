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
    private lastProcessedRange: { fromBlock: number; toBlock: number } | null =
        null; // Track last processed range

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
        // Prevent processing the same block range multiple times
        if (
            this.lastProcessedRange &&
            this.lastProcessedRange.fromBlock === fromBlock &&
            this.lastProcessedRange.toBlock === toBlock
        ) {
            log.debug(
                `⏭️ Skipping duplicate block range ${fromBlock}-${toBlock}`,
            );
            return;
        }

        this.lastProcessedRange = { fromBlock, toBlock };

        // Map key: user:targetBlock, value: Spin
        const updatedSpins: Map<string, Spin> = new Map();
        const newSpins: Set<string> = new Set(); // Track newly created spins
        const registerSpin = (spin: Spin, isNew: boolean = false) => {
            const key = `${spin.user.toLowerCase()}:${spin.targetBlock}`;
            updatedSpins.set(key, spin);
            if (isNew) {
                newSpins.add(key);
            }
        };
        try {
            await this.indexBetPlacedEvents(fromBlock, toBlock, registerSpin);
            await this.indexBetSettledEvents(fromBlock, toBlock, registerSpin);
            await this.indexBetExpiredEvents(fromBlock, toBlock, registerSpin);
            await this.indexWinningsClaimedEvents(fromBlock, toBlock);
            // Emit all updated spins after processing the block range
            for (const [key, spin] of updatedSpins) {
                if (newSpins.has(key) && this.onNewSpin) {
                    log.info(`📡 Emitting new:spin for ${key}`);
                    this.onNewSpin(spin);
                } else if (!newSpins.has(key) && this.onSpinUpdated) {
                    log.info(`📡 Emitting spin:updated for ${key}`);
                    this.onSpinUpdated(spin);
                }
            }
        } catch (error) {
            log.error("Error indexing events:", error as any);
            throw error;
        }
    }

    private async indexBetPlacedEvents(
        fromBlock: number,
        toBlock: number,
        registerSpin: (spin: Spin, isNew: boolean) => void,
    ) {
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

            if (events.length > 0) {
                log.info(
                    `🎯 Found ${events.length} BetPlaced events in block range ${fromBlock}-${toBlock}`,
                );
            }

            // Log first few events for debugging
            if (events.length > 0) {
                log.debug(`📋 Sample BetPlaced events: ${events.length} found`);
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
            // Track spins by target block to avoid multiple emissions
            const spinsByTargetBlock: Map<
                string,
                { spin: Spin; isNew: boolean }
            > = new Map();

            for (const tx in eventsByTx) {
                const txEvents = eventsByTx[tx];
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
                        const spinResult =
                            await this.updateSpinFromBetPlaced(args); // always suppress emit here
                        if (spinResult) {
                            const key = `${args.user.toLowerCase()}:${args.targetBlock.toString()}`;
                            // If this target block already exists in our map, preserve the "new" status
                            const existingSpinData =
                                spinsByTargetBlock.get(key);
                            // Only mark as "not new" if we already had a spin in our map AND the spinResult says it's not new
                            // This means the spin existed in the database before this batch
                            const isNew = existingSpinData
                                ? existingSpinData.isNew
                                : spinResult.isNew;
                            spinsByTargetBlock.set(key, {
                                spin: spinResult.spin,
                                isNew,
                            });
                            log.info(
                                `🔍 Target block ${args.targetBlock} for user ${args.user}: existing=${!!existingSpinData}, spinResult.isNew=${spinResult.isNew}, final isNew=${isNew}`,
                            );
                        }
                        indexedCount++;
                        log.info(
                            `🎯 Indexed BetPlaced: User ${args.user} bet ${args.betIndex} guess ${args.guess.toString()} for ${args.wager.toString()} tokens`,
                        );
                    } else {
                        // Skip existing events silently
                    }
                }
            }

            // Register spins only once per target block after all bets are processed
            for (const [key, spinResult] of spinsByTargetBlock) {
                log.info(
                    `📡 Registering spin for ${key}: isNew=${spinResult.isNew}`,
                );
                registerSpin(spinResult.spin, spinResult.isNew);
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

    private async indexBetSettledEvents(
        fromBlock: number,
        toBlock: number,
        registerSpin: (spin: Spin, isNew: boolean) => void,
    ) {
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

            if (events.length > 0) {
                log.info(
                    `🎯 Found ${events.length} BetSettled events in block range ${fromBlock}-${toBlock}`,
                );
            }

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
                        // Find the spin and register it if updated
                        const betPlaced =
                            await this.betPlacedRepository.findOne({
                                where: {
                                    user: args.user,
                                    betIndex: args.betIndex.toString(),
                                },
                            });
                        if (betPlaced) {
                            const spin = await this.spinRepository.findOne({
                                where: {
                                    user: args.user,
                                    targetBlock: betPlaced.targetBlock,
                                },
                            });
                            if (spin) registerSpin(spin, false);
                        }

                        indexedCount++;
                        const result = args.won ? "WON" : "LOST";
                        log.info(
                            `🎯 Indexed BetSettled: User ${args.user} ${result} bet ${args.betIndex} - Hex: ${args.firstHex.toString()},${args.secondHex.toString()} - Payout: ${args.payout.toString()} tokens`,
                        );
                    } else {
                        // Skip existing events silently
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

    private async indexBetExpiredEvents(
        fromBlock: number,
        toBlock: number,
        registerSpin: (spin: Spin, isNew: boolean) => void,
    ) {
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
                            `⏰ Indexed BetExpired: User ${args.user} bet ${args.betId} type ${args.betType.toString()} expired - Refund: ${args.amount.toString()} tokens`,
                        );

                        // Update the corresponding spin to mark it as expired
                        await this.updateSpinFromBetExpired(args);
                        // Find the spin and register it if updated
                        const betPlaced =
                            await this.betPlacedRepository.findOne({
                                where: {
                                    user: args.user,
                                    betIndex: args.betId.toString(),
                                },
                            });
                        if (betPlaced) {
                            const spin = await this.spinRepository.findOne({
                                where: {
                                    user: args.user,
                                    targetBlock: betPlaced.targetBlock,
                                },
                            });
                            if (spin) registerSpin(spin, false);
                        }
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
        // registerSpin: (spin: Spin) => void, // Remove unused param
    ) {
        try {
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
                        log.info(
                            `💰 Indexed WinningsClaimed: User ${args.user} claimed ${args.amount.toString()} tokens`,
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
    ): Promise<{ spin: Spin; isNew: boolean } | null> {
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

            const isNew = !spin; // Track if this is a new spin

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

            return { spin: savedSpin, isNew };
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

            // Remove the onSpinUpdated call - will be handled by batching
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

                // Aggregate win/loss status: if any bet won, the spin is won
                if (spin.won === null || spin.won === false) {
                    spin.won = won;
                } else {
                    // If already marked as won, keep it won (any bet winning makes the spin a win)
                    spin.won = true;
                }

                // Set hex values (should be the same for all bets in the spin)
                spin.firstHex = firstHex;
                spin.secondHex = secondHex;

                // Aggregate payouts: add this bet's payout to the total
                const currentPayout = BigInt(spin.totalPayout || "0");
                const newPayout = BigInt(payout);
                spin.totalPayout = (currentPayout + newPayout).toString();

                spin.settlementTransactionHash = event.transactionHash;
                spin.settlementBlockNumber = event.blockNumber;
                spin.updatedAt = new Date();

                await this.spinRepository.save(spin);
                log.info(
                    `🎯 Updated spin settlement for user ${user} target block ${betPlaced.targetBlock} - bet ${betIndex} won: ${won}, payout: ${payout}, total spin won: ${spin.won}, total payout: ${spin.totalPayout}`,
                );

                // Remove the onSpinUpdated call - will be handled by batching
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

            // Test getting latest block number from both providers
            log.info("🔍 Testing block height queries...");
            const latestBlock = await this.dualProvider.getLatestBlockNumber();
            log.info(`📊 Latest block number: ${latestBlock}`);

            // Test getting a recent block to ensure connectivity
            const provider = await this.dualProvider.getProviderForBlock(
                latestBlock - 10,
            );
            const recentBlock = await provider.getBlock(latestBlock - 10);
            log.info(
                `📋 Recent block ${recentBlock?.number} hash: ${recentBlock?.hash?.slice(0, 10)}...`,
            );

            log.info("✅ RPC connection test successful!");
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

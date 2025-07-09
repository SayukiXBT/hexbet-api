import { ethers } from "ethers";
import { log } from "@sayukixbt/log";
import { EventIndexer } from "./EventIndexer";
import { ROULETTE_DEPLOYMENT_BLOCK } from "../constants/blockchain";

interface IndexingState {
    lastIndexedBlock: number;
    isRunning: boolean;
    lastError?: string;
    lastRunTime?: Date;
}

export class ContinuousIndexer {
    private eventIndexer: EventIndexer;
    private provider: ethers.Provider;
    private state: IndexingState;
    private intervalId?: NodeJS.Timeout;
    private chunkSize: number = 1000; // Smaller chunks for continuous indexing
    private pollingInterval: number = 3000; // 800ms polling interval
    private onNewBlock?: (blockNumber: number) => void;
    private lastBroadcastedBlock: number = 0;

    constructor(
        eventIndexer: EventIndexer,
        onNewBlock?: (blockNumber: number) => void,
    ) {
        this.eventIndexer = eventIndexer;
        this.provider = eventIndexer["provider"];
        this.onNewBlock = onNewBlock;
        this.state = {
            lastIndexedBlock: ROULETTE_DEPLOYMENT_BLOCK - 1, // Start from deployment block
            isRunning: false,
        };
    }

    async start(): Promise<void> {
        if (this.state.isRunning) {
            log.warn("🔄 Indexer is already running");
            return;
        }

        log.info("🚀 Starting continuous indexer...");
        this.state.isRunning = true;
        this.state.lastError = undefined;

        // Load the last indexed block from persistence
        try {
            const lastIndexedBlock =
                await this.eventIndexer.getLastIndexedBlock();
            this.state.lastIndexedBlock = lastIndexedBlock;
            log.info(`📊 Resumed from block ${lastIndexedBlock}`);
        } catch (error) {
            log.warn(
                `⚠️ Could not load last indexed block, starting from deployment: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        // Start the indexing loop
        this.intervalId = setInterval(async () => {
            await this.indexNewBlocks();
        }, this.pollingInterval);

        // Do initial indexing
        await this.indexNewBlocks();
    }

    async stop(): Promise<void> {
        if (!this.state.isRunning) {
            log.warn("⏹️  Indexer is not running");
            return;
        }

        log.info("⏹️  Stopping continuous indexer...");
        this.state.isRunning = false;

        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }

    private async indexNewBlocks(): Promise<void> {
        try {
            const latestBlock = await this.provider.getBlockNumber();
            const fromBlock = this.state.lastIndexedBlock + 1;

            // Broadcast new block if we have a callback and it's a new block
            if (this.onNewBlock && latestBlock > this.lastBroadcastedBlock) {
                this.lastBroadcastedBlock = latestBlock;
                this.onNewBlock(latestBlock);
            }

            // Don't index if we're caught up
            if (fromBlock > latestBlock) {
                log.debug(`📊 Caught up to latest block ${latestBlock}`);
                return;
            }

            // Use chunking to process blocks in smaller batches
            let currentBlock = fromBlock;
            let totalProcessed = 0;

            while (currentBlock <= latestBlock) {
                const chunkEnd = Math.min(
                    currentBlock + this.chunkSize - 1,
                    latestBlock,
                );

                log.info(
                    `🔄 Indexing chunk: blocks ${currentBlock}-${chunkEnd} (latest: ${latestBlock})`,
                );

                await this.eventIndexer.indexEvents(currentBlock, chunkEnd);

                // Update state after each chunk
                this.state.lastIndexedBlock = chunkEnd;
                this.state.lastRunTime = new Date();
                this.state.lastError = undefined;

                // Persist the last indexed block
                await this.eventIndexer.updateLastIndexedBlock(chunkEnd);

                totalProcessed += chunkEnd - currentBlock + 1;
                log.info(
                    `✅ Indexed chunk ${currentBlock}-${chunkEnd}. Total processed: ${totalProcessed}. Last indexed: ${chunkEnd}`,
                );

                // Move to next chunk
                currentBlock = chunkEnd + 1;

                // Small delay between chunks to avoid overwhelming RPC
                if (currentBlock <= latestBlock) {
                    await this.delay(100);
                }
            }
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            this.state.lastError = errorMessage;
            this.state.lastRunTime = new Date();

            log.error(`❌ Error indexing blocks: ${errorMessage}`);

            // Don't throw - let the indexer continue running
        }
    }

    async backfillFromBlock(fromBlock: number): Promise<void> {
        log.info(`🔄 Starting backfill from block ${fromBlock}`);

        const latestBlock = await this.provider.getBlockNumber();
        const totalBlocks = latestBlock - fromBlock + 1;

        log.info(
            `📊 Backfilling ${totalBlocks} blocks from ${fromBlock} to ${latestBlock}`,
        );

        let processedBlocks = 0;
        const chunkSize = 100; // Larger chunks for backfill

        for (let block = fromBlock; block <= latestBlock; block += chunkSize) {
            const chunkEnd = Math.min(block + chunkSize - 1, latestBlock);

            try {
                log.info(`🔄 Backfilling chunk: blocks ${block}-${chunkEnd}`);
                await this.eventIndexer.indexEvents(block, chunkEnd);

                processedBlocks += chunkEnd - block + 1;
                const progress = (
                    (processedBlocks / totalBlocks) *
                    100
                ).toFixed(2);

                log.info(
                    `✅ Backfill progress: ${progress}% (${processedBlocks}/${totalBlocks} blocks)`,
                );

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

        // Update state to current position
        this.state.lastIndexedBlock = latestBlock;
        await this.eventIndexer.updateLastIndexedBlock(latestBlock);
        log.info(`🎉 Backfill completed! Last indexed block: ${latestBlock}`);
    }

    getState(): IndexingState {
        return { ...this.state };
    }

    async getStatus(): Promise<{
        isRunning: boolean;
        lastIndexedBlock: number;
        latestBlock: number;
        blocksBehind: number;
        lastRunTime?: Date;
        lastError?: string;
    }> {
        const latestBlock = await this.provider.getBlockNumber();
        const blocksBehind = Math.max(
            0,
            latestBlock - this.state.lastIndexedBlock,
        );

        return {
            isRunning: this.state.isRunning,
            lastIndexedBlock: this.state.lastIndexedBlock,
            latestBlock,
            blocksBehind,
            lastRunTime: this.state.lastRunTime,
            lastError: this.state.lastError,
        };
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

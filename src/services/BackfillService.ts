import { ethers } from "ethers";
import { log } from "@sayukixbt/log";
import { EventIndexer } from "./EventIndexer";
import { ROULETTE_DEPLOYMENT_BLOCK } from "../constants/blockchain";

export class BackfillService {
    private eventIndexer: EventIndexer;
    private provider: ethers.Provider;
    private chunkSize: number = 1000; // Default chunk size

    constructor(eventIndexer: EventIndexer, chunkSize: number = 1000) {
        this.eventIndexer = eventIndexer;
        this.provider = eventIndexer['provider'];
        this.chunkSize = chunkSize;
    }

    async backfillEvents(fromBlock: number, toBlock: number): Promise<void> {
        log.info(`🚀 Starting backfill from block ${fromBlock} to ${toBlock}`);
        
        const totalBlocks = toBlock - fromBlock + 1;
        const totalChunks = Math.ceil(totalBlocks / this.chunkSize);
        
        log.info(`📊 Total blocks to process: ${totalBlocks}`);
        log.info(`📦 Processing in ${totalChunks} chunks of ${this.chunkSize} blocks each`);

        let processedBlocks = 0;

        for (let chunk = 0; chunk < totalChunks; chunk++) {
            const chunkStart = fromBlock + (chunk * this.chunkSize);
            const chunkEnd = Math.min(chunkStart + this.chunkSize - 1, toBlock);
            
            log.info(`🔄 Processing chunk ${chunk + 1}/${totalChunks}: blocks ${chunkStart}-${chunkEnd}`);
            
            try {
                await this.eventIndexer.indexEvents(chunkStart, chunkEnd);
                
                processedBlocks += (chunkEnd - chunkStart + 1);
                const progress = ((processedBlocks / totalBlocks) * 100).toFixed(2);
                
                log.info(`✅ Chunk ${chunk + 1} completed. Progress: ${progress}% (${processedBlocks}/${totalBlocks} blocks)`);
                
                // Add a small delay to avoid overwhelming the RPC
                await this.delay(100);
                
            } catch (error) {
                log.error(`❌ Error processing chunk ${chunk + 1}:`, error instanceof Error ? error.message : String(error));
                throw error;
            }
        }
        
        log.info(`🎉 Backfill completed! Processed ${totalBlocks} blocks`);
    }

    async findContractDeploymentBlock(): Promise<number> {
        log.info(`🎯 Using known deployment block: ${ROULETTE_DEPLOYMENT_BLOCK}`);
        return ROULETTE_DEPLOYMENT_BLOCK;
    }

    async backfillFromDeployment(): Promise<void> {
        const deploymentBlock = await this.findContractDeploymentBlock();
        const latestBlock = await this.provider.getBlockNumber();
        
        log.info(`🚀 Starting backfill from deployment block ${deploymentBlock} to latest block ${latestBlock}`);
        
        await this.backfillEvents(deploymentBlock, latestBlock);
    }

    async backfillRecentBlocks(blocksBack: number = 1000): Promise<void> {
        const latestBlock = await this.provider.getBlockNumber();
        const fromBlock = Math.max(0, latestBlock - blocksBack);
        
        log.info(`🚀 Starting backfill of recent ${blocksBack} blocks: ${fromBlock} to ${latestBlock}`);
        
        await this.backfillEvents(fromBlock, latestBlock);
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
} 
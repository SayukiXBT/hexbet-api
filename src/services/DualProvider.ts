import { ethers } from "ethers";
import { log } from "@sayukixbt/log";

export class DualProvider {
    private archiveProvider: ethers.Provider;
    private localProvider: ethers.Provider;
    private archiveBlockThreshold: number = 50; // Use archive for blocks older than 50 blocks from tip

    constructor(archiveRpcUrl: string, localRpcUrl: string) {
        this.archiveProvider = new ethers.JsonRpcProvider(archiveRpcUrl);
        this.localProvider = new ethers.JsonRpcProvider(localRpcUrl);

        log.info(`🔗 DualProvider initialized`);
        log.info(`   📚 Archive RPC: ${archiveRpcUrl}`);
        log.info(`   🏠 Local RPC: ${localRpcUrl}`);
        log.info(
            `   📊 Archive threshold: ${this.archiveBlockThreshold} blocks from tip`,
        );
    }

    /**
     * Get the appropriate provider based on block number
     * Uses archive provider for historical blocks, local provider for recent blocks
     */
    async getProviderForBlock(blockNumber: number): Promise<ethers.Provider> {
        try {
            const latestBlock = await this.localProvider.getBlockNumber();
            const blocksFromTip = latestBlock - blockNumber;

            if (blocksFromTip > this.archiveBlockThreshold) {
                return this.archiveProvider;
            } else {
                return this.localProvider;
            }
        } catch (error) {
            log.warn(
                `⚠️ Error determining provider for block ${blockNumber}, falling back to archive: ${error instanceof Error ? error.message : String(error)}`,
            );
            return this.archiveProvider;
        }
    }

    /**
     * Get the appropriate provider for a block range
     * If the range spans both historical and recent blocks, use archive provider
     */
    async getProviderForBlockRange(
        fromBlock: number,
        toBlock: number,
    ): Promise<ethers.Provider> {
        try {
            const latestBlock = await this.localProvider.getBlockNumber();
            const fromBlocksFromTip = latestBlock - fromBlock;
            const toBlocksFromTip = latestBlock - toBlock;

            // If any block in the range is historical, use archive provider
            if (
                fromBlocksFromTip > this.archiveBlockThreshold ||
                toBlocksFromTip > this.archiveBlockThreshold
            ) {
                return this.archiveProvider;
            } else {
                return this.localProvider;
            }
        } catch (error) {
            log.warn(
                `⚠️ Error determining provider for block range ${fromBlock}-${toBlock}, falling back to archive: ${error instanceof Error ? error.message : String(error)}`,
            );
            return this.archiveProvider;
        }
    }

    /**
     * Get the latest block number (always use local provider for this)
     */
    async getLatestBlockNumber(): Promise<number> {
        try {
            return await this.localProvider.getBlockNumber();
        } catch (error) {
            log.warn(
                `⚠️ Error getting latest block from local provider, falling back to archive: ${error instanceof Error ? error.message : String(error)}`,
            );
            return await this.archiveProvider.getBlockNumber();
        }
    }

    /**
     * Get the archive provider (for direct access when needed)
     */
    getArchiveProvider(): ethers.Provider {
        return this.archiveProvider;
    }

    /**
     * Get the local provider (for direct access when needed)
     */
    getLocalProvider(): ethers.Provider {
        return this.localProvider;
    }

    /**
     * Test both connections
     */
    async testConnections(): Promise<void> {
        try {
            log.info("🔍 Testing RPC connections...");

            const [archiveNetwork, localNetwork, archiveLatest, localLatest] =
                await Promise.all([
                    this.archiveProvider.getNetwork(),
                    this.localProvider.getNetwork(),
                    this.archiveProvider.getBlockNumber(),
                    this.localProvider.getBlockNumber(),
                ]);

            log.info(
                `📚 Archive RPC: ${archiveNetwork.name} (chainId: ${archiveNetwork.chainId}), Latest block: ${archiveLatest}`,
            );
            log.info(
                `🏠 Local RPC: ${localNetwork.name} (chainId: ${localNetwork.chainId}), Latest block: ${localLatest}`,
            );

            if (archiveNetwork.chainId !== localNetwork.chainId) {
                log.warn(
                    `⚠️ Chain ID mismatch: Archive=${archiveNetwork.chainId}, Local=${localNetwork.chainId}`,
                );
            }

            const blockDiff = Math.abs(archiveLatest - localLatest);
            if (blockDiff > 5) {
                log.warn(
                    `⚠️ Block height difference: ${blockDiff} blocks between archive and local`,
                );
            }

            log.info("✅ Both RPC connections successful!");
        } catch (error) {
            log.error(
                `❌ Error testing RPC connections: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
        }
    }
}

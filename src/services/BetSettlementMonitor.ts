import { ethers } from "ethers";
import { AppDataSource } from "../config/database";
import { BetPlaced } from "../entities/BetPlaced";
import { BetSettled } from "../entities/BetSettled";
import { log } from "@sayukixbt/log";

export class BetSettlementMonitor {
    private provider: ethers.Provider;
    private contract: ethers.Contract;
    private wallet: ethers.Wallet;
    private intervalId?: NodeJS.Timeout;
    private isRunning: boolean = false;
    private betPlacedRepository = AppDataSource.getRepository(BetPlaced);
    private betSettledRepository = AppDataSource.getRepository(BetSettled);
    private monitoringInterval: number = 10000; // 10 seconds
    private settlementThreshold: number = 100;
    private onManualSettlement?: (settlementData: {
        user: string;
        betIndices: string[];
        transactionHash: string;
        blockNumber: number;
        success: boolean;
    }) => void;

    constructor(
        archiveRpcUrl: string,
        localRpcUrl: string,
        contractAddress: string,
        privateKey: string,
        private rouletteABI: { abi: ethers.InterfaceAbi },
        onManualSettlement?: (settlementData: {
            user: string;
            betIndices: string[];
            transactionHash: string;
            blockNumber: number;
            success: boolean;
        }) => void,
    ) {
        // Use local provider for settlement operations (faster for recent blocks)
        this.provider = new ethers.JsonRpcProvider(localRpcUrl);
        this.wallet = new ethers.Wallet(privateKey, this.provider);
        this.contract = new ethers.Contract(
            contractAddress,
            rouletteABI.abi,
            this.wallet,
        );
        this.onManualSettlement = onManualSettlement;

        log.info(
            `🔍 BetSettlementMonitor initialized for contract: ${contractAddress} using local RPC`,
        );
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            log.warn("🔄 Bet settlement monitor is already running");
            return;
        }

        log.info("🚀 Starting bet settlement monitor...");
        this.isRunning = true;

        // Start the monitoring loop
        this.intervalId = setInterval(async () => {
            await this.checkAndSettleBets();
        }, this.monitoringInterval);

        // Do initial check
        await this.checkAndSettleBets();
    }

    async stop(): Promise<void> {
        if (!this.isRunning) {
            log.warn("⏹️ Bet settlement monitor is not running");
            return;
        }

        log.info("⏹️ Stopping bet settlement monitor...");
        this.isRunning = false;

        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }

    private async checkAndSettleBets(): Promise<void> {
        try {
            const currentBlock = await this.provider.getBlockNumber();
            log.debug(
                `🔗 BetSettlementMonitor using local provider for current block: ${currentBlock}`,
            );

            const expirationBlock = currentBlock - 256; // Blockhash expires after 256 blocks

            // Find users with unsettled bets that are approaching expiration
            const usersWithUnsettledBets = await this.betPlacedRepository
                .createQueryBuilder("bet")
                .leftJoin(
                    "bet_settled",
                    "settled",
                    "settled.user = bet.user AND settled.betIndex = bet.betIndex",
                )
                .where("settled.user IS NULL") // Only unsettled bets
                .andWhere("bet.targetBlock <= :currentBlock", { currentBlock })
                .andWhere("bet.targetBlock > :expirationBlock", {
                    expirationBlock,
                })
                .andWhere("bet.targetBlock <= :settlementThreshold", {
                    settlementThreshold:
                        currentBlock - this.settlementThreshold,
                })
                .select("DISTINCT bet.user", "user")
                .getRawMany();

            if (usersWithUnsettledBets.length > 0) {
                log.info(
                    `🔍 Found ${usersWithUnsettledBets.length} users with bets approaching expiration, attempting to settle...`,
                );

                for (const { user } of usersWithUnsettledBets) {
                    await this.settleUserBets(user, currentBlock);
                }
            }
        } catch (error) {
            log.error(
                "❌ Error checking and settling bets:",
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private async settleUserBets(
        user: string,
        currentBlock: number,
    ): Promise<void> {
        try {
            // Get all unsettled bets for this user
            const unsettledBets = await this.betPlacedRepository
                .createQueryBuilder("bet")
                .leftJoin(
                    "bet_settled",
                    "settled",
                    "settled.user = bet.user AND settled.betIndex = bet.betIndex",
                )
                .where("bet.user = :user", { user })
                .andWhere("settled.user IS NULL") // Only unsettled bets
                .andWhere("bet.targetBlock <= :currentBlock", { currentBlock })
                .orderBy("bet.betIndex", "ASC")
                .getMany();

            if (unsettledBets.length === 0) {
                log.debug(`No unsettled bets found for user ${user}`);
                return;
            }

            const betIndices = unsettledBets.map((bet) => bet.betIndex);
            log.info(
                `🎯 Attempting to settle ${unsettledBets.length} bets for user ${user}: ${betIndices.join(", ")}`,
            );

            // Check if the bets can be settled first (sequentially to avoid batch limits)
            let canSettleAll = true;
            for (const bet of unsettledBets) {
                const canSettle = await this.contract.canSettleBet(
                    bet.user,
                    bet.betIndex,
                );
                if (!canSettle) {
                    log.info(
                        `🔍 Bet ${bet.betIndex} for user ${user} cannot be settled yet`,
                    );
                    canSettleAll = false;
                    break;
                }
            }

            log.info(
                `🔍 Can settle all bets for user ${user}: ${canSettleAll}`,
            );

            if (!canSettleAll) {
                log.warn(`⚠️ Some bets for user ${user} cannot be settled yet`);
                return;
            }

            // Call the settleMultipleBets function on the contract
            const tx = await this.contract.settleMultipleBets(
                user,
                betIndices,
                {
                    gasLimit: 500000, // Higher gas limit for multiple bets
                },
            );

            log.info(`📝 Settlement transaction sent: ${tx.hash}`);

            // Wait for transaction confirmation
            const receipt = await tx.wait();

            log.info(
                `📋 Transaction receipt: status=${receipt.status}, hash=${receipt.hash}, blockNumber=${receipt.blockNumber}, logs=${receipt.logs.length}`,
            );
            log.info(`📋 Receipt object: ${JSON.stringify(receipt, null, 2)}`);

            if (receipt.status === 1) {
                log.info(`✅ All bets for user ${user} settled successfully!`);

                // Update our database to mark all bets as settled
                await this.markSpinAsSettled(unsettledBets, receipt);

                // Trigger manual settlement callback
                if (this.onManualSettlement) {
                    this.onManualSettlement({
                        user,
                        betIndices: betIndices,
                        transactionHash: receipt.hash,
                        blockNumber: receipt.blockNumber,
                        success: true,
                    });
                }
            } else {
                log.error(`❌ Settlement transaction failed for user ${user}`);

                // Trigger manual settlement callback for failed settlement
                if (this.onManualSettlement) {
                    this.onManualSettlement({
                        user,
                        betIndices: betIndices,
                        transactionHash: receipt.hash,
                        blockNumber: receipt.blockNumber,
                        success: false,
                    });
                }
            }
        } catch (error) {
            log.error(
                `❌ Error settling bets for user ${user}:`,
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private async markSpinAsSettled(
        bets: BetPlaced[],
        receipt: ethers.TransactionReceipt,
    ): Promise<void> {
        try {
            // Validate receipt has required fields
            if (!receipt.hash || !receipt.blockNumber) {
                log.error(
                    `❌ Invalid receipt for spin: missing hash or blockNumber`,
                );
                return;
            }

            // Find all BetSettled events in the receipt
            const settlementEvents = receipt.logs.filter((log: ethers.Log) => {
                try {
                    const parsedLog = this.contract.interface.parseLog(log);
                    return parsedLog?.name === "BetSettled";
                } catch {
                    return false;
                }
            });

            log.info(
                `📋 Found ${settlementEvents.length} BetSettled events in receipt`,
            );

            for (const settlementEvent of settlementEvents) {
                const parsedLog =
                    this.contract.interface.parseLog(settlementEvent);
                if (parsedLog) {
                    const [user, betIndex, won, firstHex, secondHex, payout] =
                        parsedLog.args;

                    // Create settlement record
                    const betSettled = new BetSettled();
                    betSettled.user = user;
                    betSettled.betIndex = betIndex.toString();
                    betSettled.won = won;
                    betSettled.firstHex = firstHex.toString();
                    betSettled.secondHex = secondHex.toString();
                    betSettled.payout = payout.toString();
                    betSettled.transactionHash = receipt.hash;
                    betSettled.blockNumber = receipt.blockNumber;

                    await this.betSettledRepository.save(betSettled);
                    log.info(`💾 Settlement record saved for bet ${betIndex}`);
                } else {
                    log.error(`❌ Failed to parse settlement event`);
                }
            }

            if (settlementEvents.length === 0) {
                log.error(`❌ No BetSettled events found in receipt`);
            }
        } catch (error) {
            log.error(
                `❌ Error saving settlement records for spin:`,
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    async getStatus(): Promise<{
        isRunning: boolean;
        lastCheckTime?: Date;
        unsettledBetsCount: number;
        approachingExpirationCount: number;
    }> {
        const currentBlock = await this.provider.getBlockNumber();
        const expirationBlock = currentBlock - 256;

        const [unsettledBetsCount, approachingExpirationCount] =
            await Promise.all([
                this.betPlacedRepository
                    .createQueryBuilder("bet")
                    .leftJoin(
                        "bet_settled",
                        "settled",
                        "settled.user = bet.user AND settled.betIndex = bet.betIndex",
                    )
                    .where("settled.user IS NULL")
                    .andWhere("bet.targetBlock <= :currentBlock", {
                        currentBlock,
                    })
                    .getCount(),

                this.betPlacedRepository
                    .createQueryBuilder("bet")
                    .leftJoin(
                        "bet_settled",
                        "settled",
                        "settled.user = bet.user AND settled.betIndex = bet.betIndex",
                    )
                    .where("settled.user IS NULL")
                    .andWhere("bet.targetBlock <= :currentBlock", {
                        currentBlock,
                    })
                    .andWhere("bet.targetBlock > :expirationBlock", {
                        expirationBlock,
                    })
                    .andWhere("bet.targetBlock <= :settlementThreshold", {
                        settlementThreshold:
                            currentBlock - this.settlementThreshold,
                    })
                    .getCount(),
            ]);

        return {
            isRunning: this.isRunning,
            unsettledBetsCount,
            approachingExpirationCount,
        };
    }
}

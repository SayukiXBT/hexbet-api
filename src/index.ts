import { log } from "@sayukixbt/log";
import { loadEnv } from "./utils/loadEnv";
import express from "express";
import "reflect-metadata";
import { AppDataSource } from "./config/database";
import { EventIndexer } from "./services/EventIndexer";
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
        log.error(
            "Error connecting to database:",
            error instanceof Error ? error.message : String(error),
        );
        process.exit(1);
    }

    // Initialize event indexer if RPC URL is provided
    let eventIndexer: EventIndexer | null = null;
    let continuousIndexer: ContinuousIndexer | null = null;

    if (process.env.RPC_URL) {
        log.info(`RPC_URL: ${process.env.RPC_URL}`);
        log.info(`ROULETTE_ADDRESS constant: ${ROULETTE_ADDRESS}`);
        log.info(
            `CONTRACT_ADDRESS env var: ${process.env.CONTRACT_ADDRESS || "not set"}`,
        );

        // Use environment variable only if it's not the zero address
        const envContractAddress = process.env.CONTRACT_ADDRESS;
        const contractAddress =
            envContractAddress &&
            envContractAddress !== "0x0000000000000000000000000000000000000000"
                ? envContractAddress
                : ROULETTE_ADDRESS;

        log.info(`Using contract address: ${contractAddress}`);

        eventIndexer = new EventIndexer(process.env.RPC_URL, contractAddress);
        continuousIndexer = new ContinuousIndexer(eventIndexer);
        log.info(
            `Event indexer and continuous indexer initialized for contract: ${contractAddress}`,
        );
    } else {
        log.warn("RPC_URL not provided - event indexing will be disabled");
    }

    // Middleware
    app.use(express.json());

    // Start continuous indexer automatically
    if (continuousIndexer) {
        log.info("🚀 Starting continuous indexer automatically...");
        continuousIndexer.start().catch((error) => {
            log.error(
                "Failed to start continuous indexer:",
                error instanceof Error ? error.message : String(error),
            );
        });
    }

    // Status endpoint
    app.get("/status", (req, res) => {
        res.status(200).json({ status: "OK", message: "Server is running" });
    });

    // Continuous indexer status endpoint
    app.get("/indexer/status", async (req, res) => {
        if (!continuousIndexer) {
            res.status(400).json({
                error: "Continuous indexer not configured",
            });
            return;
        }

        try {
            const status = await continuousIndexer.getStatus();
            res.json(status);
        } catch (error) {
            log.error(
                "Error getting indexer status:",
                error instanceof Error ? error.message : String(error),
            );
            res.status(500).json({ error: "Failed to get indexer status" });
        }
    });

    // Start the server
    app.listen(PORT, () => {
        log.info(`🚀 Server is running on port ${PORT}`);
        log.info(`📊 Health check: http://localhost:${PORT}/status`);
        log.info(`📊 Indexer status: http://localhost:${PORT}/indexer/status`);
    });
}

// Handle graceful shutdown
process.on("SIGINT", async () => {
    log.info("🛑 Received SIGINT, shutting down gracefully...");
    process.exit(0);
});

process.on("SIGTERM", async () => {
    log.info("🛑 Received SIGTERM, shutting down gracefully...");
    process.exit(0);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
    log.error("Unhandled Rejection at:", String(promise), "reason:", String(reason));
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
    log.error("Uncaught Exception:", error);
    process.exit(1);
});

main().catch((error) => {
    log.error("Failed to start server:", error);
    process.exit(1);
});

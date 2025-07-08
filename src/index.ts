import { log } from "@sayukixbt/log";
import { loadEnv } from "./utils/loadEnv";
import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import "reflect-metadata";
import { AppDataSource } from "./config/database";
import { EventIndexer } from "./services/EventIndexer";
import { ContinuousIndexer } from "./services/ContinuousIndexer";
import { BetSettlementMonitor } from "./services/BetSettlementMonitor";
import { ROULETTE_ADDRESS } from "./constants/blockchain";
import { Spin } from "./entities/Spin";
import rouletteABI from "./abi/Roulette.json";

// load the environment variables
loadEnv();

async function main() {
    const app = express();
    const server = createServer(app);
    const io = new SocketIOServer(server, {
        cors: {
            origin: true, // Allow all origins but handle properly
            methods: ["GET", "POST", "OPTIONS"],
            credentials: false,
        },
    });
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

    // Function to broadcast new spins to subscribed clients
    const broadcastNewSpin = (spin: Spin) => {
        const roomName = `spins:${spin.user.toLowerCase()}`;
        io.to(roomName).emit("new:spin", {
            address: spin.user.toLowerCase(),
            spin: spin,
        });
        log.info(`📡 Broadcasted new spin to room: ${roomName}`);
    };

    // Function to broadcast spin updates to subscribed clients
    const broadcastSpinUpdate = (spin: Spin) => {
        const roomName = `spins:${spin.user.toLowerCase()}`;
        io.to(roomName).emit("spin:updated", {
            address: spin.user.toLowerCase(),
            spin: spin,
        });
        log.info(`📡 Broadcasted spin update to room: ${roomName}`);
    };

    // Initialize event indexer if RPC URL is provided
    let eventIndexer: EventIndexer | null = null;
    let continuousIndexer: ContinuousIndexer | null = null;
    let betSettlementMonitor: BetSettlementMonitor | null = null;

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

        eventIndexer = new EventIndexer(
            process.env.RPC_URL,
            contractAddress,
            broadcastNewSpin,
            broadcastSpinUpdate,
        );
        continuousIndexer = new ContinuousIndexer(eventIndexer);
        log.info(
            `Event indexer and continuous indexer initialized for contract: ${contractAddress}`,
        );

        // Initialize bet settlement monitor if private key is provided
        if (process.env.PRIVATE_KEY) {
            betSettlementMonitor = new BetSettlementMonitor(
                process.env.RPC_URL,
                contractAddress,
                process.env.PRIVATE_KEY,
                rouletteABI,
            );
            log.info("Bet settlement monitor initialized");
        } else {
            log.warn(
                "PRIVATE_KEY not provided - bet settlement monitoring will be disabled",
            );
        }
    } else {
        log.warn("RPC_URL not provided - event indexing will be disabled");
    }

    // Middleware
    app.use(cors({
        origin: true, // Allow all origins
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        credentials: false,
    }));
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

    // Start bet settlement monitor automatically
    if (betSettlementMonitor) {
        log.info("🚀 Starting bet settlement monitor automatically...");
        betSettlementMonitor.start().catch((error) => {
            log.error(
                "Failed to start bet settlement monitor:",
                error instanceof Error ? error.message : String(error),
            );
        });
    }

    // WebSocket connection handling
    io.on("connection", (socket) => {
        log.info(`🔌 WebSocket client connected: ${socket.id}`);

        // Handle subscription to user spins
        socket.on("subscribe:spins", (data: { address: string }) => {
            const { address } = data;

            if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
                socket.emit("error", { message: "Invalid address format" });
                return;
            }

            const roomName = `spins:${address.toLowerCase()}`;
            socket.join(roomName);
            log.info(
                `📡 Client ${socket.id} subscribed to spins for ${address}`,
            );

            socket.emit("subscribed", {
                address: address.toLowerCase(),
                room: roomName,
            });
        });

        // Handle unsubscription
        socket.on("unsubscribe:spins", (data: { address: string }) => {
            const { address } = data;
            const roomName = `spins:${address.toLowerCase()}`;
            socket.leave(roomName);
            log.info(
                `📡 Client ${socket.id} unsubscribed from spins for ${address}`,
            );
        });

        // Handle disconnect
        socket.on("disconnect", () => {
            log.info(`🔌 WebSocket client disconnected: ${socket.id}`);
        });
    });

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

    // Bet settlement monitor status endpoint
    app.get("/settlement/status", async (req, res) => {
        if (!betSettlementMonitor) {
            res.status(400).json({
                error: "Bet settlement monitor not configured",
            });
            return;
        }

        try {
            const status = await betSettlementMonitor.getStatus();
            res.json(status);
        } catch (error) {
            log.error(
                "Error getting settlement monitor status:",
                error instanceof Error ? error.message : String(error),
            );
            res.status(500).json({
                error: "Failed to get settlement monitor status",
            });
        }
    });

    // Get all spins for a specific address
    app.get("/spins/:address", async (req, res) => {
        try {
            const { address } = req.params;
            const { offset = "0", limit = "50" } = req.query;

            // Validate address format
            if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
                res.status(400).json({ error: "Invalid address format" });
                return;
            }

            // Validate pagination parameters
            const offsetNum = parseInt(offset as string);
            const limitNum = parseInt(limit as string);

            if (isNaN(offsetNum) || offsetNum < 0) {
                res.status(400).json({ error: "Invalid offset parameter" });
                return;
            }

            if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
                res.status(400).json({
                    error: "Invalid limit parameter (must be between 1 and 100)",
                });
                return;
            }

            const spinRepository = AppDataSource.getRepository(Spin);

            // Get total count for pagination info
            const totalCount = await spinRepository
                .createQueryBuilder("spin")
                .where("LOWER(spin.user) = LOWER(:address)", { address })
                .getCount();

            // Use case-insensitive query with pagination
            const spins = await spinRepository
                .createQueryBuilder("spin")
                .where("LOWER(spin.user) = LOWER(:address)", { address })
                .orderBy("spin.createdAt", "DESC")
                .offset(offsetNum)
                .limit(limitNum)
                .getMany();

            res.json({
                address: address.toLowerCase(),
                pagination: {
                    offset: offsetNum,
                    limit: limitNum,
                    total: totalCount,
                    hasMore: offsetNum + limitNum < totalCount,
                },
                spins: spins,
            });
        } catch (error) {
            log.error(
                "Error getting spins for address:",
                error instanceof Error ? error.message : String(error),
            );
            res.status(500).json({ error: "Failed to get spins" });
        }
    });

    // Start the server
    server.listen(PORT, () => {
        log.info(`🚀 Server is running on port ${PORT}`);
        log.info(`📊 Health check: http://localhost:${PORT}/status`);
        log.info(`📊 Indexer status: http://localhost:${PORT}/indexer/status`);
        log.info(`🔌 WebSocket server ready on ws://localhost:${PORT}`);
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
    log.error(
        "Unhandled Rejection at:",
        String(promise),
        "reason:",
        String(reason),
    );
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

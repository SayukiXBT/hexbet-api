#!/usr/bin/env node

const sqlite3 = require("sqlite3").verbose();
const readline = require("readline");
const path = require("path");

// Get database path from environment or use default
const dbPath = process.env.DB_PATH || "./hexbet.db";
const fullDbPath = path.resolve(dbPath);

async function dropRecordsAfterBlock(blockNumber) {
    return new Promise((resolve, reject) => {
        console.log(`🗑️  Dropping all records after block ${blockNumber}...`);
        console.log(`📁 Using database: ${fullDbPath}`);

        // Open database
        const db = new sqlite3.Database(fullDbPath, (err) => {
            if (err) {
                console.error("❌ Error opening database:", err.message);
                reject(err);
                return;
            }
            console.log("✅ Database connection established");
        });

        // Enable foreign keys and WAL mode for better performance
        db.serialize(() => {
            db.run("PRAGMA foreign_keys = ON");
            db.run("PRAGMA journal_mode = WAL");

            console.log("🗑️  Deleting records...");

            // Delete records from all tables
            const deleteQueries = [
                {
                    name: "BetPlaced events",
                    query: "DELETE FROM bet_placed WHERE blockNumber > ?",
                    params: [blockNumber],
                },
                {
                    name: "BetSettled events",
                    query: "DELETE FROM bet_settled WHERE blockNumber > ?",
                    params: [blockNumber],
                },
                {
                    name: "BetExpired events",
                    query: "DELETE FROM bet_expired WHERE blockNumber > ?",
                    params: [blockNumber],
                },
                {
                    name: "WinningsClaimed events",
                    query: "DELETE FROM winnings_claimed WHERE blockNumber > ?",
                    params: [blockNumber],
                },
                {
                    name: "Spins",
                    query: "DELETE FROM spin WHERE CAST(targetBlock AS INTEGER) > ?",
                    params: [blockNumber - 10],
                },
            ];

            let completedQueries = 0;
            const results = [];

            deleteQueries.forEach(({ name, query, params }) => {
                db.run(query, params, function (err) {
                    if (err) {
                        console.error(
                            `❌ Error deleting ${name}:`,
                            err.message,
                        );
                        reject(err);
                        return;
                    }

                    results.push({ name, deleted: this.changes });
                    console.log(`   - ${name}: ${this.changes}`);

                    completedQueries++;

                    if (completedQueries === deleteQueries.length) {
                        // Update indexing state
                        db.run(
                            "INSERT OR REPLACE INTO indexing_state (id, last_indexed_block, last_updated) VALUES (1, ?, CURRENT_TIMESTAMP)",
                            [blockNumber],
                            function (err) {
                                if (err) {
                                    console.error(
                                        "❌ Error updating indexing state:",
                                        err.message,
                                    );
                                    reject(err);
                                    return;
                                }

                                const totalDeleted = results.reduce(
                                    (sum, r) => sum + r.deleted,
                                    0,
                                );

                                console.log("\n📊 Deletion Results:");
                                results.forEach((r) => {
                                    console.log(`   - ${r.name}: ${r.deleted}`);
                                });

                                console.log(
                                    `\n✅ Successfully deleted ${totalDeleted} total records after block ${blockNumber}`,
                                );
                                console.log(
                                    `💾 Updated indexing state to block ${blockNumber}`,
                                );

                                // Close database
                                db.close((err) => {
                                    if (err) {
                                        console.error(
                                            "❌ Error closing database:",
                                            err.message,
                                        );
                                        reject(err);
                                        return;
                                    }
                                    console.log(
                                        "🔌 Database connection closed",
                                    );
                                    resolve();
                                });
                            },
                        );
                    }
                });
            });
        });
    });
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length !== 1) {
    console.log("Usage: node scripts/drop-records.js <blockNumber>");
    console.log("Example: node scripts/drop-records.js 26400000");
    process.exit(1);
}

const blockNumber = parseInt(args[0]);

if (isNaN(blockNumber) || blockNumber < 0) {
    console.error("❌ Invalid block number. Must be a positive integer.");
    process.exit(1);
}

// Confirm before proceeding
console.log(`⚠️  This will delete ALL records after block ${blockNumber}`);
console.log("⚠️  This action cannot be undone!");
console.log("⚠️  Make sure the server is stopped before running this utility.");
console.log("");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

rl.question("Are you sure you want to continue? (yes/no): ", (answer) => {
    if (answer.toLowerCase() === "yes" || answer.toLowerCase() === "y") {
        rl.close();
        dropRecordsAfterBlock(blockNumber)
            .then(() => {
                console.log("🎉 Operation completed successfully!");
                process.exit(0);
            })
            .catch((error) => {
                console.error("❌ Operation failed:", error.message);
                process.exit(1);
            });
    } else {
        console.log("❌ Operation cancelled");
        rl.close();
        process.exit(0);
    }
});

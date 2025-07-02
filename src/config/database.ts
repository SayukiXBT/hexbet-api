import { DataSource } from "typeorm";
import { BetPlaced } from "../entities/BetPlaced";
import { BetSettled } from "../entities/BetSettled";
import { BetExpired } from "../entities/BetExpired";
import { WinningsClaimed } from "../entities/WinningsClaimed";

export const AppDataSource = new DataSource({
    type: "sqlite",
    database: process.env.DB_PATH || "./hexbet.db",
    synchronize: true, // Be careful with this in production
    logging: process.env.NODE_ENV === "development",
    entities: [BetPlaced, BetSettled, BetExpired, WinningsClaimed],
    subscribers: [],
    migrations: [],
}); 
import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    Index,
} from "typeorm";

@Entity("bet_settled")
@Index(["user", "betIndex"])
export class BetSettled {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "varchar", length: 42 })
    user!: string; // Ethereum address

    @Column({ type: "bigint" })
    betIndex!: string; // uint256 as string

    @Column({ type: "boolean" })
    won!: boolean;

    @Column({ type: "varchar", length: 20 })
    firstHex!: string; // uint8 as string

    @Column({ type: "varchar", length: 20 })
    secondHex!: string; // uint8 as string

    @Column({ type: "varchar", length: 78 })
    payout!: string; // uint256 as string

    @Column({ type: "varchar", length: 66 })
    transactionHash!: string; // Transaction hash

    @Column({ type: "int" })
    blockNumber!: number;

    @CreateDateColumn()
    createdAt!: Date;
}

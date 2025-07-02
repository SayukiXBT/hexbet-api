import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

@Entity("bet_placed")
@Index(["user", "betIndex"])
@Index(["targetBlock"])
export class BetPlaced {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "varchar", length: 42 })
    user!: string; // Ethereum address

    @Column({ type: "bigint" })
    betIndex!: string; // uint256 as string

    @Column({ type: "varchar", length: 20 })
    guess!: string; // uint8 as string

    @Column({ type: "varchar", length: 78 })
    wager!: string; // uint256 as string

    @Column({ type: "bigint" })
    targetBlock!: string; // uint256 as string

    @Column({ type: "varchar", length: 66 })
    transactionHash!: string; // Transaction hash

    @Column({ type: "int" })
    blockNumber!: number;

    @CreateDateColumn()
    createdAt!: Date;
} 
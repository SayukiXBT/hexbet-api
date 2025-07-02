import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    Index,
} from "typeorm";

@Entity("bet_expired")
@Index(["betId"])
@Index(["user"])
export class BetExpired {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "bigint" })
    betId!: string; // uint256 as string

    @Column({ type: "varchar", length: 42 })
    user!: string; // Ethereum address

    @Column({ type: "varchar", length: 78 })
    amount!: string; // uint256 as string

    @Column({ type: "varchar", length: 20 })
    betType!: string; // uint8 as string

    @Column({ type: "varchar", length: 66 })
    transactionHash!: string; // Transaction hash

    @Column({ type: "int" })
    blockNumber!: number;

    @CreateDateColumn()
    createdAt!: Date;
}

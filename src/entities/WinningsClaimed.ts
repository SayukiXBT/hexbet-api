import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    Index,
} from "typeorm";

@Entity("winnings_claimed")
@Index(["user"])
export class WinningsClaimed {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "varchar", length: 42 })
    user!: string; // Ethereum address

    @Column({ type: "varchar", length: 78 })
    amount!: string; // uint256 as string

    @Column({ type: "varchar", length: 66 })
    transactionHash!: string; // Transaction hash

    @Column({ type: "int" })
    blockNumber!: number;

    @CreateDateColumn()
    createdAt!: Date;
}

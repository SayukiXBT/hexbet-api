import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

@Entity()
@Index(["user", "targetBlock"], { unique: true })
export class Spin {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "varchar", length: 42 })
    user!: string; // address

    @Column({ type: "varchar", length: 78 })
    targetBlock!: string; // uint256 as string

    @Column({ type: "varchar", length: 78 })
    totalWager!: string; // uint256 as string - sum of all wagers

    @Column({ type: "simple-array" })
    betIndexes!: string[]; // array of bet indexes for this spin

    @Column({ type: "simple-array" })
    guesses!: string[]; // array of guesses (uint8 as string)

    @Column({ type: "simple-array" })
    wagers!: string[]; // array of individual wagers (uint256 as string)

    @Column({ type: "boolean", default: false })
    isSettled!: boolean; // whether this spin has been settled

    @Column({ type: "boolean", nullable: true })
    won!: boolean | null; // true if any bet in the spin won

    @Column({ type: "varchar", length: 20, nullable: true })
    firstHex!: string | null; // uint8 as string

    @Column({ type: "varchar", length: 20, nullable: true })
    secondHex!: string | null; // uint8 as string

    @Column({ type: "varchar", length: 78, nullable: true })
    totalPayout!: string | null; // uint256 as string - total payout for the spin

    @Column({ type: "varchar", length: 66, nullable: true })
    settlementTransactionHash!: string | null;

    @Column({ type: "integer", nullable: true })
    settlementBlockNumber!: number | null;

    @Column({ type: "datetime", default: () => "CURRENT_TIMESTAMP" })
    createdAt!: Date;

    @Column({ type: "datetime", default: () => "CURRENT_TIMESTAMP" })
    updatedAt!: Date;
}
